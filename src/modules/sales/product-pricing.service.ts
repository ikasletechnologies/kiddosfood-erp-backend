import { PRICING_FIELDS, PricingField, readPricing, mergePricing, mrpWarnings } from './sku-price-fields';
import { resolveSkuPriceMaster, hasCompleteSkuPrices } from '../../utils/sku-pricing';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { isLotExpired } from '../inventory/lot-eligibility';
import { canViewCost } from './profitability';
import { LotPricingError, scopeWhere } from './lot-pricing.service';
import { checkLotPrice, priceExcludingTax, priceIncludingTax, canEditLotPrice } from './lot-pricing';
import { PRICED, PRICING_PENDING } from '../../utils/selling-price.util';

/**
 * Production > Set Price — product-level selling prices.
 *
 * Every finished product SKU (pack size is part of the SKU: APPAM 250g and
 * APPAM 500g are different products) has three selling prices, one per
 * party type: Customer, Dealer and Franchise. They are the existing channel
 * price columns on the product's stock item (InventoryItem.customerPrice /
 * dealerPrice / franchisePrice) that Sales Orders, Estimates, Proformas,
 * Sale Invoices and POS already bill from — so setting them here is all it
 * takes for every sales document to pick the right price for the party.
 *
 * Prices are set once. Later production runs add new lots with their own
 * production cost, but never reset or change the prices: lots carry stock,
 * cost, expiry and traceability only.
 *
 * Stored prices are per stock unit (packet) EXCLUDING GST, the ERP's existing
 * policy (tax is added on top at billing). Prices may be entered including
 * GST; they are converted (to the paisa) before saving and the entered basis
 * is kept in the audit trail.
 */

export const PRODUCT_FULLY_PRICED = 'FULLY_PRICED';
export const PRODUCT_PRICING_PENDING = 'PRICING_PENDING';

export const PRICE_TIERS = [
  { key: 'customerPrice', label: 'Customer' },
  { key: 'dealerPrice', label: 'Dealer' },
  { key: 'franchisePrice', label: 'Franchise' },
] as const;
export type PriceTier = typeof PRICE_TIERS[number]['key'];
type TierPrices = Record<PriceTier, number | null>;

const AUDIT_MODULE = 'SET_PRICE';
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

type User = { userId?: string; role?: string; franchiseId?: string | null } | null | undefined;

export function pricingStatusOf(prices: TierPrices): string {
  return hasCompleteSkuPrices(prices) ? PRODUCT_FULLY_PRICED : PRODUCT_PRICING_PENDING;
}

const itemSelect = {
  id: true, name: true, sku: true, unit: true, gstRate: true, franchiseId: true, isActive: true,
  customerPrice: true, dealerPrice: true, franchisePrice: true, upcountryFranchisePrice: true, mrp: true, whiteLabelCost: true, basePrice: true, updatedAt: true,
  franchise: { select: { id: true, name: true } },
} satisfies Prisma.InventoryItemSelect;
type ItemRow = Prisma.InventoryItemGetPayload<{ select: typeof itemSelect }>;

const lotSelect = {
  id: true, inventoryItemId: true, lotNumber: true, batchNumber: true, currentQty: true, status: true, expDate: true,
  unitCost: true, createdAt: true, sellingPrice: true, priceTaxInclusive: true,
  warehouse: { select: { id: true, name: true } },
  productPackaging: { select: { packetSize: true } },
} satisfies Prisma.InventoryBatchSelect;
type LotRow = Prisma.InventoryBatchGetPayload<{ select: typeof lotSelect }>;

/** Prices, stock and latest cost of one finished product (one stock item). */
function shapeProduct(item: ItemRow, product: any, lots: LotRow[], reserved: Map<string, number>, showCost: boolean) {
  const prices = readPricing(item);
  const taxPercent = item.gstRate ?? product?.taxPercent ?? 5;
  const newestFirst = [...lots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latestCost = newestFirst.find((l) => l.unitCost != null && Number.isFinite(l.unitCost))?.unitCost ?? null;
  const sellable = lots.filter((l) => l.status === 'APPROVED' && l.currentQty > 0.0001 && !isLotExpired(l.expDate));
  const availableQty = round2(sellable.reduce((s, l) => s + Math.max(0, l.currentQty - (reserved.get(l.id) || 0)), 0));
  const totalQty = round2(lots.reduce((s, l) => s + Math.max(0, l.currentQty), 0));
  const stockValue = round2(lots.reduce((s, l) => s + Math.max(0, l.currentQty) * (l.unitCost || 0), 0));
  // A price set on a lot under the old per-lot Set Price — shown only as a
  // hint when the product's own prices are still missing; never applied.
  const legacy = newestFirst.find((l) => l.sellingPrice != null && l.sellingPrice > 0);
  const tiers = PRICE_TIERS.map((t) => {
    const price = prices[t.key];
    const check = price != null && showCost && latestCost != null
      ? checkLotPrice({ price, taxInclusive: false, taxPercent, unitCost: latestCost })
      : null;
    return {
      key: t.key,
      label: t.label,
      price,
      priceInclTax: price != null ? priceIncludingTax(price, false, taxPercent) : null,
      unitProfit: showCost ? (check?.unitProfit ?? null) : undefined,
      marginPct: showCost ? (check?.marginPct ?? null) : undefined,
      belowCost: showCost ? (check?.belowCost ?? false) : undefined,
    };
  });
  return {
    id: item.id,
    productId: product?.id ?? null,
    name: product?.name ?? item.name,
    sku: item.sku,
    category: product?.category ?? null,
    unit: item.unit,
    packSize: newestFirst.find((l) => l.productPackaging?.packetSize)?.productPackaging?.packetSize ?? null,
    location: item.franchiseId ? (item.franchise?.name || 'Branch') : 'HQ',
    franchiseId: item.franchiseId,
    taxPercent,
    ...prices,
    tiers,
    mrpWarnings: mrpWarnings(prices, taxPercent),
    pricingStatus: pricingStatusOf(prices),
    missingTiers: PRICE_TIERS.filter((t) => prices[t.key] == null).map((t) => t.label),
    lotCount: lots.length,
    sellableLotCount: sellable.length,
    availableQty,
    totalQty,
    warehouses: [...new Map(lots.filter((l) => l.warehouse).map((l) => [l.warehouse!.id, l.warehouse!])).values()],
    latestLotNumber: newestFirst[0] ? (newestFirst[0].lotNumber || newestFirst[0].batchNumber) : null,
    latestProductionAt: newestFirst[0]?.createdAt ?? null,
    legacyLotPrice: legacy && pricingStatusOf(prices) !== PRODUCT_FULLY_PRICED
      ? { price: priceExcludingTax(legacy.sellingPrice!, legacy.priceTaxInclusive, taxPercent), lotNumber: legacy.lotNumber || legacy.batchNumber }
      : null,
    // Cost figures only for roles allowed to see cost.
    latestCost: showCost ? latestCost : undefined,
    stockValue: showCost ? stockValue : undefined,
  };
}

export type ShapedProductPricing = ReturnType<typeof shapeProduct>;

export class ProductPricingService {
  /** Location the caller may see: a branch user only their branch; super admin HQ (default), a branch, or ALL. */
  private static async itemScope(user: User, location?: string): Promise<Prisma.InventoryItemWhereInput | null> {
    if (user?.role !== 'SUPER_ADMIN') return user?.franchiseId ? scopeWhere(prisma, user.franchiseId) : null;
    if (location === 'ALL') return {};
    return scopeWhere(prisma, location && location !== 'HQ' ? location : null);
  }

  private static async load(where: Prisma.InventoryItemWhereInput, showCost: boolean) {
    const items = await prisma.inventoryItem.findMany({ where: { category: 'FINISHED_GOOD', ...where }, select: itemSelect, orderBy: { name: 'asc' } });
    const ids = items.map((i) => i.id);
    const [lots, products] = await Promise.all([
      ids.length ? prisma.inventoryBatch.findMany({ where: { inventoryItemId: { in: ids } }, select: lotSelect }) : Promise.resolve([] as LotRow[]),
      prisma.product.findMany({ where: { sku: { in: [...new Set(items.map((i) => i.sku))] } }, select: { id: true, name: true, sku: true, category: true, taxPercent: true } }),
    ]);
    const reserved = await InventoryService.reservedQtyByLot(prisma, lots.filter((l) => l.currentQty > 0.0001).map((l) => l.id));
    const lotsByItem = new Map<string, LotRow[]>();
    for (const l of lots) lotsByItem.set(l.inventoryItemId, [...(lotsByItem.get(l.inventoryItemId) || []), l]);
    const productBySku = new Map(products.map((p) => [p.sku, p]));
    const groups = new Map<string, ItemRow[]>();
    for (const item of items) groups.set(item.sku, [...(groups.get(item.sku) || []), item]);
    return Promise.all([...groups.values()].map(async (copies) => {
      const item = copies.find(i => i.franchiseId == null) || copies[0];
      const master = await resolveSkuPriceMaster(prisma, item.sku);
      return shapeProduct({ ...item, ...(master ? { customerPrice: master.customerPrice, dealerPrice: master.dealerPrice, franchisePrice: master.franchisePrice, upcountryFranchisePrice: master.upcountryFranchisePrice, mrp: master.mrp, whiteLabelCost: master.whiteLabelCost } : {}) }, productBySku.get(item.sku), copies.flatMap(i => lotsByItem.get(i.id) || []), reserved, showCost);
    }));
  }

  static async listProducts(filters: {
    search?: string; category?: string; status?: string; warehouseId?: string; productId?: string; location?: string; inStock?: string | boolean;
  }, user: User) {
    const showCost = canViewCost(user);
    const scope = await this.itemScope(user, filters.location);
    const empty = { products: [], summary: { total: 0, fullyPriced: 0, pending: 0, availableQty: 0, stockValue: showCost ? 0 : undefined }, categories: [], warehouses: [], canEdit: false, showCost };
    if (!scope) return empty;

    // Include first-time unpriced SKUs even before their first receipt.
    let rows = await this.load({ ...scope, isActive: true }, showCost);
    const warehouses = [...new Map(rows.flatMap((p) => p.warehouses).map((w) => [w.id, w])).values()].sort((a, b) => a.name.localeCompare(b.name));
    const categories = [...new Set(rows.map((p) => p.category).filter(Boolean) as string[])].sort();

    const q = String(filters.search || '').trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
    if (filters.category) rows = rows.filter((p) => (p.category || '').toUpperCase() === String(filters.category).toUpperCase());
    if (filters.warehouseId) rows = rows.filter((p) => p.warehouses.some((w) => w.id === filters.warehouseId));
    if (filters.productId) rows = rows.filter((p) => p.id === filters.productId || p.productId === filters.productId);
    if (filters.inStock === true || filters.inStock === 'true') rows = rows.filter((p) => p.availableQty > 0);

    // Cards count every product matching the filters except the status filter.
    const summary = {
      total: rows.length,
      fullyPriced: rows.filter((p) => p.pricingStatus === PRODUCT_FULLY_PRICED).length,
      pending: rows.filter((p) => p.pricingStatus === PRODUCT_PRICING_PENDING).length,
      availableQty: round2(rows.reduce((s, p) => s + p.availableQty, 0)),
      stockValue: showCost ? round2(rows.reduce((s, p) => s + (p.stockValue || 0), 0)) : undefined,
    };
    if (filters.status === PRODUCT_FULLY_PRICED || filters.status === PRODUCT_PRICING_PENDING) {
      rows = rows.filter((p) => p.pricingStatus === filters.status);
    }
    // Pending first, then by name.
    rows.sort((a, b) => (a.pricingStatus === b.pricingStatus ? a.name.localeCompare(b.name) : a.pricingStatus === PRODUCT_PRICING_PENDING ? -1 : 1));
    return { products: rows, summary, categories, warehouses, canEdit: canEditLotPrice(user), showCost };
  }

  static async getProduct(id: string, user: User) {
    const showCost = canViewCost(user);
    const scope = await this.itemScope(user, 'ALL');
    const [row] = scope ? await this.load({ id, ...scope }, showCost) : [];
    if (!row) throw new LotPricingError('Finished product not found.', 'NOT_FOUND', 404);
    const logs = await prisma.auditLog.findMany({ where: { module: AUDIT_MODULE, recordId: row.sku }, orderBy: { timestamp: 'desc' }, take: 50 });
    const userIds = [...new Set(logs.map((l) => l.performedBy).filter(Boolean) as string[])];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }) : [];
    const nameOf = (uid: string | null) => (uid ? users.find((u) => u.id === uid)?.fullName || users.find((u) => u.id === uid)?.email || uid : null);
    return {
      ...row,
      history: logs.map((l) => {
        const oldV = (l.oldValue || {}) as any;
        const newV = (l.newValue || {}) as any;
        return {
          id: l.id,
          at: l.timestamp,
          by: nameOf(l.performedBy),
          previous: readPricing(oldV),
          prices: readPricing(newV),
          enteredTaxInclusive: !!newV.enteredTaxInclusive,
          reason: newV.reason ?? null,
          latestCost: showCost ? (newV.latestCost ?? null) : undefined,
          belowCost: showCost ? (newV.belowCostTiers ?? []) : undefined,
        };
      }),
    };
  }

  /**
   * Sets the product's Customer / Dealer / Franchise prices. A blank tier is
   * left "not configured" (stored as null = not configured — never
   * billed). Applied to every stock item of the SKU (HQ and branches) so a
   * product has one price set wherever it's sold. Below-cost prices (vs the
   * latest production cost) need acknowledgement; `expected` (what the
   * editor last saw) rejects a stale overwrite. Audited.
   */
  static async setPrices(id: string, input: {
    customerPrice?: unknown; dealerPrice?: unknown; franchisePrice?: unknown;
    upcountryFranchisePrice?: unknown; mrp?: unknown; whiteLabelCost?: unknown; taxPercent?: unknown;
    taxInclusive?: unknown; reason?: unknown; acknowledgeBelowCost?: unknown;
    expected?: Partial<Record<PricingField, unknown>> | null;
  }, user: User) {
    if (!canEditLotPrice(user)) throw new LotPricingError('Not authorized to change selling prices.', 'FORBIDDEN', 403);
    const taxInclusive = input.taxInclusive === true || input.taxInclusive === 'true';
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) || null : null;

    const entered = Object.fromEntries(PRICING_FIELDS.filter(t => input[t.key] !== undefined).map(t => [t.key, input[t.key]]));
    if (!PRICING_FIELDS.some(t => input[t.key] !== undefined) && input.taxPercent === undefined) throw new LotPricingError('No pricing changes supplied.', 'INVALID_PRICE');
    if (input.taxPercent !== undefined && ![5, 12, 18, 28].includes(Number(input.taxPercent))) throw new LotPricingError('Choose a valid GST rate.', 'INVALID_TAX');

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${id} FOR UPDATE`;
      const item = await tx.inventoryItem.findUnique({ where: { id }, select: itemSelect });
      if (!item || !(await tx.inventoryItem.count({ where: { id, category: 'FINISHED_GOOD' } }))) {
        throw new LotPricingError('Finished product not found.', 'NOT_FOUND', 404);
      }
      const product = await tx.product.findUnique({ where: { sku: item.sku }, select: { id: true, taxPercent: true } });
      const taxPercent = input.taxPercent === undefined ? item.gstRate ?? product?.taxPercent ?? 5 : Number(input.taxPercent);
      const master = await resolveSkuPriceMaster(tx, item.sku);
      if (master && master.id !== item.id) await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${master.id} FOR UPDATE`;
      const previous = readPricing(master || item);

      if (input.expected) {
        for (const t of PRICING_FIELDS) {
          if (input.expected[t.key] === undefined) continue;
          const seen = positive(input.expected[t.key]);
          const now = previous[t.key];
          if ((seen == null) !== (now == null) || (seen != null && now != null && Math.abs(seen - now) > 0.001)) {
            throw new LotPricingError('These prices were just changed by someone else. Refresh and try again.', 'STALE_PRICE', 409);
          }
        }
      }

      const next = mergePricing(previous, input, taxInclusive, taxPercent);
      const warnings = mrpWarnings(next, taxPercent);
      const gstChanged = input.taxPercent !== undefined && taxPercent !== item.gstRate;
      if (!gstChanged && PRICING_FIELDS.every(t => next[t.key] === previous[t.key])) {
        return { changed: false, id, ...next, taxPercent, mrpWarnings: warnings, pricingStatus: pricingStatusOf(next) };
      }

      // Margin check against the most recent production cost.
      const latest = await tx.inventoryBatch.findFirst({
        where: { inventoryItemId: id, unitCost: { gte: 0 } }, orderBy: { createdAt: 'desc' }, select: { unitCost: true },
      });
      const latestCost = latest?.unitCost ?? null;
      const below = PRICING_FIELDS.filter(t => t.selling)
        .filter((t) => next[t.key] != null && latestCost != null)
        .map((t) => ({ tier: t.label, ...checkLotPrice({ price: next[t.key]!, taxInclusive: false, taxPercent, unitCost: latestCost }) }))
        .filter((c) => c.belowCost);
      if (below.length && !(input.acknowledgeBelowCost === true || input.acknowledgeBelowCost === 'true')) {
        throw new LotPricingError(
          `${below.map((b) => b.tier).join(', ')} price${below.length > 1 ? 's are' : ' is'} below the latest production cost of ₹${round2(latestCost!)} per ${item.unit.toLowerCase()} (excl. GST). Confirm to save anyway.`,
          'BELOW_COST_CONFIRMATION_REQUIRED', 409,
          below.map((b) => ({ tier: b.tier, unitProfit: b.unitProfit, marginPct: b.marginPct })),
        );
      }

      // Every stock copy of this SKU (HQ and branches) gets the same prices.
      const data = {
        ...next,
        ...(gstChanged ? { gstRate: taxPercent } : {}),
      };
      await tx.inventoryItem.updateMany({ where: { sku: item.sku, category: 'FINISHED_GOOD' }, data });
      // HQ convention (InventoryService.updateItem): basePrice mirrors the
      // franchise price; Product.basePrice mirrors the HQ item.
      const hqScope = await scopeWhere(tx, null);
      if (next.franchisePrice != null) {
        await tx.inventoryItem.updateMany({ where: { sku: item.sku, category: 'FINISHED_GOOD', ...hqScope }, data: { basePrice: next.franchisePrice } });
      }
      const status = pricingStatusOf(next);
      if (product) {
        await tx.product.update({
          where: { id: product.id },
          data: {
            pricingStatus: status === PRODUCT_FULLY_PRICED ? PRICED : PRICING_PENDING,
            ...(next.franchisePrice != null ? { basePrice: next.franchisePrice } : {}),
            ...(gstChanged ? { taxPercent } : {}),
          },
        });
      }
      await tx.auditLog.create({
        data: {
          module: AUDIT_MODULE,
          action: previous.customerPrice == null && previous.dealerPrice == null && previous.franchisePrice == null ? 'PRICE_SET' : 'PRICE_UPDATE',
          recordId: item.sku,
          oldValue: previous as any,
          newValue: {
            ...next,
            enteredTaxInclusive: taxInclusive,
            entered,
            taxPercent,
            latestCost,
            belowCostTiers: below.map((b) => b.tier),
            reason,
          } as any,
          performedBy: user?.userId || null,
        },
      });
      return { changed: true, id, previous, ...next, taxPercent, mrpWarnings: warnings, pricingStatus: status, belowCostTiers: below.map((b) => b.tier) };
    });
  }
}
