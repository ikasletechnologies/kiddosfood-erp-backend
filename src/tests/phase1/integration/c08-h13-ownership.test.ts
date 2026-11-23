// Audit C-08 + H-13: franchise admins cannot adjust/read other tenants'
// inventory, cannot cancel other tenants' payments/invoices/expenses, cannot
// move money through other tenants' accounts; invalid amounts are rejected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestDatabase, ensureHq, createFranchise, createUser, tokenFor, startServer, call, createStockedItem, createAccount, balanceOf, auditCount, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { InventoryService } from '../../../modules/inventory/inventory.service';
import { FinanceService } from '../../../modules/finance/finance.service';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let hq: any, sa: any, faA: any, franchiseA: any, franchiseB: any;
let hqItem: any, itemA: any, itemB: any;
let acctA1: any, acctA2: any, acctB: any, acctHq: any;

before(async () => {
  hq = await ensureHq();
  franchiseA = await createFranchise('A');
  franchiseB = await createFranchise('B');
  sa = await createUser('SUPER_ADMIN', null);
  faA = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  hqItem = await createStockedItem({ franchiseId: null, qty: 50 });
  itemA = await createStockedItem({ franchiseId: franchiseA.id, qty: 20 });
  itemB = await createStockedItem({ franchiseId: franchiseB.id, qty: 30 });
  acctA1 = await createAccount(franchiseA.id, 1000);
  acctA2 = await createAccount(franchiseA.id, 0);
  acctB = await createAccount(franchiseB.id, 1000);
  acctHq = await createAccount(hq.id, 5000);
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const adjust = (token: string, itemId: string, newQuantity: unknown) => call(srv.base, 'POST', '/api/inventory/adjustment', token, { itemId, newQuantity, unit: 'PC', note: 'count' });

test('C-08: franchise admin cannot adjust HQ or another franchise\'s stock', async () => {
  assert.equal((await adjust(tokenFor(faA), hqItem.id, 0)).status, 403);
  assert.equal((await adjust(tokenFor(faA), itemB.id, 999)).status, 403);
  assert.equal(await InventoryService.computeStock(hqItem.id), 50);
  assert.equal(await InventoryService.computeStock(itemB.id), 30);
});

test('C-08: negative / NaN / non-numeric counts are rejected', async () => {
  for (const bad of [-5, 'abc', null, '', 'NaN', {}]) {
    const res = await adjust(tokenFor(faA), itemA.id, bad);
    assert.equal(res.status, 400, `newQuantity=${JSON.stringify(bad)}`);
  }
  assert.equal(await InventoryService.computeStock(itemA.id), 20);
});

test('C-08: own-item adjustment works and is audited; HQ may adjust any item', async () => {
  const res = await adjust(tokenFor(faA), itemA.id, 7);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await InventoryService.computeStock(itemA.id), 7);
  assert.equal(await auditCount('INVENTORY', 'STOCK_ADJUSTMENT', itemA.id), 1);
  assert.equal((await adjust(tokenFor(sa), itemB.id, 31)).status, 200);
  assert.equal(await InventoryService.computeStock(itemB.id), 31);
});

test('C-08: franchise admin cannot read another tenant\'s inventory item', async () => {
  assert.equal((await call(srv.base, 'GET', `/api/inventory/items/${hqItem.id}`, tokenFor(faA))).status, 403);
  assert.equal((await call(srv.base, 'GET', `/api/inventory/items/${itemA.id}`, tokenFor(faA))).status, 200);
});

const transfer = (token: string, body: any) => call(srv.base, 'POST', '/api/accounting/transfers', token, body);

test('H-13: transfer amount must be a positive number; accounts must differ', async () => {
  for (const amount of [-100, 0, 'abc', null, 'NaN']) {
    const res = await transfer(tokenFor(faA), { fromAccountId: acctA1.id, toAccountId: acctA2.id, amount });
    assert.equal(res.status, 400, `amount=${JSON.stringify(amount)}`);
  }
  assert.equal((await transfer(tokenFor(faA), { fromAccountId: acctA1.id, toAccountId: acctA1.id, amount: 10 })).status, 400);
  assert.equal(await balanceOf(acctA1.id), 1000);
  assert.equal(await balanceOf(acctA2.id), 0);
});

test('H-13: franchise admin cannot move money through HQ or another franchise\'s accounts', async () => {
  assert.equal((await transfer(tokenFor(faA), { fromAccountId: acctHq.id, toAccountId: acctA1.id, amount: 100 })).status, 403);
  assert.equal((await transfer(tokenFor(faA), { fromAccountId: acctA1.id, toAccountId: acctB.id, amount: 100 })).status, 403);
  // Even HQ may not "transfer" between different owners.
  assert.equal((await transfer(tokenFor(sa), { fromAccountId: acctHq.id, toAccountId: acctA1.id, amount: 100 })).status, 403);
  assert.equal(await balanceOf(acctHq.id), 5000);
  assert.equal(await balanceOf(acctB.id), 1000);
});

test('H-13: valid transfer moves money atomically with persisted flows; overdraft refused', async () => {
  const ok = await transfer(tokenFor(faA), { fromAccountId: acctA1.id, toAccountId: acctA2.id, amount: 250, note: 'float' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await balanceOf(acctA1.id), 750);
  assert.equal(await balanceOf(acctA2.id), 250);
  const legs = await prisma.payment.findMany({ where: { paymentNumber: { in: [ok.body.paymentNumber, `${ok.body.paymentNumber}-IN`] } } });
  assert.deepEqual(legs.map(l => l.flow).sort(), ['IN', 'OUT']);
  assert.equal(await auditCount('FINANCE', 'FUND_TRANSFER', ok.body.paymentNumber), 1);

  assert.equal((await transfer(tokenFor(faA), { fromAccountId: acctA2.id, toAccountId: acctA1.id, amount: 10_000 })).status, 400);
  assert.equal(await balanceOf(acctA2.id), 250);
});

test('H-13: franchise admin cannot cancel HQ payments, other franchises\' expenses or invoices', async () => {
  const hqPayment = await FinanceService.createPayment({ amount: 100, flow: 'IN', status: 'PAID', sourceAccount: acctHq.id, method: 'CASH', sourceModule: 'POS', entityType: 'CUSTOMER_WALKIN' });
  const res = await call(srv.base, 'POST', `/api/accounting/payments/${hqPayment.id}/cancel`, tokenFor(faA), { reason: 'x' });
  assert.equal(res.status, 403);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: hqPayment.id } })).isCancelled, false);

  const expenseB = await prisma.expense.create({ data: { franchiseId: franchiseB.id, category: 'Rent', amount: 500, status: 'UNPAID' } });
  assert.equal((await call(srv.base, 'DELETE', `/api/accounting/expenses/${expenseB.id}`, tokenFor(faA))).status, 403);
  assert.equal((await prisma.expense.findUniqueOrThrow({ where: { id: expenseB.id } })).isCancelled, false);

  const orderB = await prisma.order.create({ data: { invoiceNum: `INV-T-${uid()}`, franchiseId: franchiseB.id, subTotal: 100, taxAmount: 0, totalAmount: 100, paymentStatus: 'UNPAID' } });
  const invoiceB = await prisma.invoice.create({ data: { orderId: orderB.id, totalAmount: 100, taxAmount: 0, finalAmount: 100, status: 'UNPAID' } });
  assert.equal((await call(srv.base, 'POST', `/api/sales/invoices/${invoiceB.id}/cancel`, tokenFor(faA))).status, 403);
  assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceB.id } })).status, 'UNPAID');
});

test('H-13: franchise admin cannot pay out of an HQ account or against another franchise\'s invoice', async () => {
  const hqBefore = await balanceOf(acctHq.id);
  const fromHq = await call(srv.base, 'POST', '/api/accounting/payments', tokenFor(faA), { amount: 50, flow: 'OUT', sourceAccount: acctHq.id, method: 'CASH', entityType: 'OTHER' });
  assert.equal(fromHq.status, 403);
  assert.equal(await balanceOf(acctHq.id), hqBefore);

  const orderB = await prisma.order.create({ data: { invoiceNum: `INV-T-${uid()}`, franchiseId: franchiseB.id, subTotal: 80, taxAmount: 0, totalAmount: 80, paymentStatus: 'UNPAID' } });
  const invoiceB = await prisma.invoice.create({ data: { orderId: orderB.id, totalAmount: 80, taxAmount: 0, finalAmount: 80, status: 'UNPAID' } });
  const againstB = await call(srv.base, 'POST', '/api/accounting/payments', tokenFor(faA), { amount: 80, flow: 'IN', sourceAccount: acctA1.id, method: 'CASH', invoiceId: invoiceB.id, entityType: 'CUSTOMER' });
  assert.equal(againstB.status, 403);
});
