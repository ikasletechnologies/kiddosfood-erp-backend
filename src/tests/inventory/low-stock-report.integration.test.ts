import assert from 'node:assert/strict';
import prisma from '../../lib/prisma';
import { withRollback } from '../with-rollback';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FinishedGoodsLowStockService, FINISHED_GOODS_LOW_STOCK_KEY } from '../../modules/settings/finished-goods-low-stock';

async function main() {
  const tag = `LOW-REPORT-${Date.now()}`;
  await withRollback(async (tx) => {
    const ids: string[] = [];
    for (const qty of [0, 1, 2, 3, 5, 6]) {
      const item = await tx.inventoryItem.create({
        data: {
          name: `${tag}-${qty}`,
          sku: `${tag}-${qty}`,
          category: 'FINISHED_GOOD',
          unit: 'PC',
          currentStock: 999,
          minimumStock: 99
        }
      });
      ids.push(item.id);
      await tx.stockMovement.create({
        data: {
          itemId: item.id,
          movementType: 'ADJUSTMENT',
          quantity: qty,
          baseQty: qty
        }
      });
    }
    const raw = await tx.inventoryItem.create({
      data: {
        name: `${tag}-Aval`,
        sku: `${tag}-RAW`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        minimumStock: 10,
        currentStock: 8
      }
    });
    const semi = await tx.inventoryItem.create({
      data: {
        name: `${tag}-Bulk`,
        sku: `${tag}-SEMI`,
        category: 'SEMI_FINISHED',
        unit: 'KG',
        minimumStock: 5,
        currentStock: 4
      }
    });
    const rawAtMin = await tx.inventoryItem.create({
      data: {
        name: `${tag}-RawAtMin`,
        sku: `${tag}-RAW-MIN`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        minimumStock: 10,
        currentStock: 10
      }
    });
    const own = (rows: any[]) => rows.filter(r => r.name.startsWith(tag));
    for (const threshold of [5, 2, 0]) {
      await FinishedGoodsLowStockService.set(threshold);
      assert.equal((await FinishedGoodsLowStockService.get()).finishedGoodsLowStockThreshold, threshold);
      assert.equal(await FinishedGoodsLowStockService.threshold(), threshold, 'Fresh DB read must retain the saved setting');
      assert.equal(await tx.systemSetting.count({ where: { key: FINISHED_GOODS_LOW_STOCK_KEY } }), 1);
      const hub = own(await InventoryService.getInventory(undefined));
      const rows = own(await InventoryService.getAlerts());
      const fg = rows.filter(r => r.category === 'FINISHED_GOOD');
      assert.deepEqual(fg.map(r => r.currentStock).sort((a: number, b: number) => a - b), [0, 1, 2, 3, 5, 6].filter(q => q === 0 || q <= threshold));
      for (const row of fg) {
        assert.equal(row.minimumStock, threshold);
        assert.equal(row.shortfall, Math.max(0, threshold - row.currentStock));
        assert.equal(row.stockStatus, row.currentStock === 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK');
        assert.equal(hub.find((i: any) => i.id === row.id).stockStatus, row.stockStatus);
        assert.equal(row.itemMinimumStock, 99);
      }
      assert.equal(rows.find(r => r.id === raw.id).minimumStock, 10);
      assert.equal(rows.find(r => r.id === semi.id).minimumStock, 5);
      assert.equal(rows.find(r => r.id === raw.id).unit, 'KG');
      assert.equal(rows.find(r => r.id === semi.id).shortfall, 1);
      assert.ok(!rows.some(r => r.id === rawAtMin.id), 'Preserve raw-material strict-below rule');
      assert.equal(own(await InventoryService.getAlerts(undefined, { category: 'FINISHED_GOOD' })).length, fg.length);
      assert.equal(rows.length, fg.length + 2);
    }
    assert.deepEqual(
      (await tx.inventoryItem.findMany({ where: { id: { in: ids } }, orderBy: { name: 'asc' } })).map((r: any) => [r.currentStock, r.minimumStock]),
      ids.map(() => [999, 99])
    );
    for (const invalid of [-1, 1.5, '2', null]) {
      await assert.rejects(() => FinishedGoodsLowStockService.set(invalid));
    }
    assert.equal((await tx.inventoryItem.findUniqueOrThrow({ where: { id: raw.id } })).minimumStock, 10);
    assert.equal((await tx.inventoryItem.findUniqueOrThrow({ where: { id: semi.id } })).minimumStock, 5);
  });
  assert.equal(await prisma.inventoryItem.count({ where: { name: { startsWith: tag } } }), 0);
  console.log('PASS: thresholds 5 -> 2 -> 0, equality/zero status, ledger stock, category scope, persisted setting, raw/semi KG minima unchanged; all fixtures rolled back');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
