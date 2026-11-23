// Audit C-04: GRN-rejection returns are generated server-side from the GRN's
// own rejected quantities, never from client input, and never reduce the
// vendor payable. Audit C-05: PO cancellation posts nothing to the vendor
// ledger, requires a reason, is limited to valid states; delete is limited
// to untouched drafts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestDatabase, ensureHq, createUser, createFranchise, tokenFor, startServer, call, createStockedItem, createAccount, auditCount, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { ProcurementService } from '../../../modules/procurement/procurement.service';
import { GRNService } from '../../../modules/grn/grn.service';
import { purchaseBusinessDate } from '../../../modules/procurement/purchase-dates';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let sa: any, faA: any, vendor: any, material: any;

before(async () => {
  await ensureHq();
  const franchiseA = await createFranchise('A');
  sa = await createUser('SUPER_ADMIN', null);
  faA = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  vendor = await prisma.vendor.create({ data: { name: `Vendor ${uid()}`, contact: '0', status: 'ACTIVE', state: 'Kerala' } });
  material = await createStockedItem({ franchiseId: null, qty: 0, category: 'RAW_MATERIAL' });
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const newPO = (opts: { qty?: number; status?: string; advancePaid?: number; accountId?: string; vendorId?: string } = {}) => ProcurementService.createPurchaseOrder({
  vendorId: opts.vendorId || vendor.id,
  expectedDeliveryDate: purchaseBusinessDate(),
  status: opts.status,
  advancePaid: opts.advancePaid,
  accountId: opts.accountId,
  items: [{ inventoryItemId: material.id, quantity: opts.qty ?? 10, price: 20, gstRate: 5, unit: 'PC' }],
});
const exp = new Date(Date.now() + 90 * 86400000).toISOString();
const vendorLedgerCount = () => prisma.vendorLedger.count({ where: { vendorId: vendor.id } });

test('C-04: the API refuses client-supplied GRN_REJECTION returns and client status on create', async () => {
  const po = await newPO();
  const forged = await call(srv.base, 'POST', '/api/purchase/returns', tokenFor(sa), {
    vendorId: vendor.id, procurementOrderId: po.id, reason: 'x', returnSource: 'GRN_REJECTION', status: 'COMPLETED',
    items: [{ itemName: material.name, quantity: 1000, unit: 'PC', rate: 999 }],
  });
  assert.equal(forged.status, 400);
  const completedOnCreate = await call(srv.base, 'POST', '/api/purchase/returns', tokenFor(sa), {
    vendorId: vendor.id, reason: 'x', returnSource: 'MANUAL', status: 'COMPLETED', items: [{ itemName: material.name, quantity: 1, unit: 'PC', rate: 1 }],
  });
  assert.equal(completedOnCreate.status, 400);
  assert.equal(await prisma.purchaseReturn.count({ where: { vendorId: vendor.id } }), 0);
  assert.equal(await vendorLedgerCount(), 0, 'no vendor ledger effect');
});

test('C-04: purchase return routes are HQ-only', async () => {
  assert.equal((await call(srv.base, 'GET', '/api/purchase/returns', tokenFor(faA))).status, 403);
  assert.equal((await call(srv.base, 'POST', '/api/purchase/returns', tokenFor(faA), { vendorId: vendor.id, reason: 'x', items: [] })).status, 403);
});

test('C-04: GRN approval generates exactly one return from the GRN\'s own rejected quantity, non-financial', async () => {
  const po = await newPO({ qty: 10 });
  const grn = await GRNService.createFromPO(po.id, {
    user: { userId: sa.id, role: 'SUPER_ADMIN' },
    items: [{ materialId: material.id, orderedQty: 10, receivedQty: 10, acceptedQty: 7, rejectedQty: 3, price: 20, expDate: exp }],
  });
  await GRNService.approve(grn.id, { userId: sa.id, role: 'SUPER_ADMIN' });
  await assert.rejects(() => GRNService.approve(grn.id, { userId: sa.id, role: 'SUPER_ADMIN' }), /already approved/);

  const returns = await prisma.purchaseReturn.findMany({ where: { goodsReceiptId: grn.id }, include: { items: true } });
  assert.equal(returns.length, 1);
  const ret = returns[0];
  assert.equal(ret.returnSource, 'GRN_REJECTION');
  assert.equal(ret.status, 'PENDING');
  assert.equal(ret.items.length, 1);
  assert.equal(ret.items[0].quantity, 3, 'quantity = GRN rejectedQty');
  assert.equal(ret.items[0].rate, 20, 'rate = GRN line price');
  assert.equal(ret.refundAmount, 60);

  // The bill covers the 7 accepted units only; record the payable now.
  const ledgerBefore = await prisma.vendorLedger.findMany({ where: { vendorId: vendor.id } });
  const payableBefore = ledgerBefore.reduce((s, r) => s + (r.type === 'CREDIT' ? r.amount : -r.amount), 0);

  // Submitting the return (with a reason) closes the PO line but must NOT
  // reduce the payable — the rejected goods were never billed.
  const done = await call(srv.base, 'PATCH', `/api/purchase/returns/${ret.id}`, tokenFor(sa), { status: 'COMPLETED', reason: 'Damaged in transit' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const ledgerAfter = await prisma.vendorLedger.findMany({ where: { vendorId: vendor.id } });
  const payableAfter = ledgerAfter.reduce((s, r) => s + (r.type === 'CREDIT' ? r.amount : -r.amount), 0);
  assert.ok(Math.abs(payableAfter - payableBefore) < 0.001, `payable unchanged (${payableBefore} -> ${payableAfter})`);
  assert.equal(await prisma.vendorLedger.count({ where: { vendorId: vendor.id, referenceType: 'RETURN' } }), 0);
  assert.equal((await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } })).status, 'RECEIVED', '7 accepted + 3 returned = 10 ordered');
  assert.equal(await auditCount('PURCHASE_RETURN', 'STATUS_COMPLETED', ret.id), 1);
});

test('C-04: a fully rejected GRN also gets its server-generated return', async () => {
  const po = await newPO({ qty: 5 });
  const grn = await GRNService.createFromPO(po.id, {
    items: [{ materialId: material.id, orderedQty: 5, receivedQty: 5, acceptedQty: 0, rejectedQty: 5, price: 20 }],
  });
  await GRNService.approve(grn.id, { userId: sa.id, role: 'SUPER_ADMIN' }, { rejectionReason: 'Spoiled' });
  const ret = await prisma.purchaseReturn.findUniqueOrThrow({ where: { goodsReceiptId: grn.id }, include: { items: true } });
  assert.equal(ret.items[0].quantity, 5);
  assert.match(ret.reason, /GRN FULL REJECTION: Spoiled/);
});

test('C-05: cancelling a PO requires a reason and posts NOTHING to the vendor ledger', async () => {
  const po = await newPO();
  const before = await vendorLedgerCount();
  const noReason = await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/cancel`, tokenFor(sa), {});
  assert.equal(noReason.status, 400);
  const ok = await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/cancel`, tokenFor(sa), { reason: 'Vendor cannot supply' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await vendorLedgerCount(), before, 'old code wrote a phantom CREDIT of the full PO value');
  const saved = await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } });
  assert.equal(saved.status, 'CANCELLED');
  assert.equal(saved.cancelReason, 'Vendor cannot supply');
  assert.ok(saved.cancelledAt);
  assert.equal(await auditCount('PURCHASE_ORDER', 'CANCELLED', po.id), 1);
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/cancel`, tokenFor(sa), { reason: 'again' })).status, 409);
});

test('C-05: a PO with an approved receipt cannot be cancelled; pending GRNs are cancelled with the PO', async () => {
  const received = await newPO({ qty: 10 });
  const grn = await GRNService.createFromPO(received.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 4, acceptedQty: 4, rejectedQty: 0, price: 20, expDate: exp }] });
  await GRNService.approve(grn.id, { userId: sa.id, role: 'SUPER_ADMIN' });
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${received.id}/cancel`, tokenFor(sa), { reason: 'Partial only' })).status, 409);

  const pendingPo = await newPO({ qty: 10 });
  const pendingGrn = await GRNService.createFromPO(pendingPo.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 2, acceptedQty: 2, rejectedQty: 0, price: 20, expDate: exp }] });
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${pendingPo.id}/cancel`, tokenFor(sa), { reason: 'Supplier closed' })).status, 200);
  assert.equal((await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: pendingGrn.id } })).status, 'CANCELLED');
});

test('C-05: advance paid on a cancelled PO stays as vendor credit (no ledger rewrite)', async () => {
  // Fresh vendor: no bills, so its whole position is the advance.
  const v2 = await prisma.vendor.create({ data: { name: `Vendor ${uid()}`, contact: '0', status: 'ACTIVE', state: 'Kerala' } });
  const acct = await createAccount(null, 10_000);
  const po = await newPO({ advancePaid: 100, accountId: acct.id, vendorId: v2.id });
  const before = await prisma.vendorLedger.findMany({ where: { vendorId: v2.id } });
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/cancel`, tokenFor(sa), { reason: 'Changed supplier' })).status, 200);
  const after = await prisma.vendorLedger.findMany({ where: { vendorId: v2.id } });
  assert.equal(after.length, before.length, 'no ledger rows written by cancel');
  assert.equal(await ProcurementService.getAvailableAdvance(v2.id), 100, 'advance released back to available vendor credit');
});

test('C-05: only an untouched Draft PO can be hard-deleted', async () => {
  const approved = await newPO();
  assert.equal((await call(srv.base, 'DELETE', `/api/purchase-orders/${approved.id}`, tokenFor(sa))).status, 409);
  assert.ok(await prisma.procurementOrder.findUnique({ where: { id: approved.id } }));

  const draft = await newPO({ status: 'DRAFT' });
  const before = await vendorLedgerCount();
  assert.equal((await call(srv.base, 'DELETE', `/api/purchase-orders/${draft.id}`, tokenFor(sa))).status, 200);
  assert.equal(await prisma.procurementOrder.findUnique({ where: { id: draft.id } }), null);
  assert.equal(await vendorLedgerCount(), before);
  assert.equal(await auditCount('PURCHASE_ORDER', 'DELETED', draft.id), 1);
});
