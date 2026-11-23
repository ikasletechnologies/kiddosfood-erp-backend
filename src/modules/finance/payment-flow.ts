/**
 * Payment direction (audit C-07).
 *
 * New payments persist `flow` (IN = the account balance went up, OUT = it went
 * down). Rows written before the column existed are classified here with the
 * SAME rules as the SQL backfill in
 * prisma/migrations/20261123090000_phase1_safety/migration.sql — keep the two
 * in sync. Anything ambiguous returns null and is refused at cancellation
 * rather than guessed (guessing is exactly what produced the original bug:
 * vendor refunds and payroll were reversed in the wrong direction).
 */
export type PaymentFlowValue = 'IN' | 'OUT';

export function inferLegacyPaymentFlow(p: {
  type?: string | null;
  paymentNumber?: string | null;
  sourceModule?: string | null;
  entityType?: string | null;
}): PaymentFlowValue | null {
  const type = p.type || '';
  const src = p.sourceModule || '';
  if (type === 'REVERSAL') return null;
  if (type === 'INTERNAL_TRANSFER') return (p.paymentNumber || '').endsWith('-IN') ? 'IN' : 'OUT';
  if (src === 'FRANCHISE') return 'OUT';
  if (src === 'EXPENSE' || src === 'PAYROLL') return 'OUT';
  if (src === 'PROCUREMENT') return type === 'REFUND' ? 'IN' : 'OUT';
  if (src === 'POS') return p.entityType === 'VENDOR' ? 'OUT' : 'IN';
  if (p.entityType === 'CENTRAL_WAREHOUSE') return 'IN';
  return null;
}

export function resolvePaymentFlow(p: {
  flow?: string | null;
  type?: string | null;
  paymentNumber?: string | null;
  sourceModule?: string | null;
  entityType?: string | null;
}): PaymentFlowValue | null {
  if (p.flow === 'IN' || p.flow === 'OUT') return p.flow;
  return inferLegacyPaymentFlow(p);
}

/** A payment whose money actually moved (vs. a pending cheque etc.). */
export function isPostedPayment(status?: string | null): boolean {
  return status === 'PAID' || status === 'SUCCESS';
}
