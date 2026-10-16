import { startOfBusinessDay } from '../../utils/business-date.util';

/**
 * Lot usability — one rule for Production Planning (lot options), production
 * deduction, FIFO issue, sales / POS lot checks, reservations and the Stock
 * Hub, so no screen disagrees with what will actually be accepted.
 *
 * Expiry policy: the expiry date is a calendar date with no time. A lot is
 * EXPIRED ON its expiry date — expiry 15th means usable up to the 14th and
 * expired from 00:00 on the 15th, in the business timezone (IST). (Comparing
 * the stored date with the current instant used to expire it at an odd
 * 05:30 IST on the expiry date.) Usable ⇔ expDate ≥ start of TOMORROW — see
 * expiryCutoff. Works whether the date was stored at UTC or IST midnight.
 */

/** Earliest expiry still usable now: the start of tomorrow in the business timezone. */
export function expiryCutoff(now: Date = new Date()): Date {
  return new Date(startOfBusinessDay(now).getTime() + 86_400_000);
}

export const PRODUCTION_EXPIRED_MESSAGE = 'Purchase lot is unavailable for production due to expiry restrictions.';

export type LotIssueCode = 'EXPIRED' | 'STATUS' | 'OTHER_WAREHOUSE' | 'NO_STOCK';

export interface LotIssue { code: LotIssueCode; message: string }

const STATUS_REASON: Record<string, string> = {
  QC_HOLD: 'Purchase lot is on QC hold and unavailable for production.',
  RECEIVED: 'Purchase lot is awaiting QC approval and unavailable for production.',
  BLOCKED: 'Purchase lot is blocked (recall) and unavailable for production.',
  REJECTED: 'Purchase lot was rejected and is unavailable for production.',
  RETURNED: 'Purchase lot is marked for return and unavailable for production.',
  EXPIRED: PRODUCTION_EXPIRED_MESSAGE,
};

/** Expired: the expiry date is today or earlier (business timezone). */
export function isLotExpired(expDate: Date | string | null | undefined, now: Date = new Date()): boolean {
  return !!expDate && new Date(expDate).getTime() < expiryCutoff(now).getTime();
}

/** Null when the lot can be used for production; otherwise the reason it can't. */
export function productionLotIssue(
  lot: { status: string; currentQty: number; expDate: Date | string | null; warehouseId?: string | null },
  opts: { warehouseId?: string | null; now?: Date } = {},
): LotIssue | null {
  if (!(lot.currentQty > 0)) return { code: 'NO_STOCK', message: 'Purchase lot has no stock left.' };
  if (lot.status !== 'APPROVED') {
    return { code: 'STATUS', message: STATUS_REASON[lot.status] || `Purchase lot is ${String(lot.status).replace(/_/g, ' ')} and unavailable for production.` };
  }
  if (isLotExpired(lot.expDate, opts.now)) return { code: 'EXPIRED', message: PRODUCTION_EXPIRED_MESSAGE };
  if (opts.warehouseId && lot.warehouseId && lot.warehouseId !== opts.warehouseId) {
    return { code: 'OTHER_WAREHOUSE', message: 'Purchase lot is held in another warehouse.' };
  }
  return null;
}
