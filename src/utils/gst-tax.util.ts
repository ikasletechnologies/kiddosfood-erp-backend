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

export const INDIAN_GST_STATE_MAP: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '28': 'Andhra Pradesh',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory'
};

/**
 * Extracts standard state name from a 15-digit GSTIN if available
 */
export function getStateFromGstin(gstin?: string | null): string | null {
  if (!gstin || typeof gstin !== 'string') return null;
  const trimmed = gstin.trim();
  if (trimmed.length < 2) return null;
  const stateCode = trimmed.slice(0, 2);
  return INDIAN_GST_STATE_MAP[stateCode] || null;
}

/**
 * Normalizes state name / code for comparison (e.g., '33 - Tamil Nadu', 'tamil nadu' -> 'tamil nadu')
 */
export function normalizeState(s?: string | null): string {
  if (!s || typeof s !== 'string') return '';
  let cleaned = s.trim().toLowerCase();
  
  // Handle formats like "33 - Tamil Nadu" or "33-Tamil Nadu" or "33: Tamil Nadu"
  const prefixMatch = cleaned.match(/^(\d{2})\s*[-:]\s*(.+)$/);
  if (prefixMatch) {
    cleaned = prefixMatch[2].trim();
  } else if (/^\d{2}$/.test(cleaned)) {
    const mapped = INDIAN_GST_STATE_MAP[cleaned];
    if (mapped) cleaned = mapped.toLowerCase();
  }

  return cleaned;
}

/**
 * Validates that seller GST state is configured before processing tax calculations.
 * Throws a clear configuration error rather than silently defaulting to IGST.
 */
export function assertValidSellerState(sellerState?: string | null): string {
  if (!sellerState || !sellerState.trim()) {
    throw new Error('Company GST seller state is not configured. Please configure the State in Company Profile Settings.');
  }
  return sellerState.trim();
}

/**
 * True when buyer/seller states differ and both are known valid states.
 * An unknown/missing state on either side is treated as intra-state (CGST+SGST)
 * rather than silently reclassified to IGST.
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
 * path every caller must use.
 * SettingsService.getCompanyProfile().state is the authoritative source.
 * Never fall back to Franchise.location for GST state classification.
 */
export async function resolveSellerState(franchiseId?: string | null): Promise<string | null> {
  const { SettingsService } = require('../modules/settings/settings.service');
  const profile = await SettingsService.getCompanyProfile();
  if (profile?.state && typeof profile.state === 'string' && profile.state.trim()) {
    return profile.state.trim();
  }

  // Fallback to structured state derived from profile GSTIN
  const gstin = profile?.gstNumber || profile?.gstin;
  if (gstin && typeof gstin === 'string') {
    const derived = getStateFromGstin(gstin);
    if (derived) return derived;
  }

  return null;
}

/**
 * Resolves the canonical seller GST state once per distinct franchiseId in
 * a report's result set.
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
