import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FranchiseService } from '../franchise/franchise.service';
import { canViewCost } from './profitability';
import { expiryCutoff, isLotExpired } from '../inventory/lot-eligibility';
import {
  checkLotPrice, lotLabel, lotPricingStatus, priceExcludingTax, priceIncludingTax,
  LOT_PRICED, LOT_PRICING_PENDING,
} from './lot-pricing';

/**
 * Production > Set Price, and lot selection for sales documents / POS.
 *
 * The finished-goods lot is the existing InventoryBatch row a confirmed
 * packaging run creates (InventoryItem.category = FINISHED_GOOD) — no second
 * inventory model. Selling price lives on that row; production cost
 * (unitCost) is read-only here.
 */

export class LotPricingError extends Error {
  constructor(message: string, public code: string, public status = 400, public details?: unknown) { super(message); }
}

type User = { userId?: string; role?: string; franchiseId?: string | null } | null | undefined;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_PRICE = 10_000_000;

/** Inventory scope filter: HQ stock (franchiseId null or the HQ row) or one branch. */
async function scopeWhere(tx: any, franchiseId: string | null | undefined): Promise<Prisma.InventoryItemWhereInput> {
  const scopeId = franchiseId ? await FranchiseService.toInventoryScopeId(tx, franchiseId) : null;
  if (scopeId) return { franchiseId: scopeId };
  const hq = await FranchiseService.getHqFranchiseOrNull(tx);
  return { OR: [{ franchiseId: null }, ...(hq ? [{ franchiseId: hq.id }] : [])] };
}

const sellable = (lot: { status: string; currentQty: number; expDate: Date | null }) =>
  lot.status === 'APPROVED' && lot.currentQty > 0.0001 && !isLotExpired(lot.expDate);

const lotInclude = {
  inventoryItem: { select: { id: true, name: true, sku: true, unit: true, gstRate: true, franchiseId: true, customerPrice: true, basePrice: true, franchise: { select: { id: true, name: true } } } },
  productBatch: { select: { id: true, batchCode: true, mfgDate: true, production: { select: { id: true, warehouse: { select: { id: true, name: true } } } } } },
  productPackaging: { select: { id: true, packetSize: true, quantityPackets: true, goodQty: true, confirmedAt: true, costBreakdown: true } },
  warehouse: { select: { id: true, name: true } },
} satisfies Prisma.InventoryBatchInclude;

type LotRow = Prisma.InventoryBatchGetPayload<{ include: typeof lotInclude }>;

async function productsBySku(tx: any, skus: string[]) {
  const products = skus.length
    ? await tx.product.findMany({ where: { sku: { in: skus } }, select: { id: true, name: true, sku: true, category: true, taxPercent: true, basePrice: true, pricingStatus: true } })
    : [];
  return new Map<string, any>(products.map((p: any) => [p.sku, p]));
}

function shapeLot(lot: LotRow, product: any, reserved: number, opts: { showCost: boolean }) {
  const taxPercent = lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5;
  const priced = lot.sellingPrice != null && lot.sellingPrice > 0;
  const check = priced
    ? checkLotPrice({ price: lot.sellingPrice!, taxInclusive: lot.priceTaxInclusive, taxPercent, unitCost: lot.unitCost })
    : null;
  const available = Math.max(0, lot.currentQty - reserved);
  const masterPrice = (lot.inventoryItem.customerPrice && lot.inventoryItem.customerPrice > 0)
    ? lot.inventoryItem.customerPrice
    : (lot.inventoryItem.basePrice || product?.basePrice || null);
  return {
    id: lot.id,
    lotNumber: lotLabel(lot),
    batchNumber: lot.batchNumber,
    productId: product?.id ?? null,
    productName: product?.name ?? lot.inventoryItem.name,
    sku: lot.inventoryItem.sku,
    category: product?.category ?? null,
    inventoryItemId: lot.inventoryItem.id,
    unit: lot.inventoryItem.unit,
    location: lot.inventoryItem.franchiseId ? (lot.inventoryItem.franchise?.name || 'Branch') : 'HQ',
    franchiseId: lot.inventoryItem.franchiseId,
    productionBatchId: lot.productBatch?.id ?? null,
    productionBatchCode: lot.productBatch?.batchCode ?? null,
    packagingId: lot.productPackaging?.id ?? null,
    packSize: lot.productPackaging?.packetSize ?? null,
    source: lot.productPackagingId ? 'PACKAGING' : lot.productBatchId ? 'PRODUCTION' : 'OTHER',
    producedQty: lot.initialQty,
    currentQty: lot.currentQty,
    reservedQty: reserved,
    availableQty: available,
    productionDate: lot.mfgDate ?? lot.productBatch?.mfgDate ?? null,
    packagingDate: lot.productPackaging?.confirmedAt ?? lot.createdAt,
    expiryDate: lot.expDate,
    warehouse: lot.warehouse ?? lot.productBatch?.production?.warehouse ?? null,
    stockStatus: lot.status,
    sellable: sellable(lot),
    taxPercent,
    pricingStatus: lotPricingStatus(lot),
    sellingPrice: priced ? lot.sellingPrice : null,
    priceTaxInclusive: lot.priceTaxInclusive,
    sellingPriceExclTax: check?.priceExclTax ?? null,
    sellingPriceInclTax: priced ? priceIncludingTax(lot.sellingPrice!, lot.priceTaxInclusive, taxPercent) : null,
    pricedAt: lot.pricedAt,
    pricedBy: lot.pricedBy,
    masterPrice,
    // Production cost and margins only for roles allowed to see cost.
    unitCost: opts.showCost ? (lot.unitCost ?? null) : undefined,
    unitProfit: opts.showCost ? (check?.unitProfit ?? null) : undefined,
    marginPct: opts.showCost ? (check?.marginPct ?? null) : undefined,
    belowCost: opts.showCost ? (check?.belowCost ?? false) : undefined,
  };
}

export type ShapedLot = ReturnType<typeof shapeLot>;

/** Sellable lots of one product: priced ones (with their price range) and ones awaiting a price. */
export interface LotPriceSummary {
  pricedLots: number;
  pendingLots: number;
  pricedQty: number;
  pendingQty: number;
  /** Lowest / highest lot selling price per stock unit, excl. GST. */
  minPrice: number | null;
  maxPrice: number | null;
}

export interface PricedLotLine {
  lotId: string;
  lotNumber: string;
  batchNumber: string;
  inventoryItemId: string;
  /** Lot selling price excl. GST per LINE unit (lot price per packet × unit factor). */
  rate: number;
  taxPercent: number;
  /** Production cost per LINE unit, or null when the lot has no recorded cost. */
  lotUnitCost: number | null;
  /** Stock units per line unit. */
  factor: number;
  product: { id: string; name: string; sku: string | null } | null;
}

export class LotPricingService {
  // ─── Set Price page ──────────────────────────────────────────────────────

  static async listLots(filters: {
    search?: string; category?: string; status?: string; warehouseId?: string;
    from?: string; to?: string; location?: string; includeEmpty?: string | boolean;
    /** Exact SKU — the Stock Hub's lot rows for one product. */
    sku?: string;
  }, user: User) {
    const where: Prisma.InventoryBatchWhereInput = { inventoryItem: { category: 'FINISHED_GOOD', ...(filters.sku ? { sku: String(filters.sku) } : {}) } };
    const and: Prisma.InventoryBatchWhereInput[] = [];

    // Franchise admins only ever see their own branch's lots. Super admin
    // picks a location: HQ (default), one branch, or ALL.
    if (user?.role !== 'SUPER_ADMIN') {
      if (!user?.franchiseId) return { lots: [], summary: emptySummary(), locations: [] };
      and.push({ inventoryItem: await scopeWhere(prisma, user.franchiseId) });
    } else if (filters.location && filters.location !== 'ALL') {
      and.push({ inventoryItem: await scopeWhere(prisma, filters.location === 'HQ' ? null : filters.location) });
    } else if (!filters.location) {
      and.push({ inventoryItem: await scopeWhere(prisma, null) });
    }

    const includeEmpty = filters.includeEmpty === true || filters.includeEmpty === 'true';
    if (!includeEmpty) and.push({ currentQty: { gt: 0.0001 } });
    if (filters.warehouseId) and.push({ OR: [{ warehouseId: filters.warehouseId }, { productBatch: { production: { warehouseId: filters.warehouseId } } }] });
    if (filters.from || filters.to) {
      const range: Prisma.DateTimeFilter = {};
      if (filters.from) range.gte = new Date(`${filters.from.slice(0, 10)}T00:00:00.000Z`);
      if (filters.to) range.lte = new Date(`${filters.to.slice(0, 10)}T23:59:59.999Z`);
      and.push({ OR: [{ mfgDate: range }, { mfgDate: null, createdAt: range }] });
    }
    if (filters.status === LOT_PRICED) and.push({ sellingPrice: { gt: 0 } });
    if (filters.status === LOT_PRICING_PENDING) and.push({ OR: [{ sellingPrice: null }, { sellingPrice: { lte: 0 } }] });
    if (filters.search?.trim()) {
      const s = filters.search.trim();
      and.push({
        OR: [
          { inventoryItem: { name: { contains: s, mode: 'insensitive' } } },
          { inventoryItem: { sku: { contains: s, mode: 'insensitive' } } },
          { lotNumber: { contains: s, mode: 'insensitive' } },
          { batchNumber: { contains: s, mode: 'insensitive' } },
        ],
      });
    }
    if (and.length) where.AND = and;

    const rows = await prisma.inventoryBatch.findMany({
      where,
      include: lotInclude,
      orderBy: [{ mfgDate: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
    });
    const products = await productsBySku(prisma, [...new Set(rows.map((r) => r.inventoryItem.sku))]);
    const reserved = await InventoryService.reservedQtyByLot(prisma, rows.map((r) => r.id));
    const showCost = canViewCost(user);

    let lots = rows.map((r) => shapeLot(r, products.get(r.inventoryItem.sku), reserved.get(r.id) || 0, { showCost }));
    if (filters.category) lots = lots.filter((l) => (l.category || '').toUpperCase() === filters.category!.toUpperCase());

    const priced = lots.filter((l) => l.pricingStatus === LOT_PRICED);
    const summary = {
      totalLots: lots.length,
      awaitingPricing: lots.length - priced.length,
      pricedLots: priced.length,
      availablePricedQty: round2(priced.reduce((s, l) => s + (l.sellable ? l.availableQty : 0), 0)),
      availablePricedValue: round2(priced.reduce((s, l) => s + (l.sellable ? l.availableQty * (l.sellingPriceExclTax || 0) : 0), 0)),
    };
    const categories = [...new Set(lots.map((l) => l.category).filter(Boolean))].sort();
    return { lots, summary, categories, canEdit: user?.role === 'SUPER_ADMIN', showCost };
  }

  static async getLot(id: string, user: User) {
    const lot = await prisma.inventoryBatch.findUnique({ where: { id }, include: lotInclude });
    if (!lot || !(await this.isFinishedGoodsLot(lot.inventoryItemId))) throw new LotPricingError('Finished-goods lot not found.', 'NOT_FOUND', 404);
    if (user?.role !== 'SUPER_ADMIN') {
      const scope = user?.franchiseId ? await FranchiseService.toInventoryScopeId(prisma, user.franchiseId) : undefined;
      if (scope === undefined || lot.inventoryItem.franchiseId !== scope) throw new LotPricingError('Finished-goods lot not found.', 'NOT_FOUND', 404);
    }
    const products = await productsBySku(prisma, [lot.inventoryItem.sku]);
    const reserved = (await InventoryService.reservedQtyByLot(prisma, [lot.id])).get(lot.id) || 0;
    const showCost = canViewCost(user);
    const history = await prisma.finishedGoodsLotPriceHistory.findMany({ where: { inventoryBatchId: id }, orderBy: { effectiveAt: 'desc' } });
    const userIds = [...new Set(history.map((h) => h.changedBy).concat(lot.pricedBy ? [lot.pricedBy] : []).filter(Boolean) as string[])];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }) : [];
    const nameOf = (uid: string | null) => (uid ? users.find((u) => u.id === uid)?.fullName || users.find((u) => u.id === uid)?.email || uid : null);
    const shaped = shapeLot(lot, products.get(lot.inventoryItem.sku), reserved, { showCost });
    return {
      ...shaped,
      pricedByName: nameOf(lot.pricedBy),
      costBreakdown: showCost ? (lot.productPackaging?.costBreakdown ?? null) : undefined,
      history: history.map((h) => ({
        id: h.id,
        previousPrice: h.previousPrice,
        previousTaxInclusive: h.previousTaxInclusive,
        newPrice: h.newPrice,
        taxInclusive: h.taxInclusive,
        unitCostAtChange: showCost ? h.unitCostAtChange : undefined,
        belowCost: showCost ? h.belowCost : undefined,
        reason: h.reason,
        changedBy: nameOf(h.changedBy),
        effectiveAt: h.effectiveAt,
      })),
    };
  }

  private static async isFinishedGoodsLot(inventoryItemId: string) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { category: true } });
    return item?.category === 'FINISHED_GOOD';
  }

  /**
   * Sets or changes one lot's selling price. Production cost is never
   * touched. Below-cost prices need an explicit acknowledgement, and
   * `expectedPrice` (what the editor last saw) rejects a stale overwrite.
   * Every change appends a history row in the same transaction.
   */
  static async setPrice(id: string, input: {
    sellingPrice: unknown; taxInclusive?: unknown; reason?: unknown;
    acknowledgeBelowCost?: unknown; expectedPrice?: unknown;
  }, user: User) {
    const price = Number(input.sellingPrice);
    if (!Number.isFinite(price) || price <= 0) throw new LotPricingError('Enter a selling price greater than ₹0.', 'INVALID_PRICE');
    if (price > MAX_PRICE) throw new LotPricingError('Selling price is too large.', 'INVALID_PRICE');
    if (Math.abs(round2(price) - price) > 1e-9) throw new LotPricingError('Selling price can have at most 2 decimal places.', 'INVALID_PRICE');
    const taxInclusive = input.taxInclusive === true || input.taxInclusive === 'true';
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) || null : null;

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "InventoryBatch" WHERE id = ${id} FOR UPDATE`;
      const lot = await tx.inventoryBatch.findUnique({ where: { id }, include: { inventoryItem: { select: { category: true, gstRate: true, sku: true } } } });
      if (!lot || lot.inventoryItem.category !== 'FINISHED_GOOD') throw new LotPricingError('Finished-goods lot not found.', 'NOT_FOUND', 404);

      const previous = lot.sellingPrice != null && lot.sellingPrice > 0 ? lot.sellingPrice : null;
      if (input.expectedPrice !== undefined) {
        const expected = input.expectedPrice === null || input.expectedPrice === '' ? null : Number(input.expectedPrice);
        if ((expected ?? null) !== (previous ?? null) && !(expected != null && previous != null && Math.abs(expected - previous) < 0.001)) {
          throw new LotPricingError('This lot\'s price was just changed by someone else. Refresh and try again.', 'STALE_PRICE', 409);
        }
      }
      if (previous != null && Math.abs(previous - price) < 0.001 && lot.priceTaxInclusive === taxInclusive) {
        return { changed: false, lotId: id };
      }

      const product = await tx.product.findUnique({ where: { sku: lot.inventoryItem.sku }, select: { taxPercent: true } });
      const taxPercent = lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5;
      const check = checkLotPrice({ price, taxInclusive, taxPercent, unitCost: lot.unitCost });
      if (check.belowCost && !(input.acknowledgeBelowCost === true || input.acknowledgeBelowCost === 'true')) {
        throw new LotPricingError(check.warning!, 'BELOW_COST_CONFIRMATION_REQUIRED', 409, check);
      }

      const now = new Date();
      await tx.finishedGoodsLotPriceHistory.create({
        data: {
          inventoryBatchId: id,
          previousPrice: previous,
          previousTaxInclusive: previous != null ? lot.priceTaxInclusive : null,
          newPrice: price,
          taxInclusive,
          unitCostAtChange: lot.unitCost ?? null,
          belowCost: check.belowCost,
          reason,
          changedBy: user?.userId || null,
          effectiveAt: now,
        },
      });
      await tx.inventoryBatch.update({
        where: { id },
        data: { sellingPrice: price, priceTaxInclusive: taxInclusive, pricingStatus: LOT_PRICED, pricedAt: now, pricedBy: user?.userId || null },
      });
      return { changed: true, lotId: id, previousPrice: previous, sellingPrice: price, taxInclusive, ...check };
    });
  }

  // ─── Product catalogue: lot price summary ─────────────────────────────────

  /**
   * Per finished-goods stock item, what its sellable lots are priced at —
   * attached to the product list (POS search, Sales Order / Estimate /
   * Proforma / Invoice item search) so a product whose price lives on its
   * Set Price lots never shows ₹0 / "No price". Sellable = approved, not
   * expired, stock left after reservations. Prices are per stock unit,
   * excluding GST. Read fresh on every request (no cache to go stale).
   */
  static async lotPriceSummaries(inventoryItemIds: string[]): Promise<Map<string, LotPriceSummary>> {
    const out = new Map<string, LotPriceSummary>();
    const ids = [...new Set(inventoryItemIds.filter(Boolean))];
    if (!ids.length) return out;
    const lots = await prisma.inventoryBatch.findMany({
      where: { inventoryItemId: { in: ids }, currentQty: { gt: 0.0001 }, status: 'APPROVED', inventoryItem: { category: 'FINISHED_GOOD' } },
      select: { id: true, inventoryItemId: true, currentQty: true, expDate: true, sellingPrice: true, priceTaxInclusive: true, inventoryItem: { select: { gstRate: true } } },
    });
    const reserved = await InventoryService.reservedQtyByLot(prisma, lots.map((l) => l.id));
    for (const lot of lots) {
      if (isLotExpired(lot.expDate)) continue;
      const available = Math.max(0, lot.currentQty - (reserved.get(lot.id) || 0));
      if (available <= 0.0001) continue;
      const s = out.get(lot.inventoryItemId) || { pricedLots: 0, pendingLots: 0, pricedQty: 0, pendingQty: 0, minPrice: null, maxPrice: null };
      if (lot.sellingPrice != null && lot.sellingPrice > 0) {
        const p = priceExcludingTax(lot.sellingPrice, lot.priceTaxInclusive, lot.inventoryItem.gstRate ?? 5);
        s.pricedLots += 1;
        s.pricedQty = round2(s.pricedQty + available);
        s.minPrice = s.minPrice == null ? p : Math.min(s.minPrice, p);
        s.maxPrice = s.maxPrice == null ? p : Math.max(s.maxPrice, p);
      } else {
        s.pendingLots += 1;
        s.pendingQty = round2(s.pendingQty + available);
      }
      out.set(lot.inventoryItemId, s);
    }
    return out;
  }

  // ─── Lot selection for sales documents / POS ─────────────────────────────

  /**
   * Lots of one product a sale can draw from, oldest first: approved,
   * unexpired, with stock net of reservations. Unpriced lots are listed as
   * not selectable so the operator knows why. `franchiseId` = seller branch
   * (POS / branch invoice); omitted = HQ stock (Estimate, Sales Order, …).
   */
  static async saleLotOptions(params: { productId: string; franchiseId?: string | null }, user: User) {
    const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true, name: true, sku: true, taxPercent: true, basePrice: true } })
      || await prisma.product.findFirst({ where: { sku: params.productId }, select: { id: true, name: true, sku: true, taxPercent: true, basePrice: true } });
    let invItem: { id: string; sku: string; unit: string } | null = null;
    if (product?.sku) {
      invItem = await prisma.inventoryItem.findFirst({ where: { sku: product.sku, ...(await scopeWhere(prisma, params.franchiseId)) }, select: { id: true, sku: true, unit: true } });
    } else if (!product) {
      invItem = await prisma.inventoryItem.findFirst({ where: { id: params.productId, ...(await scopeWhere(prisma, params.franchiseId)) }, select: { id: true, sku: true, unit: true } });
    }
    if (!invItem) return { lotTracked: false, unit: null, lots: [], eligibleCount: 0, pendingCount: 0 };

    const rows = await prisma.inventoryBatch.findMany({
      where: { inventoryItemId: invItem.id, currentQty: { gt: 0.0001 }, status: 'APPROVED', OR: [{ expDate: null }, { expDate: { gte: expiryCutoff() } }] },
      include: lotInclude,
      orderBy: [{ mfgDate: 'asc' }, { createdAt: 'asc' }],
    });
    const products = await productsBySku(prisma, [invItem.sku]);
    const reserved = await InventoryService.reservedQtyByLot(prisma, rows.map((r) => r.id));
    const showCost = canViewCost(user);
    const lots = rows
      .map((r) => shapeLot(r, products.get(invItem!.sku) || product, reserved.get(r.id) || 0, { showCost }))
      .filter((l) => l.availableQty > 0.0001)
      .map((l) => ({ ...l, selectable: l.pricingStatus === LOT_PRICED }));
    return {
      lotTracked: rows.length > 0,
      unit: invItem.unit,
      lots,
      eligibleCount: lots.filter((l) => l.selectable).length,
      pendingCount: lots.filter((l) => !l.selectable).length,
      showCost,
    };
  }

  /**
   * Resolves one sales line that names a lot: the lot must belong to the
   * line's product (Product id or InventoryItem id, matched by SKU), sit in
   * one of the allowed inventory scopes, be sellable and priced. Returns the
   * lot's price and cost converted to the line's unit.
   */
  static async resolveSaleLot(tx: any, line: { productId?: string | null; productName?: string | null; inventoryBatchId: string; unit?: string | null }, opts: { franchiseId?: string | null; anyScope?: boolean; referenceOnly?: boolean } = {}): Promise<PricedLotLine> {
    const lot = await tx.inventoryBatch.findUnique({
      where: { id: line.inventoryBatchId },
      include: { inventoryItem: { select: { id: true, sku: true, name: true, category: true, gstRate: true, franchiseId: true } } },
    });
    const name = line.productName || lot?.inventoryItem?.name || 'item';
    if (!lot || lot.inventoryItem.category !== 'FINISHED_GOOD') throw new LotPricingError(`Selected lot for "${name}" was not found.`, 'LOT_NOT_FOUND');
    const label = lotLabel(lot);

    let product: { id: string; name: string; sku: string | null; taxPercent: number } | null = null;
    if (line.productId) {
      product = await tx.product.findUnique({ where: { id: line.productId }, select: { id: true, name: true, sku: true, taxPercent: true } });
      const matches = product ? product.sku === lot.inventoryItem.sku : line.productId === lot.inventoryItemId
        || (await tx.inventoryItem.findUnique({ where: { id: line.productId }, select: { sku: true } }))?.sku === lot.inventoryItem.sku;
      if (!matches) throw new LotPricingError(`Lot ${label} is not a lot of "${name}".`, 'LOT_PRODUCT_MISMATCH');
    }
    if (!product) product = await tx.product.findUnique({ where: { sku: lot.inventoryItem.sku }, select: { id: true, name: true, sku: true, taxPercent: true } });

    // Reference-only (Delivery Challan): the lot just travels with the goods
    // for traceability — it may already be sold out by the invoice the
    // challan delivers — so no scope, stock or price checks.
    if (opts.referenceOnly) {
      const factor = (await InventoryService.convertUnitToBase(lot.inventoryItemId, line.unit || 'NONE', 1, tx)).requiredBaseQty || 1;
      return {
        lotId: lot.id, lotNumber: label, batchNumber: lot.batchNumber, inventoryItemId: lot.inventoryItemId,
        rate: 0, taxPercent: lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5,
        lotUnitCost: lot.unitCost != null && lot.unitCost > 0 ? Math.round(lot.unitCost * factor * 10000) / 10000 : null,
        factor,
        product: product ? { id: product.id, name: product.name, sku: product.sku } : null,
      };
    }

    if (!opts.anyScope) {
      const scope = await scopeWhere(tx, opts.franchiseId);
      const inScope = await tx.inventoryItem.count({ where: { id: lot.inventoryItemId, ...scope } });
      if (!inScope) throw new LotPricingError(`Lot ${label} is not held at the selling location.`, 'LOT_SCOPE');
    }
    if (!sellable(lot)) {
      const why = lot.status !== 'APPROVED' ? `is ${String(lot.status).replace(/_/g, ' ')}`
        : isLotExpired(lot.expDate) ? 'has expired' : 'has no stock left';
      throw new LotPricingError(`Lot ${label} of "${name}" ${why} and cannot be sold.`, 'LOT_NOT_SELLABLE');
    }
    if (!(lot.sellingPrice > 0)) {
      throw new LotPricingError(`Lot ${label} of "${name}" has no selling price. Set its price in Production > Set Price first.`, 'LOT_UNPRICED');
    }

    const factor = (await InventoryService.convertUnitToBase(lot.inventoryItemId, line.unit || 'NONE', 1, tx)).requiredBaseQty || 1;
    const taxPercent = lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5;
    const perPacket = priceExcludingTax(lot.sellingPrice, lot.priceTaxInclusive, taxPercent);
    return {
      lotId: lot.id,
      lotNumber: label,
      batchNumber: lot.batchNumber,
      inventoryItemId: lot.inventoryItemId,
      rate: round2(perPacket * factor),
      taxPercent,
      lotUnitCost: lot.unitCost != null && lot.unitCost > 0 ? Math.round(lot.unitCost * factor * 10000) / 10000 : null,
      factor,
      product: product ? { id: product.id, name: product.name, sku: product.sku } : null,
    };
  }

  /**
   * Re-prices every line that names a lot from that lot's current Set Price
   * (excl. GST) and snapshots lot number + cost on the line. Lines without a
   * lot are returned untouched (the existing pricing flow handles them).
   * With `checkStock`, the combined quantity drawn from each lot must fit its
   * available stock (net of reservations) — used by documents that commit
   * stock (Sales Order, Invoice, Challan); Estimates/Proformas skip it.
   */
  static async applyLotPricing<T extends { productId?: string; productName?: string; inventoryBatchId?: string | null; unit?: string | null; quantity: number; rate: number; taxPercent?: number }>(
    tx: any, items: T[], opts: { franchiseId?: string | null; anyScope?: boolean; checkStock?: boolean; referenceOnly?: boolean } = {},
  ): Promise<Array<T & { lotNumber?: string | null; lotUnitCost?: number | null; batchNumber?: string }>> {
    const out: Array<T & { lotNumber?: string | null; lotUnitCost?: number | null; batchNumber?: string }> = [];
    const claims = new Map<string, { qty: number; label: string }>();
    for (const item of items) {
      const lotId = typeof item.inventoryBatchId === 'string' ? item.inventoryBatchId.trim() : '';
      if (!lotId) { out.push({ ...item, inventoryBatchId: null, lotNumber: null, lotUnitCost: null }); continue; }
      const resolved = await this.resolveSaleLot(tx, { ...item, inventoryBatchId: lotId }, opts);
      if (opts.referenceOnly) {
        out.push({ ...item, inventoryBatchId: lotId, lotNumber: resolved.lotNumber, lotUnitCost: resolved.lotUnitCost, batchNumber: resolved.batchNumber });
        continue;
      }
      const baseQty = (Number(item.quantity) || 0) * resolved.factor;
      const prior = claims.get(lotId);
      claims.set(lotId, { qty: (prior?.qty || 0) + baseQty, label: resolved.lotNumber });
      out.push({
        ...item,
        inventoryBatchId: lotId,
        rate: resolved.rate,
        taxPercent: resolved.taxPercent,
        lotNumber: resolved.lotNumber,
        lotUnitCost: resolved.lotUnitCost,
        batchNumber: resolved.batchNumber,
      });
    }
    if (opts.checkStock && claims.size) await this.assertLotStock(tx, claims);
    return out;
  }

  /** Each lot's combined claimed quantity (stock units) must fit its stock net of active reservations. */
  static async assertLotStock(tx: any, claims: Map<string, { qty: number; label: string }>) {
    const ids = [...claims.keys()];
    const lots: Array<{ id: string; currentQty: number }> = await tx.inventoryBatch.findMany({ where: { id: { in: ids } }, select: { id: true, currentQty: true } });
    const reserved = await InventoryService.reservedQtyByLot(tx, ids);
    for (const [id, claim] of claims) {
      const lot = lots.find((l) => l.id === id);
      const available = Math.max(0, (lot?.currentQty || 0) - (reserved.get(id) || 0));
      if (claim.qty > available + 0.0001) {
        throw new LotPricingError(`Lot ${claim.label} has only ${Math.round(available * 1000) / 1000} available; ${Math.round(claim.qty * 1000) / 1000} selected.`, 'LOT_INSUFFICIENT_STOCK');
      }
    }
  }

  /**
   * Conversion check (Estimate → Order, Order → Invoice, …): each lot line
   * keeps its price snapshot, but the lot must still be sellable and cover
   * the quantity. Lines without a lot are not checked (unchanged behaviour).
   */
  static async revalidateLotLines(tx: any, lines: Array<{ productId?: string | null; productName?: string | null; inventoryBatchId?: string | null; unit?: string | null; quantity: number }>) {
    const claims = new Map<string, { qty: number; label: string }>();
    for (const line of lines) {
      if (!line.inventoryBatchId) continue;
      const lot = await tx.inventoryBatch.findUnique({ where: { id: line.inventoryBatchId }, select: { id: true, lotNumber: true, batchNumber: true, status: true, currentQty: true, expDate: true, inventoryItemId: true } });
      const label = lot ? lotLabel(lot) : line.inventoryBatchId;
      if (!lot) throw new LotPricingError(`Lot ${label} on "${line.productName || 'item'}" no longer exists.`, 'LOT_NOT_FOUND');
      if (!sellable(lot)) throw new LotPricingError(`Lot ${label} on "${line.productName || 'item'}" can no longer be sold (expired, blocked or out of stock). Choose another lot.`, 'LOT_NOT_SELLABLE');
      const factor = (await InventoryService.convertUnitToBase(lot.inventoryItemId, line.unit || 'NONE', 1, tx)).requiredBaseQty || 1;
      const prior = claims.get(lot.id);
      claims.set(lot.id, { qty: (prior?.qty || 0) + (Number(line.quantity) || 0) * factor, label });
    }
    if (claims.size) await this.assertLotStock(tx, claims);
  }
}

function emptySummary() {
  return { totalLots: 0, awaitingPricing: 0, pricedLots: 0, availablePricedQty: 0, availablePricedValue: 0 };
}
