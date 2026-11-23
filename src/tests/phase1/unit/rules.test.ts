// Pure rule tests (no database): C-03 transition table, C-07 legacy flow
// inference, C-08/H-13 input validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
process.env.ACCESS_TOKEN_SECRET ||= crypto.randomBytes(48).toString('base64');
process.env.REFRESH_TOKEN_SECRET ||= crypto.randomBytes(48).toString('base64');

import { FranchiseOrderStatus } from '@prisma/client';
import { assertFranchiseOrderTransition, FRANCHISE_ORDER_TRANSITIONS } from '../../../modules/franchise/franchise-order.service';
import { inferLegacyPaymentFlow, resolvePaymentFlow } from '../../../modules/finance/payment-flow';
import { requirePositiveAmount, requireNonNegativeNumber } from '../../../utils/ownership.util';

const S = FranchiseOrderStatus;
const SA = { role: 'SUPER_ADMIN', franchiseId: null };
const FA = { role: 'FRANCHISE_ADMIN', franchiseId: 'F1' };
const otherFA = { role: 'FRANCHISE_ADMIN', franchiseId: 'F2' };
const order = (status: FranchiseOrderStatus) => ({ status, franchiseId: 'F1' });
const code = (fn: () => void) => { try { fn(); return 200; } catch (e: any) { return e.statusCode; } };

test('C-03: franchise admin may only cancel PENDING and confirm receipt of DISPATCHED (own orders)', () => {
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.PENDING), S.CANCELLED, FA)), 200);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.DISPATCHED), S.DELIVERED, FA)), 200);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.PENDING), S.APPROVED, FA)), 403);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.APPROVED), S.DISPATCHED, FA)), 403);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.APPROVED), S.IN_PRODUCTION, FA)), 403);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.APPROVED), S.CANCELLED, FA)), 403);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.PENDING), S.CANCELLED, otherFA)), 403);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.DISPATCHED), S.DELIVERED, otherFA)), 403);
  assert.equal(code(() => assertFranchiseOrderTransition(order(S.PENDING), S.CANCELLED, { role: 'FRANCHISE_ADMIN', franchiseId: null })), 403);
});

test('C-03: HQ may approve, produce, dispatch and cancel before dispatch', () => {
  for (const [from, to] of [[S.PENDING, S.APPROVED], [S.APPROVED, S.IN_PRODUCTION], [S.APPROVED, S.DISPATCHED], [S.IN_PRODUCTION, S.DISPATCHED], [S.PENDING, S.CANCELLED], [S.APPROVED, S.CANCELLED], [S.IN_PRODUCTION, S.CANCELLED], [S.DISPATCHED, S.DELIVERED]] as const) {
    assert.equal(code(() => assertFranchiseOrderTransition(order(from), to, SA)), 200, `${from}->${to}`);
  }
});

test('C-03: no repeats, no going back, no cancel after dispatch — for anyone', () => {
  for (const actor of [SA, FA]) {
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.DISPATCHED), S.DISPATCHED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.DELIVERED), S.DELIVERED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.DELIVERED), S.APPROVED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.DISPATCHED), S.APPROVED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.DISPATCHED), S.CANCELLED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.DELIVERED), S.CANCELLED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.CANCELLED), S.APPROVED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.PENDING), S.DISPATCHED, actor)), 409);
    assert.equal(code(() => assertFranchiseOrderTransition(order(S.PENDING), S.DELIVERED, actor)), 409);
  }
  assert.deepEqual(FRANCHISE_ORDER_TRANSITIONS.DELIVERED, []);
  assert.deepEqual(FRANCHISE_ORDER_TRANSITIONS.CANCELLED, []);
});

test('C-07: legacy payment direction inference matches the creating code paths', () => {
  const f = inferLegacyPaymentFlow;
  assert.equal(f({ sourceModule: 'PROCUREMENT', type: 'REFUND', entityType: 'VENDOR' }), 'IN');       // vendor refund (old code reversed it as OUT)
  assert.equal(f({ sourceModule: 'PROCUREMENT', type: 'INVOICE_LINKED', entityType: 'VENDOR' }), 'OUT');
  assert.equal(f({ sourceModule: 'PROCUREMENT', type: 'ADVANCE', entityType: 'VENDOR' }), 'OUT');
  assert.equal(f({ sourceModule: 'PAYROLL', type: 'DIRECT', entityType: 'EMPLOYEE' }), 'OUT');         // old code reversed it as IN
  assert.equal(f({ sourceModule: 'EXPENSE', type: 'DIRECT', entityType: 'VENDOR' }), 'OUT');
  assert.equal(f({ sourceModule: 'FRANCHISE', type: 'INVOICE_LINKED', entityType: 'FRANCHISE' }), 'OUT');
  assert.equal(f({ sourceModule: 'POS', type: 'INVOICE_LINKED', entityType: 'CUSTOMER' }), 'IN');
  assert.equal(f({ sourceModule: 'POS', type: 'DIRECT', entityType: 'VENDOR' }), 'OUT');               // POS refund (OUT defaulted entityType to VENDOR)
  assert.equal(f({ sourceModule: 'TRANSFER', type: 'INTERNAL_TRANSFER', paymentNumber: 'PAY-1' }), 'OUT');
  assert.equal(f({ sourceModule: 'TRANSFER', type: 'INTERNAL_TRANSFER', paymentNumber: 'PAY-1-IN' }), 'IN');
  assert.equal(f({ sourceModule: 'MANUAL', type: 'DIRECT', entityType: 'CENTRAL_WAREHOUSE' }), 'IN');
  assert.equal(f({ sourceModule: 'MANUAL', type: 'DIRECT', entityType: 'VENDOR' }), null, 'ambiguous manual rows are never guessed');
  assert.equal(f({ type: 'REVERSAL', sourceModule: 'POS' }), null);
  assert.equal(resolvePaymentFlow({ flow: 'IN', sourceModule: 'PROCUREMENT', type: 'INVOICE_LINKED' }), 'IN', 'persisted flow wins');
});

test('H-13: amount validation rejects NaN, zero, negative, Infinity and junk', () => {
  for (const bad of [NaN, 0, -1, -0.01, Infinity, 'abc', '', null, undefined, {}, '1e999']) {
    assert.throws(() => requirePositiveAmount(bad as any), (e: any) => e.statusCode === 400, String(bad));
  }
  assert.equal(requirePositiveAmount('12.5'), 12.5);
  assert.equal(requirePositiveAmount(3), 3);
  for (const bad of [NaN, -1, 'x', Infinity, null]) {
    assert.throws(() => requireNonNegativeNumber(bad as any), (e: any) => e.statusCode === 400);
  }
  assert.equal(requireNonNegativeNumber(0), 0);
});
