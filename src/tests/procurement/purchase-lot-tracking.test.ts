/**
 * Phase 1 — Purchase batch & Stock Hub lot tracking.
 *
 * PO → GRN → lot creation, lot-wise valuation, lot-linked purchase returns,
 * low stock, duplicate-posting protection, and a check that Production's
 * FIFO consumption path is unchanged.
 *
 * Writes real rows (uniquely named per run). Run it against a disposable
 * database:  DATABASE_URL=<test db> npx tsx src/tests/procurement/purchase-lot-tracking.test.ts
 */
import prisma from '../../lib/prisma';
import { GRNService } from '../../modules/grn/grn.service';
import { PurchaseService } from '../../modules/purchase/purchase.service';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { PurchaseLotsService } from '../../modules/inventory/purchase-lots.service';

let passed = 0;
function check(title: string, condition: boolean, details?: unknown) {
  if (!condition) {
    console.error(`[FAIL] ${title}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
  passed++;
  console.log(`[PASS] ${title}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 0.0001;

async function expectError(fn: () => Promise<unknown>, contains: string) {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message || e).includes(contains) ? null : e?.message;
  }
  return 'did not throw';
}

const ts = Date.now();

async function createPO(vendorId: string, warehouseId: string, itemId: string, qty: number, price: number, unit = 'KG') {
  return prisma.procurementOrder.create({
    data: {
      vendorId,
      warehouseId,
      status: 'APPROVED',
      poNumber: `PO-LOT-${ts}-${Math.random().toString(36).slice(2, 7)}`,
      subtotal: qty * price,
      totalAmount: qty * price,
      poItems: { create: [{ inventoryItemId: itemId, quantity: qty, price, unit, gstRate: 0, subtotal: qty * price, total: qty * price }] },
    },
  });
}

async function receive(poId: string, itemId: string, warehouseId: string, qty: number, price: number) {
  const grn = await GRNService.createFromPO(poId, {
    items: [{ materialId: itemId, orderedQty: qty, receivedQty: qty, acceptedQty: qty, rejectedQty: 0, price, expDate: '2027-12-31', warehouseId, vendorBatchNo: `MFR-${ts}` }],
  });
  return grn;
}

async function lotForGrn(grnId: string) {
  const gi = await prisma.goodsReceiptItem.findFirst({ where: { grnId } });
  return prisma.inventoryBatch.findUnique({ where: { goodsReceiptItemId: gi!.id } });
}

async function run() {
  console.log('=== PURCHASE LOT TRACKING (PHASE 1) ===\n');

  const warehouse = await prisma.warehouse.create({ data: { name: `Lot WH ${ts}`, nameKey: `lot-wh-${ts}`, status: 'ACTIVE' } });
  const vendor = await prisma.vendor.create({ data: { name: `Lot Vendor ${ts}`, contact: '9000000000', state: 'Tamil Nadu' } });
  const otherVendor = await prisma.vendor.create({ data: { name: `Other Vendor ${ts}`, contact: '9000000001', state: 'Tamil Nadu' } });
  const rice = await prisma.inventoryItem.create({
    data: { name: `Rice ${ts}`, sku: `RM-RICE-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 25, costPrice: 0 },
  });

  // 1–3. First purchase at ₹100/KG
  const po1 = await createPO(vendor.id, warehouse.id, rice.id, 10, 100);
  const stockAfterPO = await InventoryService.computeStock(rice.id);
  check('1. Creating a PO does not increase stock', stockAfterPO === 0, stockAfterPO);

  const grn1 = await receive(po1.id, rice.id, warehouse.id, 10, 100);
  check('2a. GRN created as PENDING, no stock yet', grn1.status === 'PENDING' && (await InventoryService.computeStock(rice.id)) === 0);
  await GRNService.approve(grn1.id);
  const lot1 = await lotForGrn(grn1.id);
  check('3a. Batch 1 created and linked to its GRN line', !!lot1);
  check('3b. Batch 1 linked to PO and supplier', lot1!.procurementOrderId === po1.id && lot1!.vendorId === vendor.id);
  check('3c. Batch 1 qty 10 KG @ ₹100/KG', near(lot1!.initialQty, 10) && near(lot1!.currentQty, 10) && near(lot1!.unitCost!, 100));
  check('3d. Batch 1 records purchase price/unit, receipt date, warehouse, expiry',
    near(lot1!.purchasePrice!, 100) && lot1!.purchaseUnit === 'KG' && !!lot1!.receivedAt && lot1!.warehouseId === warehouse.id && !!lot1!.expDate);
  const grn1Line = await prisma.goodsReceiptItem.findFirst({ where: { grnId: grn1.id } });
  check('3e. Manufacturer batch no. kept on the GRN line', grn1Line?.vendorBatchNo === `MFR-${ts}`);

  // 4–6. Second purchase of the same material at ₹200/KG
  const po2 = await createPO(vendor.id, warehouse.id, rice.id, 10, 200);
  const grn2 = await receive(po2.id, rice.id, warehouse.id, 10, 200);
  await GRNService.approve(grn2.id);
  const lot2 = await lotForGrn(grn2.id);
  check('6. Batch 2 created @ ₹200/KG', !!lot2 && near(lot2!.unitCost!, 200) && lot2!.procurementOrderId === po2.id);

  // 7. Separate lots, one master material
  const riceItems = await prisma.inventoryItem.count({ where: { sku: rice.sku } });
  const riceLots = await prisma.inventoryBatch.findMany({ where: { inventoryItemId: rice.id } });
  check('7a. Still exactly one Rice master record', riceItems === 1);
  check('7b. Two separate lots with different costs', riceLots.length === 2 && lot1!.id !== lot2!.id && lot1!.batchNumber !== lot2!.batchNumber);
  check('7c. PO price history preserved per PO line',
    (await prisma.procurementOrderItem.findFirst({ where: { poId: po1.id } }))!.price === 100 &&
    (await prisma.procurementOrderItem.findFirst({ where: { poId: po2.id } }))!.price === 200);

  // 8–9. Totals and valuation
  const stock = await InventoryService.computeStock(rice.id);
  check('8. Total stock = 20 KG', near(stock, 20), stock);
  const sums = await PurchaseLotsService.getLotSummaries([rice.id]);
  const riceItem = await prisma.inventoryItem.findUnique({ where: { id: rice.id } });
  const summary = PurchaseLotsService.summarize(stock, riceItem!.costPrice || 0, sums.get(rice.id));
  check('9a. Total inventory value = ₹3,000', near(summary.totalValue, 3000), summary);
  check('9b. Active lots = 2', summary.activeLots === 2, summary);
  check('9c. Weighted average cost = ₹150/KG', near(summary.weightedAvgCost, 150), summary);
  check('9d. No untracked stock', near(summary.untrackedQty, 0), summary);
  const detail = await PurchaseLotsService.getMaterialLots(rice.id);
  const d1 = detail.lots.find(l => l.id === lot1!.id)!;
  const d2 = detail.lots.find(l => l.id === lot2!.id)!;
  check('9e. Lot detail: values ₹1,000 and ₹2,000, supplier + PO shown',
    near(d1.stockValue, 1000) && near(d2.stockValue, 2000) && d1.supplier?.id === vendor.id && d1.poNumber === po1.poNumber && d1.vendorBatchNo === `MFR-${ts}`, { d1, d2 });

  // Unit conversion: bought in G, stocked in KG
  const sugar = await prisma.inventoryItem.create({
    data: { name: `Sugar ${ts}`, sku: `RM-SUGAR-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 0, costPrice: 0 },
  });
  const poG = await createPO(vendor.id, warehouse.id, sugar.id, 5000, 0.04, 'G');
  const grnG = await receive(poG.id, sugar.id, warehouse.id, 5000, 0.04);
  await GRNService.approve(grnG.id);
  const lotG = await lotForGrn(grnG.id);
  check('9f. 5000 G @ ₹0.04/G → lot of 5 KG @ ₹40/KG (value ₹200)',
    near(lotG!.initialQty, 5) && near(lotG!.unitCost!, 40) && near(lotG!.purchaseQty!, 5000) && lotG!.purchaseUnit === 'G', lotG);

  // 10. Purchase return against the NEWER lot (FIFO would have taken lot 1)
  const returnable = await ProcurementService.getVendorReturnableMaterials(vendor.id);
  const riceReturnable: any = returnable.find((m: any) => m.materialId === rice.id);
  check('10a. Returnable materials list each lot', riceReturnable?.lots?.length === 2, riceReturnable);

  const ret = await PurchaseService.createPurchaseReturn({
    vendorId: vendor.id, reason: 'Quality issue', returnSource: 'MANUAL',
    items: [{ itemName: rice.name, quantity: 4, unit: 'KG', rate: 1, inventoryBatchId: lot2!.id }],
  });
  check('10b. Return line linked to lot 2 at its own cost (₹200)',
    ret.items[0].inventoryBatchId === lot2!.id && near(ret.items[0].rate, 200) && near(ret.refundAmount, 800), ret.items[0]);

  const overErr = await expectError(() => PurchaseService.createPurchaseReturn({
    vendorId: vendor.id, reason: 'Too much', returnSource: 'MANUAL',
    items: [{ itemName: rice.name, quantity: 7, unit: 'KG', rate: 1, inventoryBatchId: lot2!.id }],
  }), 'left in that lot');
  check('10c. Cannot return more than the lot has left (10 − 4 pending)', overErr === null, overErr);

  const wrongVendorErr = await expectError(() => PurchaseService.createPurchaseReturn({
    vendorId: otherVendor.id, reason: 'Wrong vendor', returnSource: 'MANUAL',
    items: [{ itemName: rice.name, quantity: 1, unit: 'KG', rate: 1, inventoryBatchId: lot1!.id }],
  }), '');
  check('10d. Cannot return a lot to a vendor that did not supply it', wrongVendorErr === null, wrongVendorErr);

  await PurchaseService.updatePurchaseReturn(ret.id, { status: 'COMPLETED' });
  const lot1After = await prisma.inventoryBatch.findUnique({ where: { id: lot1!.id } });
  const lot2After = await prisma.inventoryBatch.findUnique({ where: { id: lot2!.id } });
  check('10e. Lot 2 reduced to 6 KG; lot 1 untouched at 10 KG', near(lot2After!.currentQty, 6) && near(lot1After!.currentQty, 10), { l1: lot1After!.currentQty, l2: lot2After!.currentQty });
  const retMove = await prisma.stockMovement.findFirst({ where: { referenceId: ret.id, movementType: 'RETURN_OUT' } });
  check('10f. Return movement carries lot 2 and its original cost', retMove?.batchId === lot2!.id && near(retMove!.unitCost!, 200) && near(retMove!.baseQty!, -4), retMove);
  const stockAfterReturn = await InventoryService.computeStock(rice.id);
  const sumsAfter = PurchaseLotsService.summarize(stockAfterReturn, 0, (await PurchaseLotsService.getLotSummaries([rice.id])).get(rice.id));
  check('10g. Stock 16 KG, value ₹2,200 after return', near(stockAfterReturn, 16) && near(sumsAfter.totalValue, 2200), sumsAfter);

  // 11. Low stock on aggregated quantity (min 25)
  const inv = await InventoryService.getInventory(undefined, false, undefined, 'RAW_MATERIAL' as any);
  const riceRow: any = inv.find((i: any) => i.id === rice.id);
  check('11. Low-stock status from aggregated stock (16 < 25)', riceRow?.status === 'LOW' && near(riceRow.currentStock, 16), { status: riceRow?.status, stock: riceRow?.currentStock });

  // 12. Duplicate GRN posting
  const reapproveErr = await expectError(() => GRNService.approve(grn1.id), 'already approved');
  check('12a. Re-approving a completed GRN is rejected', reapproveErr === null, reapproveErr);
  const po3 = await createPO(vendor.id, warehouse.id, rice.id, 5, 150);
  const grn3 = await receive(po3.id, rice.id, warehouse.id, 5, 150);
  const results = await Promise.allSettled([GRNService.approve(grn3.id), GRNService.approve(grn3.id), GRNService.approve(grn3.id)]);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const grn3Line = await prisma.goodsReceiptItem.findFirst({ where: { grnId: grn3.id } });
  const grn3Lots = await prisma.inventoryBatch.count({ where: { goodsReceiptItemId: grn3Line!.id } });
  const grn3Moves = await prisma.stockMovement.count({ where: { referenceId: grn3.id, movementType: 'PURCHASE_IN' } });
  check('12b. Three concurrent approvals → exactly one posts', ok === 1 && grn3Lots === 1 && grn3Moves === 1, { ok, grn3Lots, grn3Moves });
  check('12c. Stock = 21 KG (16 + 5, not 16 + 15)', near(await InventoryService.computeStock(rice.id), 21));

  // 13. Production consumption path unchanged: plain FIFO from the oldest lot
  await prisma.$transaction(async (tx) => {
    await InventoryService.recordMovement(tx, { itemId: rice.id, type: 'PRODUCTION_OUT', quantity: -2, referenceType: 'PRODUCTION', referenceId: `prod-${ts}`, note: 'test' });
  });
  const l1 = await prisma.inventoryBatch.findUnique({ where: { id: lot1!.id } });
  const l2 = await prisma.inventoryBatch.findUnique({ where: { id: lot2!.id } });
  check('13. Production still consumes FIFO (oldest lot 10→8, lot 2 stays 6)', near(l1!.currentQty, 8) && near(l2!.currentQty, 6), { l1: l1!.currentQty, l2: l2!.currentQty });

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
