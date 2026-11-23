// Audit C-03: franchise-order lifecycle — role-gated, strictly ordered,
// row-locked transitions; no self-dispatch, no repeated dispatch/delivery, no
// cancellation after dispatch; cancellation reverses the franchise ledger.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestDatabase, ensureHq, createFranchise, createUser, tokenFor, startServer, call, createStockedItem, auditCount, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { InventoryService } from '../../../modules/inventory/inventory.service';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let sa: any, faA: any, faB: any, franchiseA: any, franchiseB: any, product: any, hqItem: any;
const QTY = 4;

before(async () => {
  await ensureHq();
  franchiseA = await createFranchise('A');
  franchiseB = await createFranchise('B');
  sa = await createUser('SUPER_ADMIN', null);
  faA = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  faB = await createUser('FRANCHISE_ADMIN', franchiseB.id);
  const sku = `FG-${uid()}`;
  product = await prisma.product.create({ data: { name: `Appam ${sku}`, sku, basePrice: 50, isActive: true } });
  // HQ finished-goods stock (HQ scope = franchiseId null), priced for franchises.
  hqItem = await createStockedItem({ franchiseId: null, qty: 100, category: 'FINISHED_GOOD', sku, franchisePrice: 50 });
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const createOrder = (token: string, body: any) => call(srv.base, 'POST', '/api/franchise-orders', token, { orderType: 'STOCK', items: [{ productId: product.id, quantity: QTY }], ...body });
const setStatus = (token: string, id: string, status: string, extra: any = {}) => call(srv.base, 'PATCH', `/api/franchise-orders/${id}/status`, token, { status, ...extra });
const franchiseStock = async (franchiseId: string) => {
  const item = await prisma.inventoryItem.findFirst({ where: { franchiseId, sku: product.sku } });
  return item ? InventoryService.computeStock(item.id) : 0;
};

test('franchise admin cannot place an order on another franchise\'s account', async () => {
  const res = await createOrder(tokenFor(faA), { franchiseId: franchiseB.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.franchiseId, franchiseA.id);
});

test('invalid quantities are rejected', async () => {
  for (const quantity of [-5, 0, 'abc']) {
    const res = await call(srv.base, 'POST', '/api/franchise-orders', tokenFor(faA), { orderType: 'STOCK', items: [{ productId: product.id, quantity }] });
    assert.equal(res.status, 400, `quantity ${quantity}`);
  }
});

test('full lifecycle: only HQ approves/dispatches; no repeats; no cancel after dispatch', async () => {
  const created = await createOrder(tokenFor(faA), {});
  assert.equal(created.status, 201);
  const id = created.body.id;
  const hqBefore = await InventoryService.computeStock(hqItem.id);

  // Franchise self-approval / self-dispatch are forbidden.
  assert.equal((await setStatus(tokenFor(faA), id, 'APPROVED')).status, 403);
  assert.ok([403, 409].includes((await setStatus(tokenFor(faA), id, 'DISPATCHED')).status), 'franchise cannot dispatch');
  // Another franchise cannot touch it at all.
  assert.equal((await setStatus(tokenFor(faB), id, 'CANCELLED')).status, 403);
  // Skipping steps is rejected even for HQ.
  assert.equal((await setStatus(tokenFor(sa), id, 'DELIVERED')).status, 409);
  // Unknown status values are rejected.
  assert.equal((await setStatus(tokenFor(sa), id, 'PROCESSING')).status, 400);

  assert.equal((await setStatus(tokenFor(sa), id, 'APPROVED')).status, 200);
  assert.equal((await setStatus(tokenFor(sa), id, 'APPROVED')).status, 409, 'repeat approve');
  // The real self-dispatch attack: order approved, franchise tries to ship it to itself.
  assert.equal((await setStatus(tokenFor(faA), id, 'DISPATCHED')).status, 403);
  assert.equal(await InventoryService.computeStock(hqItem.id), hqBefore, 'no HQ stock moved by the refused dispatch');

  // Two concurrent dispatches: exactly one succeeds, HQ stock leaves once.
  const [d1, d2] = await Promise.all([setStatus(tokenFor(sa), id, 'DISPATCHED'), setStatus(tokenFor(sa), id, 'DISPATCHED')]);
  assert.deepEqual([d1.status, d2.status].sort(), [200, 409], JSON.stringify([d1.body, d2.body]));
  assert.equal(await InventoryService.computeStock(hqItem.id), hqBefore - QTY);

  // No cancellation once goods have left HQ.
  assert.equal((await setStatus(tokenFor(sa), id, 'CANCELLED')).status, 409);
  assert.equal((await setStatus(tokenFor(faA), id, 'CANCELLED')).status, 409);

  // Franchise confirms receipt once.
  const before = await franchiseStock(franchiseA.id);
  assert.equal((await setStatus(tokenFor(faA), id, 'DELIVERED')).status, 200);
  assert.equal(await franchiseStock(franchiseA.id), before + QTY);

  // The old DELIVERED -> APPROVED -> DISPATCHED -> DELIVERED loop is closed.
  assert.equal((await setStatus(tokenFor(faA), id, 'DELIVERED')).status, 409);
  assert.equal((await setStatus(tokenFor(sa), id, 'APPROVED')).status, 409);
  assert.equal((await setStatus(tokenFor(sa), id, 'DISPATCHED')).status, 409);
  assert.equal(await franchiseStock(franchiseA.id), before + QTY, 'franchise stock credited exactly once');
  assert.equal(await InventoryService.computeStock(hqItem.id), hqBefore - QTY, 'HQ stock deducted exactly once');

  for (const s of ['APPROVED', 'DISPATCHED', 'DELIVERED']) {
    assert.equal(await auditCount('FRANCHISE_ORDER', `STATUS_${s}`, id), 1, `audit ${s}`);
  }
});

test('franchise can cancel its own PENDING order; the order debit is reversed exactly once', async () => {
  const outstandingBefore = (await prisma.franchise.findUniqueOrThrow({ where: { id: franchiseA.id } })).outstandingAmount || 0;
  const created = await createOrder(tokenFor(faA), {});
  const id = created.body.id;
  const afterOrder = (await prisma.franchise.findUniqueOrThrow({ where: { id: franchiseA.id } })).outstandingAmount || 0;
  assert.ok(afterOrder > outstandingBefore);

  const res = await setStatus(tokenFor(faA), id, 'CANCELLED', { notes: 'Ordered wrong product' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.notes || '', /Cancelled: Ordered wrong product/);
  const afterCancel = (await prisma.franchise.findUniqueOrThrow({ where: { id: franchiseA.id } })).outstandingAmount || 0;
  assert.ok(Math.abs(afterCancel - outstandingBefore) < 0.001, `outstanding restored (${afterCancel} vs ${outstandingBefore})`);
  assert.equal((await setStatus(tokenFor(faA), id, 'CANCELLED')).status, 409, 'cannot cancel twice');
  assert.equal(await auditCount('FRANCHISE_ORDER', 'STATUS_CANCELLED', id), 1);
});

test('franchise cannot cancel once HQ has approved; HQ can, and the reservation is released', async () => {
  const created = await createOrder(tokenFor(faA), {});
  const id = created.body.id;
  assert.equal((await setStatus(tokenFor(sa), id, 'APPROVED')).status, 200);
  assert.equal((await setStatus(tokenFor(faA), id, 'CANCELLED')).status, 403);
  assert.equal((await setStatus(tokenFor(sa), id, 'CANCELLED', { notes: 'Franchise request' })).status, 200);
  const reservation = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: id } });
  assert.equal(reservation?.status, 'RELEASED');
});
