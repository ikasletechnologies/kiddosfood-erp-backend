// PENDING_APPROVAL remains receipt-eligible for historical POs, without rewriting history.
export const RECEIPT_READY_PO_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'SENT', 'PARTIALLY_RECEIVED'] as const;
export function isPOReceiptEligible(status: string): boolean {
  return (RECEIPT_READY_PO_STATUSES as readonly string[]).includes(status);
}
export function savedPOStatus(status?: string): string {
  return !status || status === 'PENDING_APPROVAL' ? 'APPROVED' : status;
}
