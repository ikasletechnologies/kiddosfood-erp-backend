/**
 * Estimated profit/loss for Sales Orders and POS — shared, pure calculation.
 *
 * Revenue is always EXCLUDING GST (GST is a liability, never revenue), and
 * after every discount that applies to the line (per-unit / percentage line
 * discounts and any order- or bill-level discount allocated to it). Cost is
 * the finished goods' inventory cost under the existing issue policy (see
 * finished-goods-cost.ts), or null when it isn't known — never an invented 0.
 *
 * All money is carried in whole paise so line and order totals reconcile
 * exactly and rounding happens once.
 */

const paise = (rupees: number) => Math.round((Number(rupees) || 0) * 100);
const rupees = (p: number) => p / 100;

/** Extracts GST from a tax-inclusive amount: 118 at 18% → 100. Never deducts GST twice. */
export function excludeTax(amountInclusive: number, taxPercent: number): number {
  const t = Math.max(0, Number(taxPercent) || 0);
  return rupees(Math.round(paise(amountInclusive) / (1 + t / 100)));
}

export interface ProfitLineInput {
  quantity: number;
  /** Net line revenue excluding GST, after all line discounts and any allocated order-level discount. */
  netRevenue: number;
  /** Finished-goods cost per sold unit, or null when it isn't known. */
  unitCost: number | null;
}

export interface ProfitLine {
  quantity: number;
  netRevenue: number;
  netUnitPrice: number;
  unitCost: number | null;
  costOfGoods: number | null;
  profit: number | null;
  unitProfit: number | null;
  /** Gross profit / net revenue × 100; null when revenue is 0 or cost is unknown. */
  marginPct: number | null;
  status: "PROFIT" | "LOSS" | "BREAK_EVEN" | "COST_UNAVAILABLE";
}

export function profitLine({ quantity, netRevenue, unitCost }: ProfitLineInput): ProfitLine {
  const qty = Math.max(0, Number(quantity) || 0);
  const revenueP = paise(netRevenue);
  const netUnitPrice = qty > 0 ? rupees(Math.round(revenueP / qty)) : 0;
  if (unitCost == null || !Number.isFinite(unitCost)) {
    return { quantity: qty, netRevenue: rupees(revenueP), netUnitPrice, unitCost: null, costOfGoods: null, profit: null, unitProfit: null, marginPct: null, status: "COST_UNAVAILABLE" };
  }
  const costP = Math.round(paise(unitCost) * qty);
  const profitP = revenueP - costP;
  return {
    quantity: qty,
    netRevenue: rupees(revenueP),
    netUnitPrice,
    unitCost: rupees(paise(unitCost)),
    costOfGoods: rupees(costP),
    profit: rupees(profitP),
    unitProfit: qty > 0 ? rupees(Math.round(profitP / qty)) : 0,
    marginPct: revenueP > 0 ? Math.round((profitP / revenueP) * 10000) / 100 : null,
    status: profitP > 0 ? "PROFIT" : profitP < 0 ? "LOSS" : "BREAK_EVEN",
  };
}

export interface ProfitSummary {
  netRevenue: number;
  costOfGoods: number | null;
  profit: number | null;
  marginPct: number | null;
  /** Lines whose cost is unknown — the totals then cover the costed lines only. */
  costUnavailableLines: number;
  costedRevenue: number;
  status: "PROFIT" | "LOSS" | "BREAK_EVEN" | "COST_UNAVAILABLE";
}

/** Order/bill totals. When some line has no cost, profit covers only the costed lines (and says so). */
export function summarizeProfit(lines: ProfitLine[]): ProfitSummary {
  const costed = lines.filter((l) => l.costOfGoods != null);
  const revenueP = lines.reduce((s, l) => s + paise(l.netRevenue), 0);
  const costedRevenueP = costed.reduce((s, l) => s + paise(l.netRevenue), 0);
  const costP = costed.reduce((s, l) => s + paise(l.costOfGoods!), 0);
  const unavailable = lines.length - costed.length;
  if (costed.length === 0) {
    return { netRevenue: rupees(revenueP), costOfGoods: null, profit: null, marginPct: null, costUnavailableLines: unavailable, costedRevenue: 0, status: "COST_UNAVAILABLE" };
  }
  const profitP = costedRevenueP - costP;
  return {
    netRevenue: rupees(revenueP),
    costOfGoods: rupees(costP),
    profit: rupees(profitP),
    marginPct: costedRevenueP > 0 ? Math.round((profitP / costedRevenueP) * 10000) / 100 : null,
    costUnavailableLines: unavailable,
    costedRevenue: rupees(costedRevenueP),
    status: profitP > 0 ? "PROFIT" : profitP < 0 ? "LOSS" : "BREAK_EVEN",
  };
}

/**
 * Splits an order/bill-level discount (excluding GST) across lines in
 * proportion to their net revenue, in whole paise; the last line takes the
 * remainder so the parts add up exactly.
 */
export function allocateDiscount(lineRevenues: number[], discount: number): number[] {
  const totalP = lineRevenues.reduce((s, r) => s + paise(r), 0);
  const discP = Math.max(0, Math.min(paise(discount), totalP));
  if (discP === 0 || totalP === 0) return lineRevenues.map(() => 0);
  let used = 0;
  return lineRevenues.map((r, i) => {
    const share = i === lineRevenues.length - 1 ? discP - used : Math.floor((discP * paise(r)) / totalP);
    used += share;
    return rupees(share);
  });
}

/** "Warning: Your selling price is ₹15 below production cost per unit. Estimated loss for 10 units is ₹150." */
export function lossWarning(line: ProfitLine): string | null {
  if (line.status !== "LOSS" || line.unitProfit == null || line.profit == null) return null;
  const fmt = (n: number) => `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const units = `${line.quantity.toLocaleString("en-IN", { maximumFractionDigits: 3 })} unit${line.quantity === 1 ? "" : "s"}`;
  return `Warning: Your selling price is ${fmt(line.unitProfit)} below production cost per unit. Estimated loss for ${units} is ${fmt(line.profit)}.`;
}

/** Who may see cost and profit. An allowlist: any role added later (e.g. a cashier) is excluded until added here. */
export const COST_VIEW_ROLES = ["SUPER_ADMIN", "FRANCHISE_ADMIN"] as const;
export function canViewCost(user: { role?: string } | null | undefined): boolean {
  return !!user?.role && (COST_VIEW_ROLES as readonly string[]).includes(user.role);
}
