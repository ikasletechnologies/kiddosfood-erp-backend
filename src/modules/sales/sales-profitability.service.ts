import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';
import { resolvePosLine } from '../pos/pos.service';
import { applyAuthoritativePricing, calculateTotals } from './sales.service';
import { estimateIssueCost, stockItemForProduct } from './finished-goods-cost';
import { allocateDiscount, lossWarning, profitLine, summarizeProfit, ProfitLine } from './profitability';
import { lotLossWarning, summarizeLotAllocations } from './lot-pricing';

/**
 * Estimated profit/loss for a Sales Order or a POS bill. Prices, GST and
 * discounts are re-derived on the server exactly as saving / checkout would
 * (never taken from the client), and cost comes from the finished goods'
 * cost layers under the existing issue policy. Nothing is written or
 * deducted; actual cost is fixed only when stock is really issued.
 *
 * A line sold from a chosen finished-goods lot (Set Price) is costed at that
 * lot's own production cost, and warned about on its own when it sells below
 * that cost — a profitable average across lots never hides it.
 */

export interface EstimatedLine extends ProfitLine {
  productId: string | null;
  productName: string;
  /** Effective selling price per unit before discounts, excluding GST. */
  unitPrice: number;
  taxPercent: number;
  /** Finished-goods lot the line sells from, when one was chosen. */
  inventoryBatchId?: string | null;
  lotNumber?: string | null;
  costReason?: string;
  warning: string | null;
}

async function costFor(productId: string | null | undefined, quantity: number, unit: string | null | undefined, scopeFranchiseId: string | null) {
  if (!productId) return { unitCost: null, reason: 'Not a catalogue product' };
  const item = await stockItemForProduct(productId, scopeFranchiseId);
  if (!item) return { unitCost: null, reason: 'No finished-goods stock item for this product' };
  const est = await estimateIssueCost({ inventoryItemId: item.id, quantity, unit: unit || 'NONE' });
  return { unitCost: est.status === 'AVAILABLE' ? est.unitCost : null, reason: est.reason };
}

/** A lot line's cost: the lot's production cost per line unit (snapshotted when priced). */
function lotCost(lotUnitCost: number | null | undefined) {
  return lotUnitCost != null && lotUnitCost > 0
    ? { unitCost: lotUnitCost, reason: undefined }
    : { unitCost: null, reason: 'This lot has no recorded production cost' };
}

function warningFor(line: ProfitLine, lotNumber: string | null | undefined) {
  return lotNumber ? lotLossWarning(lotNumber, line.unitProfit, line.quantity, line.profit) : lossWarning(line);
}

/**
 * Per-product totals across the product's lines (e.g. one SKU sold from two
 * lots): exact lot-wise selling value, weighted average selling price and
 * unit cost (display only), profit and margin. Selling value is before
 * discounts and excl. GST; profit is on net revenue after discounts.
 */
function productSummaries(lines: EstimatedLine[]) {
  const groups = new Map<string, EstimatedLine[]>();
  for (const l of lines) {
    const key = l.productId || l.productName;
    groups.set(key, [...(groups.get(key) || []), l]);
  }
  return [...groups.values()].map((group) => {
    const value = summarizeLotAllocations(group.map((l) => ({ quantity: l.quantity, price: l.unitPrice, unitCost: l.unitCost })));
    const profit = summarizeProfit(group);
    return {
      productId: group[0].productId,
      productName: group[0].productName,
      lots: group.filter((l) => l.inventoryBatchId).length,
      totalQuantity: value.totalQuantity,
      sellingValue: value.totalValue,
      weightedAvgSellingPrice: value.weightedAvgPrice,
      weightedAvgUnitCost: value.weightedAvgCost,
      netRevenue: profit.netRevenue,
      costOfGoods: profit.costOfGoods,
      profit: profit.profit,
      marginPct: profit.marginPct,
      lossLines: group.filter((l) => l.status === 'LOSS').length,
    };
  });
}

function finish(lines: EstimatedLine[]) {
  return { lines, summary: summarizeProfit(lines), products: productSummaries(lines) };
}

export class SalesProfitabilityService {
  /**
   * Sales Order: same pricing as createSalesOrder (Customer channel, HQ
   * scope). Line revenue is the line's taxable amount — after its own
   * discount, or its share of an order discount when no line has one —
   * excluding GST.
   */
  static async estimateSalesOrder(input: {
    items: Array<{ productId?: string; productName?: string; quantity: number; unit?: string; rate?: number; discountPercent?: number; discountAmount?: number; inventoryBatchId?: string | null }>;
    discountAmount?: number;
  }) {
    const items = (Array.isArray(input.items) ? input.items : [])
      .filter((i) => Number(i?.quantity) > 0)
      .map((i) => ({ ...i, quantity: Number(i.quantity), rate: Number(i.rate) || 0, productName: i.productName || '' }));
    const priced = await applyAuthoritativePricing(prisma, items, null, 'CUSTOMER');
    const { computed } = calculateTotals(priced, Number(input.discountAmount) || 0);
    return this.estimateComputedLines(computed);
  }

  /** Profit for lines already priced by calculateTotals (what a Sales Order saves). */
  static async estimateComputedLines(computed: Array<{ productId?: string; productName?: string; quantity: number; unit?: string | null; rate: number; taxPercent?: number; taxableAmount: number; inventoryBatchId?: string | null; lotNumber?: string | null; lotUnitCost?: number | null }>) {
    const lines = await Promise.all(computed.map(async (it): Promise<EstimatedLine> => {
      const { unitCost, reason } = it.inventoryBatchId
        ? lotCost(it.lotUnitCost)
        : await costFor(it.productId, it.quantity, it.unit, null);
      const line = profitLine({ quantity: it.quantity, netRevenue: it.taxableAmount, unitCost });
      return {
        ...line, productId: it.productId || null, productName: it.productName || '', unitPrice: it.rate, taxPercent: it.taxPercent || 0,
        inventoryBatchId: it.inventoryBatchId || null, lotNumber: it.lotNumber || null,
        costReason: unitCost == null ? reason : undefined, warning: warningFor(line, it.lotNumber),
      };
    }));
    return finish(lines);
  }

  /**
   * POS bill: same pricing as checkout (resolvePosLine), in the franchise's
   * inventory scope. GST is charged on the undiscounted line, so discounts
   * reduce revenue in full; the cashier's bill-level discount is capped as
   * checkout caps it and shared across lines by revenue. Round-off is not
   * revenue from the product and is left out.
   */
  static async estimatePos(input: {
    franchiseId: string;
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    items: Array<{ productId: string; quantity: number; unit?: string; discountPerUnit?: number; inventoryBatchId?: string | null }>;
    manualDiscount?: number;
  }) {
    const partyType = input.partyType === 'DEALER' ? 'DEALER' : input.partyType === 'FRANCHISE' ? 'FRANCHISE' : 'CUSTOMER';
    const scope = await FranchiseService.toInventoryScopeId(prisma, input.franchiseId);
    const items = (Array.isArray(input.items) ? input.items : []).filter((i) => i?.productId && Number(i.quantity) > 0);
    const resolved = await Promise.all(items.map((i) => resolvePosLine(prisma, i, partyType, scope)));

    const subtotal = resolved.reduce((s, l) => s + l.lineTotal, 0);
    const tax = resolved.reduce((s, l) => s + l.lineTax, 0);
    const productDiscount = resolved.reduce((s, l) => s + l.lineDiscount, 0);
    const manual = Math.min(Math.max(0, Number(input.manualDiscount) || 0), Math.max(0, subtotal + tax - productDiscount));
    const lineRevenue = resolved.map((l) => Math.max(0, l.lineTotal - l.lineDiscount));
    const shares = allocateDiscount(lineRevenue, manual);

    const lines = await Promise.all(resolved.map(async (l, i): Promise<EstimatedLine> => {
      const { unitCost, reason } = l.inventoryBatchId
        ? lotCost(l.lotUnitCost)
        : await costFor(l.productId, l.quantity, l.unit, scope);
      const line = profitLine({ quantity: l.quantity, netRevenue: lineRevenue[i] - shares[i], unitCost });
      const product = await prisma.product.findUnique({ where: { id: l.productId }, select: { name: true } });
      // The GST rate checkout charged on this line.
      const taxPercent = l.lineTotal > 0 ? Math.round((l.lineTax / l.lineTotal) * 10000) / 100 : 0;
      return {
        ...line, productId: l.productId, productName: product?.name || '', unitPrice: l.unitPrice, taxPercent,
        inventoryBatchId: l.inventoryBatchId, lotNumber: l.lotNumber,
        costReason: unitCost == null ? reason : undefined, warning: warningFor(line, l.lotNumber),
      };
    }));
    return finish(lines);
  }

  /**
   * Fields to freeze on a Sales Order and its items when saved, from the
   * lines it is saved with. An estimate only — no profit is recognized and
   * nothing is reserved. Never blocks saving: on any failure the order is
   * saved without an estimate (nulls), never with an invented cost.
   */
  static async salesOrderEstimateFields(computed: Parameters<typeof SalesProfitabilityService.estimateComputedLines>[0]) {
    try {
      const { lines, summary } = await this.estimateComputedLines(computed);
      return {
        order: {
          estimatedCostOfGoods: summary.costOfGoods,
          estimatedGrossProfit: summary.profit,
          estimatedMarginPct: summary.marginPct,
          costUnavailableLines: summary.costUnavailableLines,
          costEstimatedAt: new Date(),
        },
        items: lines.map((l) => ({ estimatedUnitCost: l.unitCost, estimatedCostOfGoods: l.costOfGoods, estimatedProfit: l.profit })),
      };
    } catch {
      return { order: {}, items: computed.map(() => ({})) };
    }
  }
}
