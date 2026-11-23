// Audit C-07: payment cancellation reverses exactly what the payment did —
// using the persisted flow — across cash/bank, vendor/customer/franchise
// ledgers and every linked document's paid status; transactional, idempotent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { requireTestDatabase, ensureHq, createFranchise, createUser, tokenFor, startServer, call, createAccount, balanceOf, auditCount, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { FinanceService } from '../../../modules/finance/finance.service';
import { ProcurementService } from '../../../modules/procurement/procurement.service';
import { FranchiseOrderService } from '../../../modules/franchise/franchise-order.service';
import { inferLegacyPaymentFlow } from '../../../modules/finance/payment-flow';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let hq: any, sa: any, faA: any, franchiseA: any, vendor: any;

before(async () => {
  hq = await ensureHq();
  franchiseA = await createFranchise('A');
  sa = await createUser('SUPER_ADMIN', null);
  faA = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  vendor = await prisma.vendor.create({ data: { name: `Vendor ${uid()}`, contact: '0', status: 'ACTIVE' } });
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const cancel = (token: string, id: string) => call(srv.base, 'POST', `/api/accounting/payments/${id}/cancel`, token, { reason: 'test reversal' });
const vendorNet = async (paymentId: string) => (await prisma.vendorLedger.findMany({ where: { referenceId: paymentId } }))
  .reduce((s, r) => s + (r.type === 'CREDIT' ? r.amount : -r.amount), 0);
const vendorBalance = async (vendorId: string) => (await prisma.vendorLedger.findMany({ where: { vendorId } }))
  .reduce((s, r) => s + (r.type === 'CREDIT' ? r.amount : -r.amount), 0);

test('vendor REFUND (money IN) is reversed by taking the money back out — old code doubled it', async () => {
  const acct = await createAccount(hq.id, 1000);
  const refund = await FinanceService.createPayment({ amount: 500, flow: 'IN', type: 'REFUND', status: 'PAID', sourceAccount: acct.id, method: 'CASH', sourceModule: 'PROCUREMENT', entityType: 'VENDOR', entityId: vendor.id });
  assert.equal(refund.flow, 'IN');
  assert.equal(await balanceOf(acct.id), 1500);
  const ledgerBefore = await vendorBalance(vendor.id);

  const res = await cancel(tokenFor(sa), refund.id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await balanceOf(acct.id), 1000, 'old code left this at 2000');
  assert.ok(Math.abs(await vendorNet(refund.id)) < 0.001, 'vendor ledger rows for the payment net to zero');
  assert.ok(Math.abs((await vendorBalance(vendor.id)) - (ledgerBefore - 500)) < 0.001);
  const reversal = await prisma.payment.findFirstOrThrow({ where: { reversalOfPaymentId: refund.id, type: 'REVERSAL' } });
  assert.equal(reversal.flow, 'OUT');
  assert.equal(await auditCount('FINANCE', 'PAYMENT_CANCELLED', refund.id), 1);
});

test('vendor bill payment cancel restores cash, reverses the vendor ledger and reopens bill + PO', async () => {
  const acct = await createAccount(hq.id, 1000);
  const po = await prisma.procurementOrder.create({ data: { vendorId: vendor.id, totalAmount: 300, status: 'RECEIVED', poNumber: `PO-T-${uid()}` } });
  const bill = await prisma.vendorInvoice.create({ data: { vendorId: vendor.id, poId: po.id, invoiceNumber: `BILL-T-${uid()}`, amount: 300, status: 'PENDING' } });
  const payment: any = await ProcurementService.recordPayment(vendor.id, { amount: 300, note: 'pay bill', accountId: acct.id, vendorInvoiceId: bill.id, paymentMode: 'CASH' });
  assert.equal(payment.flow, 'OUT');
  assert.equal(await balanceOf(acct.id), 700);
  assert.equal((await prisma.vendorInvoice.findUniqueOrThrow({ where: { id: bill.id } })).status, 'PAID');
  const poPaid = (await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } })).paid;
  assert.equal(poPaid, 300);

  const res = await cancel(tokenFor(sa), payment.id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await balanceOf(acct.id), 1000);
  assert.ok(Math.abs(await vendorNet(payment.id)) < 0.001, 'old code never reversed the vendor ledger');
  assert.equal((await prisma.vendorInvoice.findUniqueOrThrow({ where: { id: bill.id } })).status, 'PENDING');
  const poAfter = await prisma.procurementOrder.findUniqueOrThrow({ where: { id: po.id } });
  assert.equal(poAfter.paid, 0);
  assert.equal(poAfter.balance, 300);
});

test('customer invoice payment cancel reopens the invoice and order, reverses customer ledger', async () => {
  const acct = await createAccount(hq.id, 0);
  const customer = await prisma.customer.create({ data: { name: `Cust ${uid()}` } });
  const order = await prisma.order.create({ data: { invoiceNum: `INV-T-${uid()}`, franchiseId: hq.id, customerId: customer.id, partyType: 'CUSTOMER', partyId: customer.id, subTotal: 400, taxAmount: 0, totalAmount: 400, paymentStatus: 'UNPAID' } });
  const invoice = await prisma.invoice.create({ data: { orderId: order.id, totalAmount: 400, taxAmount: 0, finalAmount: 400, status: 'UNPAID' } });
  const payment = await FinanceService.createPayment({ amount: 400, flow: 'IN', status: 'PAID', sourceAccount: acct.id, method: 'CASH', sourceModule: 'POS', entityType: 'CUSTOMER', entityId: customer.id, invoiceId: invoice.id });
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, 'PAID');

  const res = await cancel(tokenFor(sa), payment.id);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await balanceOf(acct.id), 0);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status, 'UNPAID');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus, 'UNPAID');
  const custRows = await prisma.customerLedger.findMany({ where: { referenceId: payment.id } });
  assert.ok(Math.abs(custRows.reduce((s, r) => s + (r.type === 'DEBIT' ? r.amount : -r.amount), 0)) < 0.001);
});

test('payroll payment (OUT, EMPLOYEE) cancel puts the money back — old code took it out again', async () => {
  const acct = await createAccount(hq.id, 1000);
  const salary = await FinanceService.createPayment({ amount: 250, flow: 'OUT', status: 'PAID', sourceAccount: acct.id, method: 'CASH', sourceModule: 'PAYROLL', linkedDocType: 'PAYSLIP', linkedDocId: `slip-${uid()}`, entityType: 'EMPLOYEE', entityId: `emp-${uid()}` });
  assert.equal(await balanceOf(acct.id), 750);
  assert.equal((await cancel(tokenFor(sa), salary.id)).status, 200);
  assert.equal(await balanceOf(acct.id), 1000, 'old code left this at 500');
});

test('expense payment cancel restores cash and the expense\'s paid status; expense can then be cancelled', async () => {
  const acct = await createAccount(hq.id, 1000);
  const expense = await FinanceService.addExpense({ franchiseId: hq.id, category: 'Rent', amount: 200 });
  await FinanceService.recordExpensePayment(expense.id, { amount: 200, accountId: acct.id, paymentMode: 'CASH' });
  assert.equal((await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } })).status, 'PAID');
  // An expense with money paid against it cannot be cancelled directly.
  assert.equal((await call(srv.base, 'DELETE', `/api/accounting/expenses/${expense.id}`, tokenFor(sa))).status, 400);

  const pay = await prisma.payment.findFirstOrThrow({ where: { linkedDocType: 'EXPENSE_BILL', linkedDocId: expense.id } });
  assert.equal((await cancel(tokenFor(sa), pay.id)).status, 200);
  assert.equal(await balanceOf(acct.id), 1000);
  const exp = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
  assert.equal(exp.paidAmount, 0);
  assert.equal(exp.status, 'UNPAID');
  assert.equal((await call(srv.base, 'DELETE', `/api/accounting/expenses/${expense.id}`, tokenFor(sa))).status, 200);
});

test('franchise payment cancel restores the franchise account, ledger and order status; HQ-confirmed ones are HQ-only', async () => {
  const sku = `FG-${uid()}`;
  const product = await prisma.product.create({ data: { name: `P ${sku}`, sku, basePrice: 50, isActive: true } });
  const fAcct = await createAccount(franchiseA.id, 1000);
  const hqAcct = await createAccount(hq.id, 0);
  const order = await FranchiseOrderService.createOrder({ franchiseId: franchiseA.id, orderType: 'REQUEST', items: [{ productId: product.id, quantity: 2 }] });
  const outstanding = async () => (await prisma.franchise.findUniqueOrThrow({ where: { id: franchiseA.id } })).outstandingAmount || 0;

  const owedBefore = await outstanding();
  await FranchiseOrderService.recordPayment(order.id, 100, fAcct.id, 'FA', false);
  assert.equal(await balanceOf(fAcct.id), 900);
  const p1 = await prisma.payment.findFirstOrThrow({ where: { linkedDocId: order.orderNumber, isCancelled: false } });
  assert.equal(p1.flow, 'OUT');

  const r1 = await cancel(tokenFor(faA), p1.id);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(await balanceOf(fAcct.id), 1000, 'old code skipped SUCCESS-status payments entirely');
  assert.ok(Math.abs((await outstanding()) - owedBefore) < 0.001, 'franchise owes the full amount again');
  assert.equal((await prisma.franchiseOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus, 'UNPAID');

  // Paid again, then HQ confirms receipt into an HQ account.
  await FranchiseOrderService.recordPayment(order.id, 100, fAcct.id, 'FA', false);
  await FranchiseOrderService.recordPayment(order.id, undefined, hqAcct.id, 'HQ', true);
  assert.equal(await balanceOf(hqAcct.id), 100);
  const p2 = await prisma.payment.findFirstOrThrow({ where: { linkedDocId: order.orderNumber, isCancelled: false, type: { not: 'REVERSAL' } } });
  assert.equal((await cancel(tokenFor(faA), p2.id)).status, 403, 'franchise cannot undo an HQ-confirmed receipt');
  assert.equal((await cancel(tokenFor(sa), p2.id)).status, 200);
  assert.equal(await balanceOf(fAcct.id), 1000);
  assert.equal(await balanceOf(hqAcct.id), 0, 'HQ inflow reversed too');
});

test('cancelling either leg of an internal transfer cancels both and restores both accounts', async () => {
  const a = await createAccount(hq.id, 1000);
  const b = await createAccount(hq.id, 0);
  const t = await FinanceService.transferFunds({ fromAccountId: a.id, toAccountId: b.id, amount: 400, actor: { userId: sa.id, role: 'SUPER_ADMIN', franchiseId: null } });
  const inLeg = await prisma.payment.findUniqueOrThrow({ where: { paymentNumber: `${t.paymentNumber}-IN` } });
  assert.equal((await cancel(tokenFor(sa), inLeg.id)).status, 200);
  assert.equal(await balanceOf(a.id), 1000);
  assert.equal(await balanceOf(b.id), 0);
  const legs = await prisma.payment.findMany({ where: { paymentNumber: { in: [t.paymentNumber, `${t.paymentNumber}-IN`] } } });
  assert.ok(legs.every(l => l.isCancelled));
});

test('cancelling both transfer legs concurrently neither deadlocks nor double-reverses', async () => {
  const a = await createAccount(hq.id, 1000);
  const b = await createAccount(hq.id, 0);
  const t = await FinanceService.transferFunds({ fromAccountId: a.id, toAccountId: b.id, amount: 300, actor: { userId: sa.id, role: 'SUPER_ADMIN', franchiseId: null } });
  const legs = await prisma.payment.findMany({ where: { paymentNumber: { in: [t.paymentNumber, `${t.paymentNumber}-IN`] } } });
  const results = await Promise.all(legs.map(l => cancel(tokenFor(sa), l.id)));
  assert.deepEqual(results.map(r => r.status), [200, 200], JSON.stringify(results.map(r => r.body)));
  assert.equal(results.filter(r => r.body.alreadyCancelled).length, 1);
  assert.equal(await balanceOf(a.id), 1000);
  assert.equal(await balanceOf(b.id), 0);
});

test('idempotent: repeated and concurrent cancels reverse only once', async () => {
  const acct = await createAccount(hq.id, 1000);
  const p = await FinanceService.createPayment({ amount: 100, flow: 'OUT', status: 'PAID', sourceAccount: acct.id, method: 'CASH', sourceModule: 'EXPENSE', entityType: 'OTHER' });
  const [x, y] = await Promise.all([cancel(tokenFor(sa), p.id), cancel(tokenFor(sa), p.id)]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.equal([x.body.alreadyCancelled, y.body.alreadyCancelled].filter(Boolean).length, 1);
  assert.equal(await balanceOf(acct.id), 1000);
  const again = await cancel(tokenFor(sa), p.id);
  assert.equal(again.body.alreadyCancelled, true);
  assert.equal(await balanceOf(acct.id), 1000);
  assert.equal(await prisma.payment.count({ where: { reversalOfPaymentId: p.id, type: 'REVERSAL' } }), 1);
});

test('transactional: an unreversible receipt (account already spent) changes nothing', async () => {
  const acct = await createAccount(hq.id, 0);
  const p = await FinanceService.createPayment({ amount: 300, flow: 'IN', status: 'PAID', sourceAccount: acct.id, method: 'CASH', sourceModule: 'POS', entityType: 'CUSTOMER_WALKIN' });
  await prisma.account.update({ where: { id: acct.id }, data: { balance: 100 } });
  const res = await cancel(tokenFor(sa), p.id);
  assert.equal(res.status, 409);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).isCancelled, false);
  assert.equal(await balanceOf(acct.id), 100);
  assert.equal(await prisma.payment.count({ where: { reversalOfPaymentId: p.id } }), 0);
});

test('legacy payment with no classifiable direction is refused, never guessed', async () => {
  const acct = await createAccount(hq.id, 1000);
  const legacy = await prisma.payment.create({ data: { paidAmount: 50, status: 'PAID', accountId: acct.id, sourceModule: 'MANUAL', type: 'DIRECT', entityType: 'VENDOR', paymentNumber: `LEG-${uid()}` } });
  const res = await cancel(tokenFor(sa), legacy.id);
  assert.equal(res.status, 409);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: legacy.id } })).isCancelled, false);
  assert.equal(await balanceOf(acct.id), 1000);
});

test('migration backfill SQL classifies legacy rows exactly like inferLegacyPaymentFlow()', async () => {
  const shapes = [
    { sourceModule: 'PROCUREMENT', type: 'REFUND', entityType: 'VENDOR' },
    { sourceModule: 'PROCUREMENT', type: 'INVOICE_LINKED', entityType: 'VENDOR' },
    { sourceModule: 'PAYROLL', type: 'DIRECT', entityType: 'EMPLOYEE' },
    { sourceModule: 'EXPENSE', type: 'DIRECT', entityType: 'VENDOR' },
    { sourceModule: 'FRANCHISE', type: 'INVOICE_LINKED', entityType: 'FRANCHISE' },
    { sourceModule: 'POS', type: 'INVOICE_LINKED', entityType: 'CUSTOMER' },
    { sourceModule: 'POS', type: 'DIRECT', entityType: 'VENDOR' },
    { sourceModule: 'TRANSFER', type: 'INTERNAL_TRANSFER', entityType: 'ACCOUNT', suffix: '-IN' },
    { sourceModule: 'TRANSFER', type: 'INTERNAL_TRANSFER', entityType: 'ACCOUNT' },
    { sourceModule: 'MANUAL', type: 'DIRECT', entityType: 'CENTRAL_WAREHOUSE' },
    { sourceModule: 'MANUAL', type: 'DIRECT', entityType: 'VENDOR' },
    { sourceModule: 'POS', type: 'REVERSAL', entityType: 'CUSTOMER' },
  ] as const;
  const rows: any[] = [];
  for (const s of shapes) {
    rows.push(await prisma.payment.create({ data: { paidAmount: 1, status: 'PAID', sourceModule: s.sourceModule as any, type: s.type as any, entityType: s.entityType, paymentNumber: `BF-${uid()}${(s as any).suffix || ''}` } }));
  }
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../../prisma/migrations/20261123090000_phase1_safety/migration.sql'), 'utf8');
  const update = sql.slice(sql.indexOf('UPDATE "Payment"'), sql.indexOf('WHERE "flow" IS NULL;') + 'WHERE "flow" IS NULL;'.length);
  await prisma.$executeRawUnsafe(update.replace('WHERE "flow" IS NULL;', `WHERE "flow" IS NULL AND id IN (${rows.map(r => `'${r.id}'`).join(',')});`));
  for (const r of rows) {
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(after.flow ?? null, inferLegacyPaymentFlow(r), `${r.sourceModule}/${r.type}/${r.entityType}/${r.paymentNumber}`);
  }
});
