// Remaining-risk fixes (after Phase 1): H-04 PO advance, advance reservation,
// F-03 short-close, M-01 GRN cancel, H-07 invoice cancel stock/source docs,
// H-08 legacy POS/KDS order routes, payment backdating, default passwords.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestDatabase, ensureHq, createFranchise, createUser, tokenFor, startServer, call, createStockedItem, createAccount, balanceOf, auditCount, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { ProcurementService } from '../../../modules/procurement/procurement.service';
import { GRNService } from '../../../modules/grn/grn.service';
import { InventoryService } from '../../../modules/inventory/inventory.service';
import { POSService } from '../../../modules/pos/pos.service';
import { FinanceService, resolvePaymentDate, PAYMENT_BACKDATE_MAX_DAYS } from '../../../modules/finance/finance.service';
import { EmployeeService } from '../../../modules/employee/employee.service';
import { FranchiseService } from '../../../modules/franchise/franchise.service';
import { purchaseBusinessDate } from '../../../modules/procurement/purchase-dates';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let hq: any, sa: any, faA: any, faB: any, franchiseA: any, franchiseB: any, material: any;

before(async () => {
  hq = await ensureHq();
  franchiseA = await createFranchise('A');
  franchiseB = await createFranchise('B');
  sa = await createUser('SUPER_ADMIN', null);
  faA = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  faB = await createUser('FRANCHISE_ADMIN', franchiseB.id);
  material = await createStockedItem({ franchiseId: null, qty: 0, category: 'RAW_MATERIAL' });
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const newVendor = () => prisma.vendor.create({ data: { name: `Vendor ${uid()}`, contact: '0', status: 'ACTIVE', state: 'Kerala' } });
const newPO = (vendorId: string, opts: { qty?: number; advancePaid?: number; accountId?: string } = {}) => ProcurementService.createPurchaseOrder({
  vendorId,
  expectedDeliveryDate: purchaseBusinessDate(),
  advancePaid: opts.advancePaid,
  accountId: opts.accountId,
  items: [{ inventoryItemId: material.id, quantity: opts.qty ?? 10, price: 20, gstRate: 5, unit: 'PC' }],
});
const exp = new Date(Date.now() + 90 * 86400000).toISOString();

// ── H-04 + advance reservation ──────────────────────────────────────────────

test('advance paid at PO creation is reserved against that PO until it is cancelled', async () => {
  const v = await newVendor();
  const acct = await createAccount(hq.id, 10_000);
  const po = await newPO(v.id, { advancePaid: 100, accountId: acct.id });
  assert.equal(po.advanceApplied, 100);
  assert.equal(await ProcurementService.getAvailableAdvance(v.id), 0, 'not offered to other POs while open');
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/cancel`, tokenFor(sa), { reason: 'Supplier switch' })).status, 200);
  assert.equal(await ProcurementService.getAvailableAdvance(v.id), 100, 'released on cancel');
});

test('H-04: recording an advance moves real money, reserves it, and is bounded', async () => {
  const v = await newVendor();
  const acct = await createAccount(hq.id, 1000);
  const po = await newPO(v.id, { qty: 10 }); // total 210 incl. 5% GST

  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/advance`, tokenFor(sa), { amount: 50 })).status, 400, 'account required');
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/advance`, tokenFor(sa), { amount: -5, accountId: acct.id })).status, 400);
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/advance`, tokenFor(sa), { amount: 999, accountId: acct.id })).status, 400, 'more than unpaid');

  const ok = await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/advance`, tokenFor(sa), { amount: 80, accountId: acct.id, paymentMode: 'CASH' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await balanceOf(acct.id), 920, 'old code moved no cash at all');
  const saved = await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } });
  assert.equal(saved.advancePaid, 80);
  assert.equal(saved.advanceApplied, 80);
  const payment = await prisma.payment.findFirstOrThrow({ where: { linkedDocType: 'PO', linkedDocId: po.id, type: 'ADVANCE' } });
  assert.equal(payment.flow, 'OUT');
  assert.equal(await auditCount('PURCHASE_ORDER', 'ADVANCE_RECORDED', po.id), 1);

  // Cancelling the advance payment restores cash and the reservation.
  assert.equal((await call(srv.base, 'POST', `/api/accounting/payments/${payment.id}/cancel`, tokenFor(sa), { reason: 'wrong PO' })).status, 200);
  assert.equal(await balanceOf(acct.id), 1000);
  const after = await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } });
  assert.equal(after.advancePaid, 0);
  assert.equal(after.advanceApplied, 0);

  // Not on a cancelled PO.
  await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/cancel`, tokenFor(sa), { reason: 'done' });
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/advance`, tokenFor(sa), { amount: 10, accountId: acct.id })).status, 409);
});

// ── F-03 short-close ────────────────────────────────────────────────────────

test('F-03: a partially received PO can be short-closed (reason required); nothing more can be received', async () => {
  const v = await newVendor();
  const po = await newPO(v.id, { qty: 10 });
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/short-close`, tokenFor(sa), { reason: 'Nothing yet' })).status, 409, 'no receipt yet -> cancel instead');

  const grn = await GRNService.createFromPO(po.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 6, acceptedQty: 6, rejectedQty: 0, price: 20, expDate: exp }] });
  await GRNService.approve(grn.id, { userId: sa.id, role: 'SUPER_ADMIN' });
  const pending = await GRNService.createFromPO(po.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 2, acceptedQty: 2, rejectedQty: 0, price: 20, expDate: exp }] });
  const ledgerBefore = await prisma.vendorLedger.count({ where: { vendorId: v.id } });

  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/short-close`, tokenFor(sa), {})).status, 400);
  const ok = await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/short-close`, tokenFor(sa), { reason: 'Vendor out of stock' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } });
  assert.equal(saved.status, 'RECEIVED');
  assert.equal(saved.shortCloseReason, 'Vendor out of stock');
  assert.ok(saved.shortClosedAt);
  assert.equal((await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: pending.id } })).status, 'CANCELLED');
  assert.equal(await prisma.vendorLedger.count({ where: { vendorId: v.id } }), ledgerBefore, 'no ledger posting');
  assert.equal(await auditCount('PURCHASE_ORDER', 'SHORT_CLOSED', po.id), 1);
  assert.equal((await call(srv.base, 'PATCH', `/api/purchase-orders/${po.id}/short-close`, tokenFor(sa), { reason: 'again' })).status, 409);
  await assert.rejects(() => GRNService.createFromPO(po.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 1, acceptedQty: 1, rejectedQty: 0, price: 20, expDate: exp }] }));
});

// ── M-01 GRN cancel ─────────────────────────────────────────────────────────

test('M-01: GRN cancel needs a reason, never touches an approved GRN, and cannot race an approval', async () => {
  const v = await newVendor();
  const po = await newPO(v.id, { qty: 10 });
  const g1 = await GRNService.createFromPO(po.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 3, acceptedQty: 3, rejectedQty: 0, price: 20, expDate: exp }] });
  assert.equal((await call(srv.base, 'PATCH', `/api/grn/${g1.id}/cancel`, tokenFor(sa), {})).status, 400);
  assert.equal((await call(srv.base, 'PATCH', `/api/grn/${g1.id}/cancel`, tokenFor(sa), { reason: 'Wrong vehicle' })).status, 200);
  assert.equal(await auditCount('GRN', 'CANCELLED', g1.id), 1);

  const g2 = await GRNService.createFromPO(po.id, { items: [{ materialId: material.id, orderedQty: 10, receivedQty: 4, acceptedQty: 4, rejectedQty: 0, price: 20, expDate: exp }] });
  const [approved, cancelled] = await Promise.allSettled([
    GRNService.approve(g2.id, { userId: sa.id, role: 'SUPER_ADMIN' }),
    GRNService.cancel(g2.id, { reason: 'race', actor: { userId: sa.id } }),
  ]);
  const final = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: g2.id } });
  const lots = await prisma.inventoryBatch.count({ where: { goodsReceiptItem: { grnId: g2.id } } });
  // Exactly one wins, and the state matches what was posted.
  assert.ok((approved.status === 'fulfilled') !== (cancelled.status === 'fulfilled'), 'exactly one of approve/cancel succeeds');
  if (final.status === 'COMPLETED') assert.ok(lots > 0); else { assert.equal(final.status, 'CANCELLED'); assert.equal(lots, 0); }
  if (final.status === 'COMPLETED') {
    assert.equal((await call(srv.base, 'PATCH', `/api/grn/${g2.id}/cancel`, tokenFor(sa), { reason: 'too late' })).status, 409);
  }
});

// ── H-07 invoice cancel ─────────────────────────────────────────────────────

async function invoicedSale(opts: { franchiseId: string; qty: number }) {
  const item = await createStockedItem({ franchiseId: null, qty: 20, category: 'FINISHED_GOOD' });
  const product = await prisma.product.create({ data: { name: `P ${uid()}`, sku: item.sku, basePrice: 50 } });
  const so = await prisma.salesOrder.create({ data: { orderNumber: `SO-T-${uid()}`, status: 'DELIVERED', subTotal: 100, taxAmount: 0, totalAmount: 100 } });
  const order = await prisma.order.create({ data: { invoiceNum: `INV-T-${uid()}`, franchiseId: opts.franchiseId, subTotal: 100, taxAmount: 0, totalAmount: 100, paymentStatus: 'UNPAID', sourceSalesOrderId: so.id, orderItems: { create: [{ productId: product.id, quantity: opts.qty, price: 50 }] } } });
  await prisma.salesOrder.update({ where: { id: so.id }, data: { convertedInvoiceId: order.id } });
  const invoice = await prisma.invoice.create({ data: { orderId: order.id, totalAmount: 100, taxAmount: 0, finalAmount: 100, status: 'UNPAID' } });
  await prisma.$transaction(tx => InventoryService.recordMovement(tx, { itemId: item.id, type: 'SALES_OUT', quantity: -opts.qty, referenceType: 'ORDER', referenceId: order.id, note: 'test sale' }));
  return { item, so, order, invoice };
}

test('H-07: cancelling an invoice restores stock to the original lot and reopens its Sales Order', async () => {
  const { item, so, order, invoice } = await invoicedSale({ franchiseId: hq.id, qty: 5 });
  const lot = await prisma.inventoryBatch.findFirstOrThrow({ where: { inventoryItemId: item.id } });
  assert.equal(await InventoryService.computeStock(item.id), 15);
  assert.equal(lot.currentQty, 15);

  const res = await call(srv.base, 'POST', `/api/sales/invoices/${invoice.id}/cancel`, tokenFor(sa));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await InventoryService.computeStock(item.id), 20, 'old code left the 5 units deducted');
  assert.equal((await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lot.id } })).currentQty, 20, 'back on the same lot');
  const reopened = await prisma.salesOrder.findUniqueOrThrow({ where: { id: so.id } });
  assert.equal(reopened.status, 'CONFIRMED');
  assert.equal(reopened.convertedInvoiceId, null);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).sourceSalesOrderId, null, 'SO can be invoiced again');
});

test('H-07: an invoice with sales returns cannot be cancelled (no double restock)', async () => {
  const { order, invoice } = await invoicedSale({ franchiseId: hq.id, qty: 2 });
  await prisma.returnOrder.create({ data: { returnNumber: `RET-T-${uid()}`, posOrderId: order.id, reason: 'damaged', refundAmount: 50, status: 'COMPLETED' } });
  const res = await call(srv.base, 'POST', `/api/sales/invoices/${invoice.id}/cancel`, tokenFor(sa));
  assert.equal(res.status, 409);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, 'UNPAID');
});

// ── H-08 legacy POS / KDS order routes ──────────────────────────────────────

async function kitchenOrder(franchise: any, customerId?: string) {
  const sku = `POS-${uid()}`;
  await createStockedItem({ franchiseId: franchise.id, qty: 50, category: 'FINISHED_GOOD', sku });
  const product = await prisma.product.create({ data: { name: `Dosa ${sku}`, sku, basePrice: 40, taxPercent: 5 } });
  const order = await POSService.createOrder({ franchiseId: franchise.id, customerId });
  return { order, product };
}

test('H-08: order status route only allows forward kitchen progress, owner-checked, side effects once', async () => {
  const customer = await prisma.customer.create({ data: { name: `C ${uid()}` } });
  const { order, product } = await kitchenOrder(franchiseA, customer.id);
  // Client price is ignored: server price (40) applies, per-product GST.
  const added = await call(srv.base, 'POST', `/api/orders/${order.id}/items`, tokenFor(faA), { items: [{ productId: product.id, quantity: 2, price: 1 }] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.orderItems[0].price, 40);
  assert.equal(added.body.subTotal, 80);

  for (const s of ['CANCELLED', 'REFUNDED', 'PENDING']) {
    assert.equal((await call(srv.base, 'PATCH', `/api/orders/${order.id}/status`, tokenFor(faA), { status: s })).status, 400, s);
  }
  assert.equal((await call(srv.base, 'PATCH', `/api/orders/${order.id}/status`, tokenFor(faB), { status: 'PREPARING' })).status, 403, 'other franchise');
  assert.equal((await call(srv.base, 'PATCH', `/api/kds/orders/${order.id}/status`, tokenFor(faA), { status: 'PREPARING' })).status, 200);
  assert.equal((await call(srv.base, 'PATCH', `/api/orders/${order.id}/status`, tokenFor(faA), { status: 'COMPLETED' })).status, 200);
  assert.equal((await call(srv.base, 'PATCH', `/api/orders/${order.id}/status`, tokenFor(faA), { status: 'COMPLETED' })).status, 409, 'no repeat');
  assert.equal(await prisma.customerLedger.count({ where: { referenceType: 'SALE', referenceId: order.id } }), 1, 'old code posted one SALE debit per call');
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
  assert.equal(invoice.status, 'UNPAID', 'a served order is not a paid one');
  assert.equal((await call(srv.base, 'POST', `/api/orders/${order.id}/items`, tokenFor(faA), { items: [{ productId: product.id, quantity: 1 }] })).status, 409, 'completed order is closed');
});

test('H-08: completed B2B invoices cannot be altered through the POS/KDS routes', async () => {
  const order = await prisma.order.create({ data: { invoiceNum: `INV-T-${uid()}`, franchiseId: franchiseA.id, subTotal: 10, taxAmount: 0, totalAmount: 10, status: 'COMPLETED' } });
  assert.equal((await call(srv.base, 'PATCH', `/api/orders/${order.id}/status`, tokenFor(faA), { status: 'CANCELLED' })).status, 400);
  assert.equal((await call(srv.base, 'PATCH', `/api/kds/orders/${order.id}/status`, tokenFor(faA), { status: 'PREPARING' })).status, 409);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'COMPLETED');
});

test('H-08: POS payment charges only the outstanding amount, credits the customer once, refuses a repeat', async () => {
  const customer = await prisma.customer.create({ data: { name: `C ${uid()}` } });
  const { order, product } = await kitchenOrder(franchiseA, customer.id);
  await POSService.addItemsToOrder(order.id, [{ productId: product.id, quantity: 1 }]);
  const acct = await createAccount(franchiseA.id, 0);
  const otherAcct = await createAccount(franchiseB.id, 0);
  assert.equal((await call(srv.base, 'POST', `/api/orders/${order.id}/pay`, tokenFor(faA), { method: 'CASH', accountId: otherAcct.id })).status, 403, 'money into another branch');
  const paid = await call(srv.base, 'POST', `/api/orders/${order.id}/pay`, tokenFor(faA), { method: 'CASH', accountId: acct.id });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const total = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).totalAmount;
  assert.equal(await balanceOf(acct.id), total);
  const credits = await prisma.customerLedger.findMany({ where: { customerId: customer.id, type: 'CREDIT' } });
  assert.equal(credits.length, 1, 'old code wrote two CREDIT rows per payment');
  assert.equal((await call(srv.base, 'POST', `/api/orders/${order.id}/pay`, tokenFor(faA), { method: 'CASH', accountId: acct.id })).status, 409);
  assert.equal(await balanceOf(acct.id), total);
});

test('H-08: the kitchen display lists only the caller\'s own branch', async () => {
  const { order: mine } = await kitchenOrder(franchiseA);
  const { order: theirs } = await kitchenOrder(franchiseB);
  const res = await call(srv.base, 'GET', '/api/kds/orders', tokenFor(faA));
  assert.equal(res.status, 200);
  const ids = res.body.map((o: any) => o.id);
  assert.ok(ids.includes(mine.id));
  assert.ok(!ids.includes(theirs.id));
});

// ── Payment backdating ──────────────────────────────────────────────────────

test('payments cannot be future-dated or backdated beyond the limit; backdating is audited; franchises cannot backdate', async () => {
  assert.throws(() => resolvePaymentDate(new Date(Date.now() + 86400000).toISOString()), (e: any) => e.statusCode === 400);
  assert.throws(() => resolvePaymentDate(new Date(Date.now() - (PAYMENT_BACKDATE_MAX_DAYS + 1) * 86400000).toISOString()), (e: any) => e.statusCode === 400);
  assert.throws(() => resolvePaymentDate('not-a-date'), (e: any) => e.statusCode === 400);
  assert.equal(resolvePaymentDate(undefined), undefined);

  const hqAcct = await createAccount(hq.id, 0);
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
  const p = await FinanceService.createPayment({ amount: 10, flow: 'IN', status: 'PAID', sourceAccount: hqAcct.id, method: 'CASH', sourceModule: 'MANUAL', entityType: 'OTHER', createdAt: threeDaysAgo });
  assert.equal(new Date(p.createdAt).toISOString(), threeDaysAgo);
  assert.equal(await auditCount('FINANCE', 'PAYMENT_BACKDATED', p.id), 1);

  const fAcct = await createAccount(franchiseA.id, 0);
  const res = await call(srv.base, 'POST', '/api/accounting/payments', tokenFor(faA), { amount: 5, flow: 'IN', sourceAccount: fAcct.id, method: 'CASH', entityType: 'OTHER', createdAt: threeDaysAgo });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(Date.now() - new Date(res.body.createdAt).getTime() < 60_000, 'franchise payment recorded at server time');
});

// ── Default passwords ───────────────────────────────────────────────────────

test('employee logins are no longer created active with a shared password', async () => {
  const code = `EMP${uid()}`.toUpperCase();
  const emp: any = await EmployeeService.create({ fullName: 'Cook', employeeCode: code, personalEmail: `${code.toLowerCase()}@test.local` });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: emp.userId } });
  assert.equal(user.is_active, false);
  const login = await call(srv.base, 'POST', '/api/auth/login', null, { identifier: user.email, password: 'emp123' });
  assert.notEqual(login.status, 200);
  await assert.rejects(() => EmployeeService.create({ fullName: 'Cook2', employeeCode: `${code}2`, personalEmail: `${code.toLowerCase()}2@test.local`, password: 'short' }), (e: any) => e.statusCode === 400);
});

test('a franchise admin login cannot be created without a strong password (HQ path had a "franchise123" default)', async () => {
  const before = await prisma.user.count();
  for (const password of [undefined, '', 'short']) {
    await assert.rejects(
      () => FranchiseService.create({ name: `HQ ${uid()}`, location: 'X', ownerName: 'O', contactNum: '9999999999', isHQ: true, adminUser: { email: `hq-${uid()}@test.local`, password, fullName: 'HQ Admin' } } as any, sa.id),
      (e: any) => e.statusCode === 400 && /password/i.test(e.message),
      `password=${JSON.stringify(password)}`
    );
  }
  assert.equal(await prisma.user.count(), before, 'no login created');
});
