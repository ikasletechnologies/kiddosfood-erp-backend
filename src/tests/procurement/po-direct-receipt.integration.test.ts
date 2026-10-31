import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';
import { isPOReceiptEligible, savedPOStatus } from '../../modules/procurement/po-receipt-status';
import { purchaseBusinessDate } from '../../modules/procurement/purchase-dates';

// Run the real services inside ONE outer transaction. Route all singleton calls
// (including nested service transactions) into it, and roll back every fixture.
async function main() {
  for (const status of ['APPROVED', 'PENDING_APPROVAL', 'SENT', 'ORDERED', 'PARTIALLY_RECEIVED']) assert.equal(isPOReceiptEligible(status), true);
  for (const status of ['DRAFT', 'CANCELLED', 'CLOSED', 'RECEIVED', 'INVOICED', 'PAID']) assert.equal(isPOReceiptEligible(status), false);
  assert.equal(savedPOStatus(), 'APPROVED'); assert.equal(savedPOStatus('PENDING_APPROVAL'), 'APPROVED'); assert.equal(savedPOStatus('DRAFT'), 'DRAFT');
  const originalTransaction = prisma.$transaction.bind(prisma);
  const rollback = new Error('ROLLBACK_FIXTURES');
  const tag = `DIRECT-PO-${Date.now()}`;
  try {
    await originalTransaction(async tx => {
      const restore: Array<() => void> = [];
      for (const model of Prisma.dmmf.datamodel.models) {
        const name = model.name.charAt(0).toLowerCase() + model.name.slice(1);
        const live = (prisma as any)[name], delegate = (tx as any)[name];
        for (const method of ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
          if (typeof live?.[method] !== 'function') continue;
          const before = live[method]; const bound = delegate[method].bind(delegate);
          live[method] = bound; restore.push(() => { live[method] = before; });
        }
      }
      (prisma as any).$transaction = (fn: any) => fn(tx);
      try {
        const vendor = await tx.vendor.create({ data: { name: tag, contact: '9000000000', state: 'Tamil Nadu', status: 'ACTIVE' } });
        const warehouse = await tx.warehouse.create({ data: { name: tag, nameKey: tag.toLowerCase(), status: 'ACTIVE' } });
        for (const category of ['RAW_MATERIAL', 'FINISHED_GOOD', 'SEMI_FINISHED'] as const) {
          const material = await tx.inventoryItem.create({ data: { name: `${tag}-${category}`, sku: `${tag}-${category}`, category, unit: category === 'FINISHED_GOOD' ? 'PC' : 'KG', currentStock: 0, basePrice: 87, gstRate: 12 } });
          const payload = { vendorId: vendor.id, warehouseId: warehouse.id, expectedDeliveryDate: purchaseBusinessDate(), purchaseType: category === 'RAW_MATERIAL' ? category : 'FINISHED_GOODS', items: [{ inventoryItemId: material.id, quantity: 10, price: 20, gstRate: 5, unit: material.unit, isBulk: category === 'SEMI_FINISHED' }] };
          const po = await ProcurementService.createPurchaseOrder(payload);
          assert.equal(po.status, 'APPROVED'); assert.equal(po.approvedAt, null);
          assert.equal((await tx.inventoryItem.findUniqueOrThrow({ where: { id: material.id } })).currentStock, 0);
          assert.equal(await tx.goodsReceipt.count({ where: { poId: po.id } }), 0);
          assert.equal(await tx.vendorInvoice.count({ where: { poId: po.id } }), 0);
          // Open POs still protect their vendor from deactivation now that status is APPROVED.
          if (category === 'RAW_MATERIAL') await assert.rejects(() => ProcurementService.deleteVendor(vendor.id), /pending Purchase Orders/);
          const createReceipt = (quantity: number) => GRNService.createFromPO(po.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: quantity, acceptedQty: quantity, rejectedQty: 0, price: 20, warehouseId: warehouse.id, expDate: '2099-12-31' }] });
          assert.equal((await ProcurementService.getPurchaseOrders()).find(p => p.id === po.id)?.canReceive, true);
          const grn = await createReceipt(4);
          assert.equal(grn.status, 'PENDING');
          assert.equal((await tx.inventoryItem.findUniqueOrThrow({ where: { id: material.id } })).currentStock, 0);
          await GRNService.approve(grn.id);
          assert.equal((await tx.procurementOrder.findUniqueOrThrow({ where: { id: po.id } })).status, 'PARTIALLY_RECEIVED');
          assert.equal((await tx.inventoryItem.findUniqueOrThrow({ where: { id: material.id } })).currentStock, 4);
          await assert.rejects(() => createReceipt(7), /only 6/);
          const rest = await createReceipt(6); await GRNService.approve(rest.id);
          const after = await tx.inventoryItem.findUniqueOrThrow({ where: { id: material.id } });
          assert.equal(after.currentStock, 10); assert.equal(after.category, category); assert.equal(after.basePrice, 87); assert.equal(after.gstRate, 12);
          assert.equal((await tx.procurementOrder.findUniqueOrThrow({ where: { id: po.id } })).status, 'RECEIVED');
          assert.equal((await ProcurementService.getPurchaseOrders()).find(p => p.id === po.id)?.canReceive, false);
          assert.equal(await tx.vendorInvoice.count({ where: { poId: po.id } }), 2);
          if (category === 'SEMI_FINISHED') assert.equal(await tx.productBatch.count({ where: { procurementOrderId: po.id, sourceType: 'PURCHASE' } }), 2);
          await assert.rejects(() => GRNService.approve(rest.id), /already approved/);
          await assert.rejects(() => createReceipt(1), /status RECEIVED/);
          const draft = await ProcurementService.createPurchaseOrder({ ...payload, status: 'DRAFT' });
          await assert.rejects(() => GRNService.createFromPO(draft.id, { items: [] }), /status DRAFT/);
          await ProcurementService.updatePO(draft.id, { status: 'APPROVED' });
          assert.equal((await tx.procurementOrder.findUniqueOrThrow({ where: { id: draft.id } })).status, 'APPROVED');
          const legacy = await tx.procurementOrder.create({ data: { vendorId: vendor.id, warehouseId: warehouse.id, totalAmount: 20, status: 'PENDING_APPROVAL', approvedBy: 'HISTORICAL', poItems: { create: [{ inventoryItemId: material.id, quantity: 1, price: 20, unit: material.unit, subtotal: 20, total: 20 }] } } });
          const legacyGRN = await GRNService.createFromPO(legacy.id, { items: [{ materialId: material.id, orderedQty: 1, receivedQty: 1, acceptedQty: 1, rejectedQty: 0, price: 20, warehouseId: warehouse.id }] });
          assert.equal(legacyGRN.status, 'PENDING');
          assert.equal((await tx.procurementOrder.findUniqueOrThrow({ where: { id: legacy.id } })).approvedBy, 'HISTORICAL');
          await tx.procurementOrder.update({ where: { id: legacy.id }, data: { status: 'CANCELLED' } });
          await assert.rejects(() => GRNService.approve(legacyGRN.id), /status CANCELLED/);
          await assert.rejects(() => GRNService.createFromPO(legacy.id, { items: [] }), /status CANCELLED/);
        }
      } finally {
        restore.reverse().forEach(fn => fn()); (prisma as any).$transaction = originalTransaction;
      }
      throw rollback;
    }, { timeout: 120000 });
  } catch (e) { if (e !== rollback) throw e; }
  assert.equal(await prisma.vendor.count({ where: { name: tag } }), 0);
  console.log('PASS: raw + retail FG + bulk FG PO creation -> pending GRN -> partial receipt -> full receipt/bills/stock; draft completion, legacy compatibility, cancelled guards, duplicate posting, counters; all fixtures rolled back');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
