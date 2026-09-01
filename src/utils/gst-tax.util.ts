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
 * Resolves our own (seller's) GST state for a given franchise: the
 * franchise's own location if known, else the company profile's state
 * (which itself falls back to the HQ franchise's location — see
 * SettingsService.getCompanyProfile).
 */
export async function resolveSellerState(franchiseId?: string | null): Promise<string | null> {
  if (franchiseId) {
    const franchise = await prisma.franchise.findUnique({ where: { id: franchiseId }, select: { location: true } });
    if (franchise?.location) return franchise.location;
  }
  const { SettingsService } = require('../modules/settings/settings.service');
  const profile = await SettingsService.getCompanyProfile();
  return profile?.state || null;
}
