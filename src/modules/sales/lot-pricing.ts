/**
 * Selling-price calculations shared by Set Price and sales lots — pure.
 *
 * Selling prices are per product (Customer / Dealer / Franchise, see
 * product-pricing.service); a finished-goods lot keeps only its own
 * production cost (unitCost, from the packaging cost snapshot). Profit is
 * always measured on the selling price EXCLUDING GST. Money is carried in
 * whole paise so lot lines and totals reconcile exactly.
 */

/** Roles that may set or change selling prices (same as Product Master pricing). */
export const LOT_PRICE_EDIT_ROLES = ['SUPER_ADMIN'] as const;
export function canEditLotPrice(user: { role?: string } | null | undefined): boolean {
  return !!user?.role && (LOT_PRICE_EDIT_ROLES as readonly string[]).includes(user.role);
}

const paise = (rupees: number) => Math.round((Number(rupees) || 0) * 100);
const rupees = (p: number) => p / 100;

export const lotLabel = (lot: { lotNumber?: string | null; batchNumber?: string | null; id?: string }) =>
  lot.lotNumber || lot.batchNumber || lot.id || 'lot';

/** Selling price per packet excluding GST: a GST-inclusive ₹105 at 5% → ₹100. */
export function priceExcludingTax(price: number, taxInclusive: boolean, taxPercent: number): number {
  const p = Number(price) || 0;
  if (!taxInclusive) return rupees(paise(p));
  const t = Math.max(0, Number(taxPercent) || 0);
  return rupees(Math.round(paise(p) / (1 + t / 100)));
}

/** Selling price per packet including GST, for display. */
export function priceIncludingTax(price: number, taxInclusive: boolean, taxPercent: number): number {
  const p = Number(price) || 0;
  if (taxInclusive) return rupees(paise(p));
  const t = Math.max(0, Number(taxPercent) || 0);
  return rupees(Math.round(paise(p) * (1 + t / 100)));
}

const fmt = (n: number) => `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export interface LotPriceCheck {
  priceExclTax: number;
  unitCost: number | null;
  /** Selling price excl. GST − production cost, per packet; null when cost is unknown. */
  unitProfit: number | null;
  /** Unit profit / selling price excl. GST × 100. */
  marginPct: number | null;
  belowCost: boolean;
  warning: string | null;
}

/**
 * Set Price check for one lot. Never changes the price — only reports.
 * "Warning: Selling price is ₹17 below production cost per packet. Estimated loss: ₹17 per packet."
 */
export function checkLotPrice(input: { price: number; taxInclusive: boolean; taxPercent: number; unitCost: number | null | undefined }): LotPriceCheck {
  const priceExclTax = priceExcludingTax(input.price, input.taxInclusive, input.taxPercent);
  const cost = input.unitCost != null && Number.isFinite(Number(input.unitCost)) && Number(input.unitCost) > 0 ? rupees(paise(Number(input.unitCost))) : null;
  if (cost == null) return { priceExclTax, unitCost: null, unitProfit: null, marginPct: null, belowCost: false, warning: null };
  const profitP = paise(priceExclTax) - paise(cost);
  const belowCost = profitP < 0;
  return {
    priceExclTax,
    unitCost: cost,
    unitProfit: rupees(profitP),
    marginPct: paise(priceExclTax) > 0 ? Math.round((profitP / paise(priceExclTax)) * 10000) / 100 : null,
    belowCost,
    warning: belowCost
      ? `Warning: Selling price is ${fmt(rupees(profitP))} below production cost per packet. Estimated loss: ${fmt(rupees(profitP))} per packet.`
      : null,
  };
}

/**
 * Sales-line warning for a lot sold below its production cost:
 * "Lot A is being sold ₹17 below production cost per packet. Estimated loss for 5 packets: ₹85."
 */
export function lotLossWarning(label: string, unitProfit: number | null, quantity: number, lineProfit: number | null): string | null {
  if (unitProfit == null || lineProfit == null || !(lineProfit < 0)) return null;
  const qty = Number(quantity) || 0;
  const units = `${qty.toLocaleString('en-IN', { maximumFractionDigits: 3 })} packet${qty === 1 ? '' : 's'}`;
  return `Lot ${label} is being sold ${fmt(unitProfit)} below production cost per packet. Estimated loss for ${units}: ${fmt(lineProfit)}.`;
}

export interface LotAllocationInput {
  quantity: number;
  /** Selling price per packet excluding GST. */
  price: number;
  /** Production cost per packet, or null when unknown. */
  unitCost: number | null;
}

export interface LotAllocationSummary {
  totalQuantity: number;
  /** Σ lot quantity × lot price — the exact selling value, never rebuilt from the average. */
  totalValue: number;
  /** totalValue / totalQuantity, for display only. */
  weightedAvgPrice: number | null;
  totalCost: number | null;
  weightedAvgCost: number | null;
  profit: number | null;
  marginPct: number | null;
  /** Lots whose cost is unknown — cost/profit then cover the costed lots only. */
  costUnavailableLots: number;
}

/**
 * Totals for one product sold from several lots. Line amounts are kept per
 * lot; the weighted averages are for display. 5 × ₹100 + 50 × ₹200 →
 * ₹10,500 over 55 packets, average ₹190.91.
 */
export function summarizeLotAllocations(allocations: LotAllocationInput[]): LotAllocationSummary {
  const lines = allocations.filter((a) => Number(a.quantity) > 0);
  const qty = lines.reduce((s, a) => s + Number(a.quantity), 0);
  const valueP = lines.reduce((s, a) => s + Math.round(paise(a.price) * Number(a.quantity)), 0);
  const costed = lines.filter((a) => a.unitCost != null && Number.isFinite(Number(a.unitCost)));
  const costedQty = costed.reduce((s, a) => s + Number(a.quantity), 0);
  const costedValueP = costed.reduce((s, a) => s + Math.round(paise(a.price) * Number(a.quantity)), 0);
  const costP = costed.reduce((s, a) => s + Math.round(paise(a.unitCost as number) * Number(a.quantity)), 0);
  const profitP = costedValueP - costP;
  return {
    totalQuantity: qty,
    totalValue: rupees(valueP),
    weightedAvgPrice: qty > 0 ? rupees(Math.round(valueP / qty)) : null,
    totalCost: costed.length ? rupees(costP) : null,
    weightedAvgCost: costedQty > 0 ? rupees(Math.round(costP / costedQty)) : null,
    profit: costed.length ? rupees(profitP) : null,
    marginPct: costed.length && costedValueP > 0 ? Math.round((profitP / costedValueP) * 10000) / 100 : null,
    costUnavailableLots: lines.length - costed.length,
  };
}
