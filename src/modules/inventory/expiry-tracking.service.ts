import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';
import { startOfBusinessDay } from '../../utils/business-date.util';

/**
 * Inventory > Expiry Tracking — lot-wise expiry, split into two views:
 *
 *   FINISHED  finished-goods lots (InventoryItem FINISHED_GOOD, one per
 *             confirmed packaging run) plus unpackaged bulk lots
 *             (SEMI_FINISHED), flagged recordType BULK so bulk kg is never
 *             mixed up with packed stock.
 *   RAW       raw-material purchase lots (GRN-created RAW_MATERIAL lots —
 *             the same records the Raw Material Stock Hub shows).
 *
 * Read-only: quantities are each lot's live currentQty and nothing here
 * changes stock or expiry dates. Expiry status follows lot-eligibility's
 * policy (a lot is expired ON its expiry date, business timezone), so a lot
 * shown as Expired is exactly one Production and Sales refuse to use.
 */

export type ExpiryView = 'FINISHED' | 'RAW';
export type ExpiryStatus = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';

/** "Expiring Soon" window — unchanged from the previous Expiry Tracking (7 days). */
export const EXPIRING_SOON_DAYS = 7;
const DAY_MS = 86_400_000;
const ZERO = 0.0001;

/**
 * Whole days from today to the expiry date (business timezone, date-only):
 * 0 = expires today (already expired), 1 = tomorrow. Works whether the date
 * was stored at UTC or IST midnight.
 */
export function daysToExpiry(expDate: Date | string, now: Date = new Date()): number {
  return Math.round((startOfBusinessDay(new Date(expDate)).getTime() - startOfBusinessDay(now).getTime()) / DAY_MS);
}

/** Same rule as isLotExpired: expired when days left ≤ 0. */
export function expiryStatusOf(expDate: Date | string, now: Date = new Date()): ExpiryStatus {
  const d = daysToExpiry(expDate, now);
  if (d <= 0) return 'EXPIRED';
  if (d <= EXPIRING_SOON_DAYS) return 'EXPIRING_SOON';
  return 'VALID';
}

type User = { role?: string; franchiseId?: string | null } | null | undefined;

export interface ExpiryFilters {
  view?: string;
  franchiseId?: string;
  warehouseId?: string;
  productId?: string;
  search?: string;
  status?: string;
  includeZero?: string | boolean;
}

/** Branch scope on InventoryItem: HQ stock is franchiseId null or the HQ row. */
async function itemScope(franchiseId: string | null): Promise<Prisma.InventoryItemWhereInput> {
  const scopeId = franchiseId ? await FranchiseService.toInventoryScopeId(prisma, franchiseId) : null;
  if (scopeId) return { franchiseId: scopeId };
  const hq = await prisma.franchise.findFirst({ where: { isHQ: true }, select: { id: true } });
  return { OR: [{ franchiseId: null }, ...(hq ? [{ franchiseId: hq.id }] : [])] };
}

export class ExpiryTrackingService {
  static async list(filters: ExpiryFilters, user: User, now: Date = new Date()) {
    const view: ExpiryView = String(filters.view || '').toUpperCase() === 'RAW' ? 'RAW' : 'FINISHED';
    const includeZero = filters.includeZero === true || filters.includeZero === 'true' || filters.includeZero === '1';

    // Branch access is enforced here: a branch user only ever sees their own branch.
    let branchId: string | null | undefined;
    if (user?.role !== 'SUPER_ADMIN') {
      if (!user?.franchiseId) return { view, rows: [], summary: { total: 0, valid: 0, expiringSoon: 0, expired: 0 }, products: [], warehouses: [], expiringSoonDays: EXPIRING_SOON_DAYS };
      branchId = user.franchiseId;
    } else if (filters.franchiseId) {
      branchId = filters.franchiseId;
    }

    const categories: Prisma.EnumItemCategoryFilter['in'] = view === 'RAW' ? ['RAW_MATERIAL'] : ['FINISHED_GOOD', 'SEMI_FINISHED'];
    const and: Prisma.InventoryBatchWhereInput[] = [{ inventoryItem: { category: { in: categories } } }];
    if (branchId !== undefined) and.push({ inventoryItem: await itemScope(branchId) });
    if (!includeZero) and.push({ currentQty: { gt: ZERO } });
    // Raw lots carry their own expiry; production lots may inherit the batch's.
    and.push(view === 'RAW'
      ? { expDate: { not: null } }
      : { OR: [{ expDate: { not: null } }, { productBatch: { expiryDate: { not: null } } }, { productBatch: { production: { expiryDate: { not: null } } } }] });

    const lots = await prisma.inventoryBatch.findMany({
      where: { AND: and },
      include: {
        inventoryItem: { select: { id: true, name: true, sku: true, unit: true, category: true, franchiseId: true, franchise: { select: { name: true } } } },
        warehouse: { select: { id: true, name: true } },
        vendor: { select: { name: true } },
        productPackaging: { select: { packetSize: true, confirmedAt: true } },
        productBatch: {
          select: {
            batchCode: true, mfgDate: true, expiryDate: true, createdAt: true,
            production: { select: { expiryDate: true, recipe: { select: { name: true, yieldUnit: true } } } },
          },
        },
      },
      orderBy: [{ expDate: 'asc' }, { createdAt: 'desc' }],
    });

    const all = lots.map((l) => {
      const item = l.inventoryItem;
      const pb = l.productBatch;
      const expiryDate = l.expDate ?? pb?.expiryDate ?? pb?.production?.expiryDate ?? null;
      const daysLeft = expiryDate ? daysToExpiry(expiryDate, now) : null;
      const base = {
        id: l.id,
        inventoryItemId: item.id,
        name: item.name,
        sku: item.sku,
        lotNumber: l.lotNumber || l.batchNumber,
        expiryDate,
        daysLeft,
        expiryStatus: (expiryDate ? expiryStatusOf(expiryDate, now) : 'VALID') as ExpiryStatus,
        availableQty: Math.max(0, l.currentQty),
        initialQty: l.initialQty,
        unit: item.unit,
        stockState: l.status,
        warehouse: l.warehouse,
        branch: item.franchiseId ? (item.franchise?.name || 'Branch') : 'HQ',
        franchiseId: item.franchiseId,
      };
      if (view === 'RAW') {
        return {
          ...base,
          recordType: 'RAW_LOT' as const,
          billNumber: l.billNumber,
          supplier: l.vendor?.name ?? null,
          receivedDate: l.receivedAt ?? l.createdAt,
          mfgDate: l.mfgDate,
        };
      }
      const bulk = item.category === 'SEMI_FINISHED';
      return {
        ...base,
        // Bulk lots are named after the recipe; the stock item is the generic bulk item.
        name: bulk ? (pb?.production?.recipe?.name || item.name) : item.name,
        recordType: bulk ? ('BULK' as const) : ('FINISHED_LOT' as const),
        productionBatch: pb?.batchCode ?? null,
        productionDate: pb?.mfgDate ?? pb?.createdAt ?? l.mfgDate ?? l.createdAt,
        packagingDate: l.productPackaging?.confirmedAt ?? null,
        packSize: l.productPackaging?.packetSize ?? null,
      };
    });

    // Filter choices come from this view's lots before product/warehouse/search/status.
    const products = Array.from(new Map(all.map((r) => [r.inventoryItemId, { id: r.inventoryItemId, name: r.name, sku: r.sku }])).values())
      .sort((a, b) => a.name.localeCompare(b.name));
    const warehouses = Array.from(new Map(all.filter((r) => r.warehouse).map((r) => [r.warehouse!.id, r.warehouse!])).values())
      .sort((a, b) => a.name.localeCompare(b.name));

    const q = String(filters.search || '').trim().toLowerCase();
    const scoped = all.filter((r) =>
      (!filters.productId || r.inventoryItemId === filters.productId) &&
      (!filters.warehouseId || r.warehouse?.id === filters.warehouseId) &&
      (!q || [r.name, r.sku, r.lotNumber, (r as any).productionBatch, (r as any).billNumber, (r as any).supplier]
        .some((v) => v && String(v).toLowerCase().includes(q))),
    );

    // Cards count every lot matching the filters except the status filter itself.
    const summary = {
      total: scoped.length,
      valid: scoped.filter((r) => r.expiryStatus === 'VALID').length,
      expiringSoon: scoped.filter((r) => r.expiryStatus === 'EXPIRING_SOON').length,
      expired: scoped.filter((r) => r.expiryStatus === 'EXPIRED').length,
    };
    const status = String(filters.status || '').toUpperCase();
    const rows = ['VALID', 'EXPIRING_SOON', 'EXPIRED'].includes(status) ? scoped.filter((r) => r.expiryStatus === status) : scoped;

    return { view, rows, summary, products, warehouses, expiringSoonDays: EXPIRING_SOON_DAYS };
  }
}
