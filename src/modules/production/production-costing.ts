/**
 * Pure packaging cost calculations, shared by the cost preview and by
 * packageAndConfirm so what the operator sees is what gets posted.
 *
 * Costing policy (also shown on the Packaging screen):
 *  - Raw material cost of a packaging row = cost of the bulk lot(s) the row
 *    actually consumes (the existing FIFO bulk valuation).
 *  - PER_KG expenses   = rate × packed weight (good + damaged) in KG (or L).
 *  - PER_PACKET        = rate × packets (good + damaged).
 *  - PER_BATCH         = batch total × packed weight / actual yield. Charged
 *    once across all packaging sessions; the session that finishes the batch
 *    takes the rounding remainder, and the charge never exceeds the total.
 *  - Damaged packets: their cost is carried by the good packets of the same
 *    row (the existing packaging policy), shown as "damage absorbed".
 */
import { convertMeasurement, ValidUnit } from '@businessgroupikasle/erp-units';
import { Prisma } from '@prisma/client';

export const EXPENSE_BASES = ['PER_BATCH', 'PER_KG', 'PER_PACKET'] as const;
export type ExpenseBasis = typeof EXPENSE_BASES[number];

export interface ExpenseCategory { code: string; label: string }

export const EXPENSE_CATEGORIES_SETTING = 'PRODUCTION_EXPENSE_CATEGORIES';
export const DEFAULT_EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { code: 'MANPOWER', label: 'Manpower' },
  { code: 'ELECTRICITY', label: 'Electricity' },
  { code: 'OTHER', label: 'Other Expenses' },
  { code: 'PACKAGING_MATERIAL', label: 'Packaging Materials' },
];

/** One expense line as entered. `row` limits a per-kg / per-packet line to one pack-size row. */
export interface ExpenseLineInput {
  category: string;
  basis: ExpenseBasis;
  rate: number;
  row?: number | null;
}

export interface CostRowInput {
  packetSize: string;
  /** One packet's weight in the bulk stock unit. */
  packWeight: number;
  good: number;
  damaged: number;
  /** Bulk material cost this row consumes (good + damaged weight). */
  bulkCost: number;
  sellingPrice?: number | null;
}

export interface SharedExpenseState {
  category: string;
  total: number;
  /** Already charged to earlier packaging sessions. */
  allocatedBefore: number;
}

export interface CostExpenseLine {
  category: string;
  label: string;
  basis: ExpenseBasis;
  rate: number;
  baseQty: number;
  amount: number;
  perPacket: number;
}

export interface CostRowResult {
  packetSize: string;
  packets: number;
  good: number;
  damaged: number;
  weight: number;
  rawMaterialCost: number;
  rawMaterialPerPacket: number;
  expenses: CostExpenseLine[];
  expenseTotal: number;
  totalCost: number;
  costPerPacket: number;
  /** What each good packet is valued at in stock (absorbs damaged packets). */
  costPerGoodPacket: number | null;
  damageAbsorbed: number;
  sellingPrice: number | null;
  marginPerPacket: number | null;
  marginPct: number | null;
  // marginPerPacket × good packets, and selling price × good packets.
  marginTotal: number | null;
  sellingValue: number | null;
  profitStatus: 'PROFIT' | 'LOSS' | 'BREAK_EVEN' | null;
}

export const r4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;
export const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const D = (n: number | Prisma.Decimal) => new Prisma.Decimal(n instanceof Prisma.Decimal ? n : (Number(n) || 0));
const dn = (d: Prisma.Decimal, dp = 4) => d.toDecimalPlaces(dp).toNumber();

/** Packed weight → the quantity a PER_KG rate applies to (KG for weight, L for volume). */
export function weightForPerKg(qty: number, bulkUnit: string): { qty: number; unit: 'KG' | 'L' } {
  const u = String(bulkUnit || '').toUpperCase();
  for (const target of ['KG', 'L'] as const) {
    try {
      return { qty: u === target ? qty : convertMeasurement(qty, u as ValidUnit, target as ValidUnit).toNumber(), unit: target };
    } catch { /* try the next dimension */ }
  }
  throw new Error(`Per-KG expenses need a weight or volume stock unit; this batch is tracked in ${bulkUnit}.`);
}

/** Validates and normalises expense lines against the configured categories. */
export function normalizeExpenseLines(lines: unknown, categories: ExpenseCategory[], rowCount: number): ExpenseLineInput[] {
  if (lines === undefined || lines === null) return [];
  if (!Array.isArray(lines)) throw new Error('expenses must be a list.');
  if (lines.length > 50) throw new Error('A maximum of 50 expense lines can be entered.');
  const codes = new Set(categories.map((c) => c.code));
  const seenBatch = new Set<string>();
  return lines.map((raw: any, i) => {
    const label = `Expense ${i + 1}`;
    const category = String(raw?.category || '').trim().toUpperCase();
    const basis = String(raw?.basis || '').trim().toUpperCase() as ExpenseBasis;
    const rate = Number(raw?.rate);
    const row = raw?.row === undefined || raw?.row === null || raw?.row === '' ? null : Number(raw.row);
    if (!codes.has(category)) throw new Error(`${label}: unknown expense category "${raw?.category}".`);
    if (!EXPENSE_BASES.includes(basis)) throw new Error(`${label}: basis must be Per Production Batch, Per KG or Per Packet.`);
    if (!Number.isFinite(rate) || rate < 0) throw new Error(`${label}: amount must be 0 or more.`);
    if (basis === 'PER_BATCH') {
      if (row !== null) throw new Error(`${label}: a per-batch expense applies to the whole batch, not one pack size.`);
      if (seenBatch.has(category)) throw new Error(`${label}: enter one per-batch amount for each category.`);
      seenBatch.add(category);
    } else if (row !== null && (!Number.isInteger(row) || row < 0 || row >= rowCount)) {
      throw new Error(`${label}: pack-size row ${row + 1} does not exist.`);
    }
    return { category, basis, rate, row };
  });
}

/**
 * Costs every packaging row of one request.
 * @param shared     PER_BATCH totals for the batch (after this request's edits) and what earlier sessions already absorbed.
 * @param yieldQty   Actual yield (bulk released), the denominator for PER_BATCH shares.
 * @param finishesBatch True when this request packs the last of the batch: it then takes the remainder.
 */
export function computePackagingCosts(params: {
  rows: CostRowInput[];
  bulkUnit: string;
  lines: ExpenseLineInput[];
  shared: SharedExpenseState[];
  yieldQty: number;
  finishesBatch: boolean;
  categories: ExpenseCategory[];
}): { rows: CostRowResult[]; sharedAllocations: Array<{ category: string; row: number; amount: number; weight: number }> } {
  // Money is worked in Decimal and rounded to 4 dp only when stored/returned.
  const labelOf = (code: string) => params.categories.find((c) => c.code === code)?.label || code;
  const weights = params.rows.map((r) => D(r.packWeight).mul(r.good + r.damaged));
  const expensesByRow: CostExpenseLine[][] = params.rows.map(() => []);
  const amountsByRow: Prisma.Decimal[] = params.rows.map(() => D(0));
  const sharedAllocations: Array<{ category: string; row: number; amount: number; weight: number }> = [];
  const yieldQty = D(params.yieldQty);

  // PER_BATCH: weight share of the remaining total.
  for (const s of params.shared) {
    if (!(s.total > 0)) continue;
    let left = Prisma.Decimal.max(0, D(s.total).minus(s.allocatedBefore));
    const lastRow = weights.reduce((last, w, i) => (w.gt(0) ? i : last), -1);
    weights.forEach((w, i) => {
      if (!w.gt(0)) return;
      let amount = yieldQty.gt(0) ? D(s.total).mul(w).div(yieldQty) : D(0);
      if (params.finishesBatch && i === lastRow) amount = left;
      amount = Prisma.Decimal.min(Prisma.Decimal.max(0, amount), left).toDecimalPlaces(4);
      left = left.minus(amount);
      amountsByRow[i] = amountsByRow[i].plus(amount);
      sharedAllocations.push({ category: s.category, row: i, amount: amount.toNumber(), weight: dn(w) });
      const packets = params.rows[i].good + params.rows[i].damaged;
      expensesByRow[i].push({ category: s.category, label: labelOf(s.category), basis: 'PER_BATCH', rate: s.total, baseQty: dn(w), amount: amount.toNumber(), perPacket: packets > 0 ? dn(amount.div(packets)) : 0 });
    });
  }

  for (const line of params.lines) {
    if (line.basis === 'PER_BATCH') continue;
    params.rows.forEach((row, i) => {
      if (line.row !== null && line.row !== undefined && line.row !== i) return;
      const packets = row.good + row.damaged;
      if (!(packets > 0)) return;
      const baseQty = line.basis === 'PER_PACKET' ? D(packets) : D(weightForPerKg(weights[i].toNumber(), params.bulkUnit).qty);
      const amount = D(line.rate).mul(baseQty).toDecimalPlaces(4);
      amountsByRow[i] = amountsByRow[i].plus(amount);
      expensesByRow[i].push({ category: line.category, label: labelOf(line.category), basis: line.basis, rate: line.rate, baseQty: dn(baseQty), amount: amount.toNumber(), perPacket: dn(amount.div(packets)) });
    });
  }

  const rows = params.rows.map((row, i): CostRowResult => {
    const packets = row.good + row.damaged;
    const bulkCost = D(row.bulkCost);
    const expenseTotal = amountsByRow[i];
    const totalCost = bulkCost.plus(expenseTotal);
    const costPerPacket = packets > 0 ? totalCost.div(packets) : D(0);
    const costPerGoodPacket = row.good > 0 ? totalCost.div(row.good) : null;
    const priceNum = Number(row.sellingPrice);
    const price = row.sellingPrice != null && Number.isFinite(priceNum) && priceNum > 0 ? D(priceNum) : null;
    // Profit/loss against the cost as shown (to the paisa), so per-packet ×
    // packets is exactly the total shown on screen.
    const shownCost = costPerGoodPacket ? costPerGoodPacket.toDecimalPlaces(2) : null;
    const margin = price && shownCost ? price.minus(shownCost) : null;
    return {
      packetSize: row.packetSize,
      packets,
      good: row.good,
      damaged: row.damaged,
      weight: dn(weights[i]),
      rawMaterialCost: dn(bulkCost),
      rawMaterialPerPacket: packets > 0 ? dn(bulkCost.div(packets)) : 0,
      expenses: expensesByRow[i],
      expenseTotal: dn(expenseTotal),
      totalCost: dn(totalCost),
      costPerPacket: dn(costPerPacket),
      costPerGoodPacket: costPerGoodPacket ? dn(costPerGoodPacket) : null,
      damageAbsorbed: row.good > 0 ? dn(costPerPacket.mul(row.damaged)) : 0,
      sellingPrice: price ? price.toNumber() : null,
      marginPerPacket: margin ? dn(margin) : null,
      marginPct: price && margin ? dn(margin.div(price).mul(100), 2) : null,
      marginTotal: margin ? dn(margin.mul(row.good), 2) : null,
      sellingValue: price ? dn(price.mul(row.good), 2) : null,
      profitStatus: margin ? (margin.isZero() ? 'BREAK_EVEN' : margin.gt(0) ? 'PROFIT' : 'LOSS') : null,
    };
  });

  return { rows, sharedAllocations };
}

/**
 * Cost of taking `qty` from FIFO-ordered lots without touching them
 * (cost preview). Any part not covered by lots is costed at `fallbackUnitCost`.
 * Mutates `lots[].available` so consecutive rows draw cumulatively.
 */
export function simulateFifoCost(lots: Array<{ available: number; unitCost: number }>, qty: number, fallbackUnitCost: number): number {
  let remaining = qty;
  let cost = 0;
  for (const lot of lots) {
    if (remaining <= 1e-9) break;
    const take = Math.min(lot.available, remaining);
    if (take <= 0) continue;
    lot.available -= take;
    remaining -= take;
    cost += take * lot.unitCost;
  }
  if (remaining > 1e-9) cost += remaining * fallbackUnitCost;
  return r4(cost);
}
