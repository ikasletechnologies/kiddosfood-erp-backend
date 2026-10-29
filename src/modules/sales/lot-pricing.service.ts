import { Prisma } from '@prisma/client';
import { hasCompleteSkuPrices, resolveSkuPriceMaster } from '../../utils/sku-pricing';
import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FranchiseService } from '../franchise/franchise.service';
import { canViewCost } from './profitability';
import { expiryCutoff, isLotExpired } from '../inventory/lot-eligibility';
import { lotLabel } from './lot-pricing';

/**
 * Finished-goods lots: listing (Stock Hub, Set Price "production lots") and
 * lot selection for sales documents / POS.
 *
 * The finished-goods lot is the existing InventoryBatch row a confirmed
 * packaging run creates (InventoryItem.category = FINISHED_GOOD) — no second
 * inventory model. A lot carries stock, its own production cost (unitCost),
 * expiry and traceability. It does NOT carry a selling price: the product's
 * Customer / Dealer / Franchise prices (Set Price, see product-pricing.service)
 * price every lot of it, so choosing a lot never changes what a line costs.
 * The old per-lot price columns are left untouched as history.
 */

export class LotPricingError extends Error {
  constructor(message: string, public code: string, public status = 400, public details?: unknown) { super(message); }
}

type User = { userId?: string; role?: string; franchiseId?: string | null } | null | undefined;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_PRICE = 10_000_000;

/** Inventory scope filter: HQ stock (franchiseId null or the HQ row) or one branch. */
export async function scopeWhere(tx: any, franchiseId: string | null | undefined): Promise<Prisma.InventoryItemWhereInput> {
  const scopeId = franchiseId ? await FranchiseService.toInventoryScopeId(tx, franchiseId) : null;
  if (scopeId) return { franchiseId: scopeId };
  const hq = await FranchiseService.getHqFranchiseOrNull(tx);
  return { OR: [{ franchiseId: null }, ...(hq ? [{ franchiseId: hq.id }] : [])] };
}

const sellable = (lot: { status: string; currentQty: number; expDate: Date | null }) =>
  lot.status === 'APPROVED' && lot.currentQty > 0.0001 && !isLotExpired(lot.expDate);

const lotInclude = {
  inventoryItem: { select: { id: true, name: true, sku: true, unit: true, gstRate: true, customerPrice: true, dealerPrice: true, franchisePrice: true, franchiseId: true, franchise: { select: { id: true, name: true } } } },
  productBatch: { select: { id: true, batchCode: true, mfgDate: true, production: { select: { id: true, warehouse: { select: { id: true, name: true } } } } } },
  productPackaging: { select: { id: true, packetSize: true, quantityPackets: true, goodQty: true, confirmedAt: true, costBreakdown: true } },
  warehouse: { select: { id: true, name: true } },
} satisfies Prisma.InventoryBatchInclude;

type LotRow = Prisma.InventoryBatchGetPayload<{ include: typeof lotInclude }>;

async function productsBySku(tx: any, skus: string[]) {
  const products = skus.length
    ? await tx.product.findMany({ where: { sku: { in: skus } }, select: { id: true, name: true, sku: true, category: true, taxPercent: true, basePrice: true, pricingStatus: true } })
    : [];
  return new Map<string, any>(await Promise.all(products.map(async (p: any) => {
    const master = await resolveSkuPriceMaster(tx, p.sku);
    return [p.sku, { ...p, pricingStatus: hasCompleteSkuPrices(master || {}) ? 'PRICED' : 'PENDING' }];
  })));
}

function shapeLot(lot: LotRow, product: any, reserved: number, opts: { showCost: boolean }) {
  const available = Math.max(0, lot.currentQty - reserved);
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
    pricingStatus: (product ? product.pricingStatus === 'PRICED' : hasCompleteSkuPrices(lot.inventoryItem)) ? 'PRICED' : 'PENDING',
    sellable: sellable(lot),
    taxPercent: lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5,
    // Production cost and stock value only for roles allowed to see cost.
    unitCost: opts.showCost ? (lot.unitCost ?? null) : undefined,
    stockValue: opts.showCost ? (lot.unitCost != null ? round2(lot.currentQty * lot.unitCost) : null) : undefined,
  };
}

export type ShapedLot = ReturnType<typeof shapeLot>;

export interface PricedLotLine {
  lotId: string;
  lotNumber: string;
  batchNumber: string;
  inventoryItemId: string;
  taxPercent: number;
  /** Production cost per LINE unit, or null when the lot has no recorded cost. */
  lotUnitCost: number | null;
  /** Stock units per line unit. */
  factor: number;
  product: { id: string; name: string; sku: string | null } | null;
}

export class LotPricingService {
  // ─── Lot listing (Stock Hub / Set Price production lots) ────────────────

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
      if (!user?.franchiseId) return { lots: [], summary: { totalLots: 0, sellableLots: 0, availableQty: 0, stockValue: undefined }, categories: [], showCost: false };
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

    const summary = {
      totalLots: lots.length,
      sellableLots: lots.filter((l) => l.sellable).length,
      availableQty: round2(lots.reduce((s, l) => s + (l.sellable ? l.availableQty : 0), 0)),
      stockValue: showCost ? round2(lots.reduce((s, l) => s + (l.stockValue || 0), 0)) : undefined,
    };
    const categories = [...new Set(lots.map((l) => l.category).filter(Boolean))].sort();
    return { lots, summary, categories, showCost };
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
    return {
      ...shapeLot(lot, products.get(lot.inventoryItem.sku), reserved, { showCost }),
      costBreakdown: showCost ? (lot.productPackaging?.costBreakdown ?? null) : undefined,
    };
  }

  private static async isFinishedGoodsLot(inventoryItemId: string) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { category: true } });
    return item?.category === 'FINISHED_GOOD';
  }

  // ─── Lot selection for sales documents / POS ─────────────────────────────

  /**
   * Lots of one product a sale can draw from, oldest first: approved,
   * unexpired, with stock net of reservations. `franchiseId` = seller branch
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
      .map((l) => ({ ...l, selectable: true }));
    return {
      lotTracked: rows.length > 0,
      unit: invItem.unit,
      lots,
      eligibleCount: lots.length,
      pendingCount: 0,
      showCost,
    };
  }

  /**
   * Resolves one sales line that names a lot: the lot must belong to the
   * line's product (Product id or InventoryItem id, matched by SKU), sit in
   * one of the allowed inventory scopes and be sellable. Returns the lot's
   * cost converted to the line's unit — the line's price is the product's
   * channel price (a lot never prices a line).
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
        taxPercent: lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5,
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
    if (!opts.referenceOnly && !sellable(lot)) {
      const why = lot.status !== 'APPROVED' ? `is ${String(lot.status).replace(/_/g, ' ')}`
        : isLotExpired(lot.expDate) ? 'has expired' : 'has no stock left';
      throw new LotPricingError(`Lot ${label} of "${name}" ${why} and cannot be sold.`, 'LOT_NOT_SELLABLE');
    }

    const factor = (await InventoryService.convertUnitToBase(lot.inventoryItemId, line.unit || 'NONE', 1, tx)).requiredBaseQty || 1;
    const taxPercent = lot.inventoryItem.gstRate ?? product?.taxPercent ?? 5;
    return {
      lotId: lot.id,
      lotNumber: label,
      batchNumber: lot.batchNumber,
      inventoryItemId: lot.inventoryItemId,
      taxPercent,
      lotUnitCost: lot.unitCost != null && lot.unitCost > 0 ? Math.round(lot.unitCost * factor * 10000) / 10000 : null,
      factor,
      product: product ? { id: product.id, name: product.name, sku: product.sku } : null,
    };
  }

  /**
   * Validates every line that names a lot and snapshots lot number + cost on
   * the line. Rates are left as they are: the product's channel price (or the
   * document's own update rules) prices lot and non-lot lines alike.
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
   * keeps its price, but the lot must still be sellable and cover
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
