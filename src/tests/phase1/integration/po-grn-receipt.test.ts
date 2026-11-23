// PO / GRN receipt flow: one PO -> many GRNs, each GRN -> exactly one PO,
// partial deliveries stay pending on the same PO (never a vendor return),
// receivedQty <= pendingQty under row locks, stock posted exactly once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestDatabase, ensureHq, createUser, createFranchise, tokenFor, startServer, call, createStockedItem, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { ProcurementService } from '../../../modules/procurement/procurement.service';
import { GRNService } from '../../../modules/grn/grn.service';
import { InventoryService } from '../../../modules/inventory/inventory.service';
import { purchaseBusinessDate } from '../../../modules/procurement/purchase-dates';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let sa: any, fa: any, vendor: any, otherVendor: any;
const exp = new Date(Date.now() + 180 * 86400000).toISOString();

before(async () => {
  await ensureHq();
  const fr = await createFranchise('F');
  sa = await createUser('SUPER_ADMIN', null);
  fa = await createUser('FRANCHISE_ADMIN', fr.id);
  vendor = await prisma.vendor.create({ data: { name: `Rice Vendor ${uid()}`, contact: '0', status: 'ACTIVE', state: 'Kerala' } });
  otherVendor = await prisma.vendor.create({ data: { name: `Other Vendor ${uid()}`, contact: '0', status: 'ACTIVE', state: 'Kerala' } });
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const token = () => tokenFor(sa);
const newMaterial = () => createStockedItem({ franchiseId: null, qty: 0, category: 'RAW_MATERIAL' });
async function newPO(lines: Array<{ materialId: string; qty: number }>) {
  return ProcurementService.createPurchaseOrder({
    vendorId: vendor.id,
    expectedDeliveryDate: purchaseBusinessDate(),
    items: lines.map(l => ({ inventoryItemId: l.materialId, quantity: l.qty, price: 50, gstRate: 5, unit: 'PC' })),
  } as any);
}
const line = (poItemId: string, receivedQty: number, extra: Record<string, unknown> = {}) => ({ poItemId, receivedQty, expDate: exp, ...extra });
const receive = (poId: string, body: any) => call(srv.base, 'POST', `/api/purchase-orders/${poId}/grns`, token(), body);
const summary = async (poId: string) => (await call(srv.base, 'GET', `/api/purchase-orders/${poId}/summary`, token())).body;
const stockOf = (itemId: string) => InventoryService.computeStock(itemId);
const movementsFor = (grnId: string) => prisma.stockMovement.count({ where: { referenceId: grnId, movementType: 'PURCHASE_IN' } });

test('partial receipt, second GRN for the balance, automatic close for receipt', async () => {
  const rice = await newMaterial();
  const po = await newPO([{ materialId: rice.id, qty: 100 }]);
  const poItemId = po.poItems[0].id;
  assert.equal(po.poItems[0].pendingQty, 100, 'new PO line starts fully pending');

  // First delivery: 40 of 100.
  const r1 = await receive(po.id, { items: [line(poItemId, 40)] });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.grn.status, 'COMPLETED');
  assert.equal(r1.body.grn.displayStatus, 'POSTED');
  assert.match(r1.body.grn.grnNumber, /^GRN-\d{4}-\d{5}$/);
  assert.equal(r1.body.grn.vendorId, vendor.id);
  assert.equal(r1.body.summary.status, 'PARTIALLY_RECEIVED');
  assert.equal(r1.body.summary.lines[0].receivedQty, 40);
  assert.equal(r1.body.summary.lines[0].pendingQty, 60);

  const storedLine = await prisma.procurementOrderItem.findUniqueOrThrow({ where: { id: poItemId } });
  assert.equal(storedLine.receivedQty, 40);
  assert.equal(storedLine.pendingQty, 60);
  assert.equal(await prisma.purchaseReturn.count({ where: { procurementOrderId: po.id } }), 0, 'undelivered balance is NOT a vendor return');
  assert.equal(await stockOf(rice.id), 40);

  // Pending-items shows only the open line with 60 pending.
  const pending = await call(srv.base, 'GET', `/api/purchase-orders/${po.id}/pending-items`, token());
  assert.equal(pending.status, 200);
  assert.equal(pending.body.canReceive, true);
  assert.deepEqual(pending.body.items.map((i: any) => [i.poItemId, i.pendingQty]), [[poItemId, 60]]);

  // Second delivery: remaining 60.
  const r2 = await receive(po.id, { items: [line(poItemId, 60)] });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.notEqual(r2.body.grn.grnNumber, r1.body.grn.grnNumber, 'GRN numbers are unique');
  const s = await summary(po.id);
  assert.equal(s.status, 'RECEIVED');
  assert.equal(s.receiptStatus, 'FULLY_RECEIVED');
  assert.deepEqual([s.totals.orderedQty, s.totals.receivedQty, s.totals.pendingQty], [100, 100, 0]);
  assert.equal(s.canReceive, false);
  assert.equal(s.message, 'All quantities for this Purchase Order have been received.');
  assert.equal(s.grns.length, 2, 'one PO, two GRNs');
  assert.ok(s.grns.every((g: any) => g.poId === po.id));
  assert.equal(await stockOf(rice.id), 100);

  // No third GRN on a fully received PO.
  const r3 = await receive(po.id, { items: [line(poItemId, 1)] });
  assert.equal(r3.status, 409);
  assert.match(r3.body.error, /All quantities for this Purchase Order have been received/);
  const pendingAfter = await call(srv.base, 'GET', `/api/purchase-orders/${po.id}/pending-items`, token());
  assert.equal(pendingAfter.body.items.length, 0);
});

test('over-receipt, zero and negative quantities are rejected', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 100 }]);
  const id = po.poItems[0].id;

  for (const qty of [101, 0, -5]) {
    const r = await receive(po.id, { items: [line(id, qty)] });
    assert.equal(r.status, 400, `qty ${qty}`);
  }
  const over = await receive(po.id, { items: [line(id, 101)] });
  assert.match(over.body.error, /Received quantity cannot exceed pending quantity/);

  assert.equal((await receive(po.id, { items: [line(id, 40)] })).status, 201);
  const overAfterPartial = await receive(po.id, { items: [line(id, 61)] });
  assert.equal(overAfterPartial.status, 400);
  assert.match(overAfterPartial.body.error, /pending 60/);
  assert.equal(await prisma.goodsReceipt.count({ where: { poId: po.id } }), 1, 'rejected requests created nothing');
});

test('a GRN cannot contain products from another PO, use two PO ids, or duplicate lines', async () => {
  const a = await newMaterial();
  const b = await newMaterial();
  const poA = await newPO([{ materialId: a.id, qty: 10 }]);
  const poB = await newPO([{ materialId: b.id, qty: 10 }]);
  const lineA = poA.poItems[0].id;
  const lineB = poB.poItems[0].id;

  const foreignLine = await receive(poA.id, { items: [line(lineA, 1), line(lineB, 1)] });
  assert.equal(foreignLine.status, 400);
  assert.match(foreignLine.body.error, /does not belong to Purchase Order/);

  const foreignProduct = await receive(poA.id, { items: [{ productId: b.id, receivedQty: 1, expDate: exp }] });
  assert.equal(foreignProduct.status, 400);
  assert.match(foreignProduct.body.error, /does not belong to Purchase Order/);

  const mismatchedProduct = await receive(poA.id, { items: [line(lineA, 1, { productId: b.id })] });
  assert.equal(mismatchedProduct.status, 400);
  assert.match(mismatchedProduct.body.error, /does not match/);

  const twoPoIds = await receive(poA.id, { purchaseOrderId: poB.id, items: [line(lineA, 1)] });
  assert.equal(twoPoIds.status, 400);
  assert.match(twoPoIds.body.error, /only one Purchase Order/);

  const linePoId = await receive(poA.id, { items: [line(lineA, 1, { purchaseOrderId: poB.id })] });
  assert.equal(linePoId.status, 400);

  const dup = await receive(poA.id, { items: [line(lineA, 2), line(lineA, 3)] });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /Duplicate line/);

  const wrongVendor = await receive(poA.id, { vendorId: otherVendor.id, items: [line(lineA, 1)] });
  assert.equal(wrongVendor.status, 400);
  assert.match(wrongVendor.body.error, /vendor/i);

  assert.equal(await prisma.goodsReceipt.count({ where: { poId: { in: [poA.id, poB.id] } } }), 0);
  assert.equal(await stockOf(a.id), 0);
  assert.equal(await stockOf(b.id), 0);
});

test('GRN number must be unique', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 10 }]);
  const id = po.poItems[0].id;
  const num = `GRN-MANUAL-${uid()}`;
  assert.equal((await receive(po.id, { grnNumber: num, items: [line(id, 2)] })).status, 201);
  const again = await receive(po.id, { grnNumber: num, items: [line(id, 2)] });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already exists/);
});

test('cancelled and closed POs refuse new GRNs', async () => {
  const m = await newMaterial();
  const cancelled = await newPO([{ materialId: m.id, qty: 10 }]);
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${cancelled.id}/cancel`, token(), { reason: 'Vendor out of stock' })).status, 200);
  const r = await receive(cancelled.id, { items: [line(cancelled.poItems[0].id, 1)] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /cancelled/);
  assert.equal((await summary(cancelled.id)).canReceive, false);

  const closed = await newPO([{ materialId: m.id, qty: 10 }]);
  await prisma.procurementOrder.update({ where: { id: closed.id }, data: { status: 'CLOSED' } });
  const rc = await receive(closed.id, { items: [line(closed.poItems[0].id, 1)] });
  assert.equal(rc.status, 409);
  assert.match(rc.body.error, /closed/);
  assert.equal(await prisma.goodsReceipt.count({ where: { poId: { in: [cancelled.id, closed.id] } } }), 0);
});

test('two simultaneous GRNs cannot over-receive the same pending quantity', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 100 }]);
  const id = po.poItems[0].id;

  const results = await Promise.all([receive(po.id, { items: [line(id, 60)] }), receive(po.id, { items: [line(id, 60)] })]);
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [201, 400], JSON.stringify(results.map(r => r.body.error || r.status)));
  assert.match(results.find(r => r.status === 400)!.body.error, /cannot exceed pending/);
  const s = await summary(po.id);
  assert.equal(s.totals.receivedQty, 60);
  assert.equal(s.totals.pendingQty, 40);
  assert.equal(await stockOf(m.id), 60);

  // Two simultaneous receipts that fit together both succeed, serialized.
  const both = await Promise.all([receive(po.id, { items: [line(id, 20)] }), receive(po.id, { items: [line(id, 20)] })]);
  assert.deepEqual(both.map(r => r.status), [201, 201]);
  const s2 = await summary(po.id);
  assert.equal(s2.totals.pendingQty, 0);
  assert.equal(s2.status, 'RECEIVED');
  assert.equal(await stockOf(m.id), 100);
});

test('stock is posted exactly once, and only when the GRN is posted', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 30 }]);
  const id = po.poItems[0].id;

  // Draft: no stock, no PO counter change.
  const draft = await receive(po.id, { post: false, items: [line(id, 30)] });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.grn.displayStatus, 'DRAFT');
  assert.equal(await movementsFor(draft.body.grn.id), 0);
  assert.equal(await stockOf(m.id), 0);
  assert.equal((await summary(po.id)).lines[0].draftQty, 30);
  assert.equal((await summary(po.id)).lines[0].pendingQty, 30, 'a draft does not consume pending');

  // Post it twice concurrently + once more: one posting only.
  const posts = await Promise.allSettled([GRNService.approve(draft.body.grn.id, { userId: sa.id, role: 'SUPER_ADMIN' }), GRNService.approve(draft.body.grn.id, { userId: sa.id, role: 'SUPER_ADMIN' })]);
  assert.equal(posts.filter(p => p.status === 'fulfilled').length, 1);
  const again = await call(srv.base, 'PATCH', `/api/grn/${draft.body.grn.id}/approve`, token(), {});
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already approved/);

  assert.equal(await movementsFor(draft.body.grn.id), 1);
  assert.equal(await prisma.inventoryBatch.count({ where: { goodsReceiptItem: { grnId: draft.body.grn.id } } }), 1);
  assert.equal(await prisma.vendorInvoice.count({ where: { grnId: draft.body.grn.id } }), 1);
  assert.equal(await stockOf(m.id), 30);
});

test('a failure while posting rolls back the GRN, PO counters and stock together', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 10 }]);
  const id = po.poItems[0].id;
  // No expiry date: GRN creation passes, posting fails (EXP is mandatory for accepted stock).
  const r = await receive(po.id, { items: [{ poItemId: id, receivedQty: 5 }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Expiry/);
  assert.equal(await prisma.goodsReceipt.count({ where: { poId: po.id } }), 0, 'no GRN left behind');
  const stored = await prisma.procurementOrderItem.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([stored.receivedQty, stored.pendingQty], [0, 10]);
  assert.equal((await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } })).status, 'APPROVED');
  assert.equal(await stockOf(m.id), 0);
});

test('QC-rejected units become a return; the undelivered balance stays pending', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 100 }]);
  const id = po.poItems[0].id;
  // 50 delivered, 10 of them damaged. 50 never delivered.
  const r = await receive(po.id, { items: [line(id, 50, { rejectedQty: 10 })] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ret = await prisma.purchaseReturn.findFirstOrThrow({ where: { procurementOrderId: po.id }, include: { items: true } });
  assert.equal(ret.items.reduce((s, i) => s + i.quantity, 0), 10, 'only the damaged 10 are returned, not the 50 undelivered');
  const s = await summary(po.id);
  assert.equal(s.lines[0].acceptedQty, 40);
  assert.equal(s.lines[0].pendingQty, 60, '50 undelivered + 10 rejected awaiting the return');
  assert.equal(await stockOf(m.id), 40);

  // Completing the return counts the rejected 10 as fulfilled; 50 stay pending.
  const done = await call(srv.base, 'PATCH', `/api/purchase/returns/${ret.id}`, token(), { status: 'COMPLETED', reason: 'Damaged bags' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const stored = await prisma.procurementOrderItem.findUniqueOrThrow({ where: { id } });
  assert.deepEqual([stored.receivedQty, stored.pendingQty], [50, 50]);
  assert.equal((await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } })).status, 'PARTIALLY_RECEIVED');
});

test('legacy create + approve endpoints keep working and share the same rules', async () => {
  const m1 = await newMaterial();
  const m2 = await newMaterial();
  const po = await newPO([{ materialId: m1.id, qty: 10 }, { materialId: m2.id, qty: 5 }]);
  // The old screen sends every PO line, zero quantities included.
  const created = await call(srv.base, 'POST', `/api/grn/from-po/${po.id}`, token(), {
    items: [
      { materialId: m1.id, orderedQty: 10, receivedQty: 4, acceptedQty: 4, rejectedQty: 0, price: 50, expDate: exp },
      { materialId: m2.id, orderedQty: 5, receivedQty: 0, acceptedQty: 0, rejectedQty: 0, price: 50 },
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.items.length, 1, 'zero-quantity line ignored');
  assert.equal(created.body.items[0].poItemId, po.poItems.find((p: any) => p.inventoryItemId === m1.id)!.id);
  assert.equal((await call(srv.base, 'PATCH', `/api/grn/${created.body.id}/approve`, token(), {})).status, 200);
  const remaining = await call(srv.base, 'GET', `/api/grn/po/${po.id}/remaining`, token());
  assert.deepEqual(remaining.body.map((r: any) => r.remaining).sort(), [5, 6]);
});

test('PO receipt routes are Super Admin only', async () => {
  const m = await newMaterial();
  const po = await newPO([{ materialId: m.id, qty: 1 }]);
  for (const [method, path] of [['GET', 'summary'], ['GET', 'pending-items'], ['GET', 'grns'], ['POST', 'grns']] as const) {
    const r = await call(srv.base, method, `/api/purchase-orders/${po.id}/${path}`, tokenFor(fa), method === 'POST' ? { items: [] } : undefined);
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  assert.equal((await call(srv.base, 'GET', `/api/purchase-orders/00000000-0000-0000-0000-000000000000/summary`, token())).status, 404);
});
