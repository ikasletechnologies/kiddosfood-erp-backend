import prisma from '../lib/prisma';

// Single source of truth for CGST/SGST vs IGST classification, used by both
// the sales side (Order/ReturnOrder) and the purchase side (ProcurementOrder/
// VendorInvoice/PurchaseReturn) and every GST report. Do not reintroduce a
// parallel split anywhere else — route every GST-relevant read or write
// through this file.

export interface GstSplit {
  cgst: number;
  sgst: number;
  igst: number;
  isInterState: boolean;
}

function normalizeState(s?: string | null): string {
  return (s || '').trim().toLowerCase();
}

/**
 * True when buyer/seller states differ and both are known. An unknown state
 * on either side is treated as intra-state (CGST+SGST) rather than silently
 * reclassified to IGST — the conservative default this codebase already
 * relied on.
 */
export function isInterState(buyerState?: string | null, sellerState?: string | null): boolean {
  const b = normalizeState(buyerState);
  const s = normalizeState(sellerState);
  return Boolean(b && s && b !== s);
}

/**
 * Splits a single blended tax amount into CGST/SGST or IGST. Used wherever
 * only one combined tax figure exists (Order.taxAmount, a credit/debit
 * note's taxAmount, a purchase bill line).
 */
export function splitGstAmount(taxAmount: number, buyerState?: string | null, sellerState?: string | null): GstSplit {
  const total = Number(taxAmount || 0);
  const interState = isInterState(buyerState, sellerState);
  if (interState) {
    return { igst: total, cgst: 0, sgst: 0, isInterState: true };
  }
  const cgst = Number((total / 2).toFixed(2));
  const sgst = Number((total - cgst).toFixed(2));
  return { igst: 0, cgst, sgst, isInterState: false };
}

/**
 * Computes CGST/SGST/IGST directly from a taxable value + rate, for
 * document-creation time (PO items, credit/debit note backfill) where no
 * blended taxAmount exists yet.
 */
export function computeGstFromRate(
  taxableValue: number,
  gstRate: number,
  buyerState?: string | null,
  sellerState?: string | null
): GstSplit & { taxAmount: number } {
  const taxAmount = Number((((Number(taxableValue) || 0) * (Number(gstRate) || 0)) / 100).toFixed(2));
  return { ...splitGstAmount(taxAmount, buyerState, sellerState), taxAmount };
}

/**
 * Resolves our own (seller's) GST registration state — the one canonical
 * path every caller must use, never a franchise's own `location` directly.
 * `SettingsService.getCompanyProfile().state` is the authoritative source
 * (and already falls back to the HQ franchise's location internally when
 * nobody has configured a real state yet) — checking a specific franchise's
 * `location` *before* that, as earlier code here did, meant a properly
 * configured company GST state could never actually take effect, since
 * `Franchise.location` is essentially always set to a street address. The
 * `franchiseId` fallback below only matters in the near-impossible case
 * where no HQ franchise exists either.
 */
export async function resolveSellerState(franchiseId?: string | null): Promise<string | null> {
  const { SettingsService } = require('../modules/settings/settings.service');
  const profile = await SettingsService.getCompanyProfile();
  if (profile?.state) return profile.state;

  if (franchiseId) {
    const franchise = await prisma.franchise.findUnique({ where: { id: franchiseId }, select: { location: true } });
    if (franchise?.location) return franchise.location;
  }
  return null;
}

/**
 * Resolves the canonical seller GST state once per distinct franchiseId in
 * a report's result set — for use in a loop over many rows, instead of
 * calling resolveSellerState() per row (expensive) or, worse, reading
 * Franchise.location directly (which bypasses resolveSellerState's
 * COMPANY_PROFILE-first precedence entirely). Every sales-side GST report
 * must resolve seller state through this path, the same one the
 * purchase-side already uses via resolveSellerState — one canonical
 * seller-state source, not two.
 */
export async function resolveSellerStatesFor(franchiseIds: (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const distinct = Array.from(new Set(franchiseIds.filter((id): id is string => !!id)));
  const map = new Map<string, string | null>();
  await Promise.all(distinct.map(async (id) => {
    map.set(id, await resolveSellerState(id));
  }));
  return map;
}

export interface GstLiability { cgst: number; sgst: number; igst: number }
export interface GstUtilizationResult {
  netCgst: number; netSgst: number; netIgst: number; netTotal: number;
  itcUtilized: { cgst: number; sgst: number; igst: number };
  itcUnutilized: { cgst: number; sgst: number; igst: number };
}

/**
 * Component-wise GST ITC utilization (GSTR-3B Net GST Payable), per the
 * statutory offset order — a flat `totalOutput - totalInput` is not legally
 * valid on its own, since CGST and SGST credit can never offset each
 * other's liability directly:
 *   IGST ITC  -> IGST liability, then CGST liability, then SGST liability.
 *   CGST ITC  -> CGST liability, then IGST liability (never SGST).
 *   SGST ITC  -> SGST liability, then IGST liability (never CGST).
 * For a single-component dataset (e.g. IGST-only, as in an inter-state-only
 * period) this reduces to the same result as a flat subtraction — the
 * distinction only matters once CGST/SGST and IGST are mixed in the same
 * period.
 */
export function computeGstUtilization(output: GstLiability, input: GstLiability): GstUtilizationResult {
  let liabCgst = Math.max(0, output.cgst || 0);
  let liabSgst = Math.max(0, output.sgst || 0);
  let liabIgst = Math.max(0, output.igst || 0);

  let itcIgst = Math.max(0, input.igst || 0);
  let itcCgst = Math.max(0, input.cgst || 0);
  let itcSgst = Math.max(0, input.sgst || 0);

  const round = (n: number) => Number(n.toFixed(2));

  let used = Math.min(itcIgst, liabIgst);
  liabIgst -= used; itcIgst -= used;
  const igstToIgst = used;

  used = Math.min(itcIgst, liabCgst);
  liabCgst -= used; itcIgst -= used;
  const igstToCgst = used;

  used = Math.min(itcIgst, liabSgst);
  liabSgst -= used; itcIgst -= used;
  const igstToSgst = used;

  used = Math.min(itcCgst, liabCgst);
  liabCgst -= used; itcCgst -= used;
  const cgstToCgst = used;

  used = Math.min(itcCgst, liabIgst);
  liabIgst -= used; itcCgst -= used;
  const cgstToIgst = used;

  used = Math.min(itcSgst, liabSgst);
  liabSgst -= used; itcSgst -= used;
  const sgstToSgst = used;

  used = Math.min(itcSgst, liabIgst);
  liabIgst -= used; itcSgst -= used;
  const sgstToIgst = used;

  return {
    netCgst: round(liabCgst),
    netSgst: round(liabSgst),
    netIgst: round(liabIgst),
    netTotal: round(liabCgst + liabSgst + liabIgst),
    itcUtilized: {
      cgst: round(cgstToCgst + igstToCgst),
      sgst: round(sgstToSgst + igstToSgst),
      igst: round(igstToIgst + cgstToIgst + sgstToIgst)
    },
    itcUnutilized: { cgst: round(itcCgst), sgst: round(itcSgst), igst: round(itcIgst) }
  };
}
