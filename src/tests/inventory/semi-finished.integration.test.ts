// Requires an empty, disposable localhost PostgreSQL database. Never runs on the ERP database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';
import { ProductService } from '../../modules/product/product.service';
import { SemiFinishedService } from '../../modules/inventory/semi-finished.service';
import { ExpiryTrackingService } from '../../modules/inventory/expiry-tracking.service';
import { readPricing } from '../../modules/sales/sku-price-fields';
process.env.PRODUCTION_QC_ENABLED = 'false';
process.env.PRODUCTION_LABELS_ENABLED = 'false';
const admin = { role: 'SUPER_ADMIN' };
test('manufactured and purchased bulk share live lots through Stock Hub and Packaging', { timeout: 180000 }, async t => {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(process.env.KIDDOS_SEMI_TEST_DB, '1'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/kiddos_semi_finished_test');
  try {
    assert.equal(await prisma.inventoryItem.count(), 0, 'Requires a fresh disposable database');
    const hq = await prisma.franchise.create({ data: { name: 'Test HQ', location: 'Test', ownerName: 'Test', contactNum: '0', isHQ: true } });
    const branch = await prisma.franchise.create({ data: { name: 'Test Branch', location: 'Test', ownerName: 'Test', contactNum: '1' } });
    const wa = await prisma.warehouse.create({ data: { name: 'Warehouse A', nameKey: 'warehouse-a' } });
    const wb = await prisma.warehouse.create({ data: { name: 'Warehouse B', nameKey: 'warehouse-b' } });
    const raw = await prisma.inventoryItem.create({ data: { name: 'Rice', sku: 'RM-RICE', category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, costPrice: 40 } });
    await prisma.$transaction(tx => InventoryService.recordMovement(tx, { itemId: raw.id, type: 'PURCHASE_IN', quantity: 50, warehouseId: wa.id, receiveAtCost: { unitCost: 40, batchNumber: 'RICE-A' } }));
    const recipe = await prisma.recipe.create({ data: { name: 'Manufactured Blend', recipeCode: 'RCP-BLEND', category: 'Test', yieldQty: 10, yieldUnit: 'KG', recipeItems: { create: [{ inventoryItemId: raw.id, quantityRequired: 10, unit: 'KG' }] } } });
    const mix500 = await ProductService.create({ name: 'Manufactured Blend 500g', sku: 'FG-BLEND-500G', basePrice: 100, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', taxPercent: 5 });
    const appam500 = await ProductService.create({ name: 'APPAM 500g', sku: 'FG-APPA-500G', basePrice: 100, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', taxPercent: 5 });
    const appam250 = await ProductService.create({ name: 'APPAM 250g', sku: 'FG-APPA-250G', basePrice: 60, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', taxPercent: 5 });
    const fgItem = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: appam500.sku! } });
    await prisma.inventoryItem.update({ where: { id: fgItem.id }, data: { customerPrice: 100, dealerPrice: 80, franchisePrice: 70, upcountryFranchisePrice: 75, mrp: 120, whiteLabelCost: 55 } });
    const prices = readPricing(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fgItem.id } }));
    const produce = async (warehouseId: string, kg = 10) => {
      const production = await ProductionService.startProduction({ recipeId: recipe.id, quantity: kg / 10, franchiseId: hq.id, warehouseId, productionType: 'FINISHED_GOOD' });
      return (await ProductionService.approveProduction(production.id, undefined, kg)).batch;
    };
    const list = async (filters = {}) => SemiFinishedService.list(filters, admin);
    const rowFor = async (batchId: string) => (await list()).rows.find(r => r.productBatchId === batchId)!;
    const manufactured = await produce(wa.id);
    await t.test('production completion posts one visible bulk lot and partial packaging updates both stock categories', async () => {
      const row = await rowFor(manufactured.id); assert.ok(row); assert.equal(row.availableQty, 10); assert.equal(row.unitCost, 40);
      const result = await ProductionService.packageAndConfirm({ batchId: manufactured.id, bulkLotId: row.id, packetSize: '500g', packedQty: 4, damagedQty: 0, productId: mix500.id, expectedPackagedQty: 0 });
      assert.equal((await rowFor(manufactured.id)).remainingQty, 8); assert.equal((await rowFor(manufactured.id)).packagedQty, 2);
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: result.retailItem.id } })).currentStock, 4);
      assert.equal((await prisma.inventoryBatch.findFirstOrThrow({ where: { productPackagingId: result.packaging.id } })).unitCost, 20);
    });
    await t.test('two-phase reservations reduce availability; cancellation restores the same physical lot', async () => {
      const row = await rowFor(manufactured.id);
      const ticket = await ProductionService.startPackaging({ batchId: manufactured.id, bulkLotId: row.id, packetSize: '500g', quantityPackets: 2, productId: mix500.id });
      assert.equal((await rowFor(manufactured.id)).remainingQty, 7);
      await ProductionService.cancelPackaging({ packagingId: ticket.packaging.id });
      assert.equal((await rowFor(manufactured.id)).remainingQty, 8);
      assert.equal((await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: row.id } })).currentQty, 8);
    });
    await t.test('duplicate confirmation never posts packaged stock twice', async () => {
      const row = await rowFor(manufactured.id);
      const ticket = await ProductionService.startPackaging({ batchId: manufactured.id, bulkLotId: row.id, packetSize: '500g', quantityPackets: 2, productId: mix500.id });
      const request = { packagingId: ticket.packaging.id, goodQty: 2, damagedQty: 0, spoiledQty: 0, productId: mix500.id };
      const outcomes = await Promise.allSettled([ProductionService.confirmPackaging(request), ProductionService.confirmPackaging(request)]);
      assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await rowFor(manufactured.id)).remainingQty, 7);
      assert.equal(await prisma.inventoryBatch.count({ where: { productPackagingId: ticket.packaging.id } }), 1);
    });
    await t.test('same-family warehouse and batch lots never consume each other', async () => {
      await prisma.$transaction(tx => InventoryService.recordMovement(tx, { itemId: raw.id, type: 'PURCHASE_IN', quantity: 5, warehouseId: wb.id, receiveAtCost: { unitCost: 60, batchNumber: 'RICE-B' } }));
      const otherBatch = await produce(wb.id, 5); const otherRow = await rowFor(otherBatch.id); const original = await rowFor(manufactured.id);
      await assert.rejects(() => ProductionService.packageAndConfirm({ batchId: otherBatch.id, bulkLotId: original.id, packetSize: '500g', packedQty: 2, damagedQty: 0, productId: mix500.id, expectedPackagedQty: 0 }), /source|selected|insufficient/i);
      const result = await ProductionService.packageAndConfirm({ batchId: otherBatch.id, bulkLotId: otherRow.id, packetSize: '500g', packedQty: 2, damagedQty: 0, productId: mix500.id, expectedPackagedQty: 0 });
      assert.equal((await rowFor(otherBatch.id)).remainingQty, 4); assert.equal((await rowFor(manufactured.id)).remainingQty, 7);
      const finished = await prisma.inventoryBatch.findFirstOrThrow({ where: { productPackagingId: result.packaging.id } });
      assert.equal(finished.warehouseId, wb.id); assert.equal(finished.unitCost, 30);
      assert.ok((await list({ warehouseId: wb.id })).rows.every(r => r.warehouse?.id === wb.id));
    });
    const vendor = await prisma.vendor.create({ data: { name: 'Supplier', contact: '0', state: 'Kerala' } });
    const bulk = await prisma.inventoryItem.create({ data: { name: 'APPAM - Bulk', sku: 'APPAM-BULK', category: 'SEMI_FINISHED', unit: 'KG', currentStock: 0 } });
    const po = await ProcurementService.createPurchaseOrder({ vendorId: vendor.id, franchiseId: hq.id, warehouseId: wa.id, purchaseType: 'FINISHED_GOODS', expectedDeliveryDate: new Date(Date.now() + 86400000).toISOString(), items: [{ inventoryItemId: bulk.id, productId: appam500.id, isBulk: true, quantity: 20000, price: 0.1, unit: 'G', gstRate: 5 }] });
    const expiry = new Date(Date.now() + 15 * 86400000).toISOString();
    const grn = await GRNService.createFromPO(po.id, { receivedBy: 'Test', items: [{ materialId: bulk.id, orderedQty: 20000, receivedQty: 20000, acceptedQty: 20000, rejectedQty: 0, price: 0.1, warehouseId: wa.id, expDate: expiry }] });
    await GRNService.approve(grn.id, { role: 'SUPER_ADMIN' });
    const purchased = await prisma.productBatch.findFirstOrThrow({ where: { goodsReceiptId: grn.id } });
    await t.test('bulk GRN appears without a recipe alongside manufactured stock, preserving supplier and receipt references', async () => {
      const row = await rowFor(purchased.id); assert.ok(row); assert.equal(row.sourceType, 'PURCHASE'); assert.equal(row.remainingQty, 20);
      assert.equal(row.unitCost, 100); assert.equal(row.goodsReceiptId, grn.id); assert.equal(row.purchaseOrderId, po.id); assert.equal(row.supplier, 'Supplier');
      assert.equal(purchased.productionId, null); const all = await list(); assert.ok(all.rows.some(r => r.sourceType === 'MANUFACTURED'));
      assert.ok((await list({ sourceType: 'PURCHASE', search: 'APPAM' })).rows.every(r => r.sourceType === 'PURCHASE'));
      const branchView = await SemiFinishedService.list({}, { role: 'FRANCHISE_ADMIN', franchiseId: branch.id }); assert.equal(branchView.rows.length, 0);
    });
    await t.test('20 KG purchase -> 5 KG + 4 KG packaging -> 11 KG; retry-safe stock and valuation transfer', async () => {
      const row = await rowFor(purchased.id);
      const first = await ProductionService.packageAndConfirm({ batchId: purchased.id, bulkLotId: row.id, packetSize: '500g', packedQty: 10, damagedQty: 0, productId: appam500.id, expectedPackagedQty: 0 });
      assert.equal((await rowFor(purchased.id)).remainingQty, 15);
      const request = { batchId: purchased.id, bulkLotId: row.id, packetSize: '250g', packedQty: 16, damagedQty: 0, productId: appam250.id, expectedPackagedQty: 5 };
      const outcomes = await Promise.allSettled([ProductionService.packageAndConfirm(request), ProductionService.packageAndConfirm(request)]);
      assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
      const after = await rowFor(purchased.id); assert.equal(after.remainingQty, 11); assert.equal(after.packagedQty, 9); assert.equal(after.remainingValue, 1100);
      const tickets = await prisma.productPackaging.findMany({ where: { batchId: purchased.id, status: 'CONFIRMED' } });
      const finished = await prisma.inventoryBatch.findMany({ where: { productPackagingId: { in: tickets.map(p => p.id) } } });
      assert.equal(after.remainingValue! + finished.reduce((s, l) => s + l.currentQty * l.unitCost!, 0), 2000);
      assert.ok(finished.every(l => l.expDate!.getTime() <= new Date(expiry).getTime()));
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: first.retailItem.id } })).currentStock, 10);
      assert.deepEqual(readPricing(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fgItem.id } })), prices);
      assert.equal(new URL(after.packagingUrl!, 'http://test').searchParams.get('bulkLotId'), row.id);
    });
    await t.test('expiry tracking and packaging share the same restrictions, including approved batches', async () => {
      const yesterday = new Date(Date.now() - 86400000);
      await prisma.productBatch.update({ where: { id: purchased.id }, data: { expiryDate: yesterday } });
      const row = await rowFor(purchased.id); assert.equal(row.status, 'EXPIRED'); assert.equal(row.availableQty, 0);
      await assert.rejects(() => ProductionService.packageAndConfirm({ batchId: purchased.id, bulkLotId: row.id, packetSize: '500g', packedQty: 1, damagedQty: 0, productId: appam500.id, expectedPackagedQty: 9 }), /expired/i);
      const tracking = await ExpiryTrackingService.list({ view: 'FINISHED' }, admin);
      const expired = tracking.rows.find((r: any) => r.id === row.id); assert.equal(expired?.expiryStatus, 'EXPIRED');
      assert.equal((await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: row.id } })).currentQty, 11);
    });
  } finally { await prisma.$disconnect(); }
});
