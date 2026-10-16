import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import type { FifoConsumptionResult } from './inventory.service';
import { expiryCutoff, isLotExpired, productionLotIssue } from './lot-eligibility';

// Lots that still physically hold stock. REJECTED lots never entered usable
// inventory, so they're left out of quantity/value everywhere here.
const HELD_STATUSES_EXCLUDED = ['REJECTED'] as const;

// A purchase return lot can be sent back from any state the material can
// physically sit in (incl. blocked/expired) — just not one already
// rejected or returned.
const RETURN_BLOCKED_STATUSES = ['REJECTED', 'RETURNED'];

export interface LotSummary {
  activeLots: number;
  lotQty: number;
  lotValue: number;
  /** Quantity in lots production can use now (approved, not expired) — same rule as Production Planning. */
  usableQty: number;
  /** Approved lot stock past its expiry date (expired ON the expiry date). */
  expiredQty: number;
}

/**
 * Phase 1 purchase-lot views for Stock Hub and lot-linked purchase returns.
 * Read paths plus one lot-specific deduction used only by purchase returns;
 * Production/Sales consumption keeps using InventoryService's FIFO helpers.
 */
export class PurchaseLotsService {
  /** Per-item totals across lots that still hold stock, for the list view. */
  static async getLotSummaries(itemIds: string[]): Promise<Map<string, LotSummary>> {
    const map = new Map<string, LotSummary>();
    if (itemIds.length === 0) return map;

    const rows: Array<{ inventoryItemId: string; activeLots: number; lotQty: number; lotValue: number; usableQty: number; expiredQty: number }> = await prisma.$queryRaw(Prisma.sql`
      SELECT "inventoryItemId",
             COUNT(*)::int                                   AS "activeLots",
             COALESCE(SUM("currentQty"), 0)::float8          AS "lotQty",
             COALESCE(SUM("currentQty" * COALESCE("unitCost", 0)), 0)::float8 AS "lotValue",
             COALESCE(SUM(CASE WHEN status::text = 'APPROVED' AND ("expDate" IS NULL OR "expDate" >= ${expiryCutoff()}) THEN "currentQty" ELSE 0 END), 0)::float8 AS "usableQty",
             COALESCE(SUM(CASE WHEN status::text = 'APPROVED' AND "expDate" < ${expiryCutoff()} THEN "currentQty" ELSE 0 END), 0)::float8 AS "expiredQty"
      FROM "InventoryBatch"
      WHERE "inventoryItemId" IN (${Prisma.join(itemIds)})
        AND "currentQty" > 0.0001
        AND status::text NOT IN (${Prisma.join([...HELD_STATUSES_EXCLUDED])})
      GROUP BY "inventoryItemId"
    `);
    for (const r of rows) {
      map.set(r.inventoryItemId, { activeLots: r.activeLots, lotQty: r.lotQty, lotValue: r.lotValue, usableQty: r.usableQty, expiredQty: r.expiredQty });
    }
    return map;
  }

  /**
   * Lot stock that can't be used now, per item: `expired` (approved lots past
   * expiry) and `held` (QC hold, blocked, returned, … — not approved). With a
   * warehouse, only lots in it (or with no warehouse on record), matching how
   * warehouse stock is counted. Stock records are untouched; this only tells
   * screens what not to count as available.
   */
  static async getUnusableLotQty(itemIds: string[], warehouseId?: string): Promise<Map<string, { expired: number; held: number }>> {
    const map = new Map<string, { expired: number; held: number }>();
    if (itemIds.length === 0) return map;
    const cutoff = expiryCutoff();
    const rows: Array<{ inventoryItemId: string; expired: number; held: number }> = await prisma.$queryRaw(Prisma.sql`
      SELECT "inventoryItemId",
             COALESCE(SUM(CASE WHEN status::text = 'APPROVED' AND "expDate" < ${cutoff} THEN "currentQty" ELSE 0 END), 0)::float8 AS expired,
             COALESCE(SUM(CASE WHEN status::text <> 'APPROVED' THEN "currentQty" ELSE 0 END), 0)::float8 AS held
      FROM "InventoryBatch"
      WHERE "inventoryItemId" IN (${Prisma.join(itemIds)})
        AND "currentQty" > 0.0001
        AND status::text NOT IN (${Prisma.join([...HELD_STATUSES_EXCLUDED])})
        ${warehouseId ? Prisma.sql`AND ("warehouseId" = ${warehouseId} OR "warehouseId" IS NULL)` : Prisma.empty}
      GROUP BY "inventoryItemId"
    `);
    for (const r of rows) map.set(r.inventoryItemId, { expired: r.expired, held: r.held });
    return map;
  }

  /**
   * Stock Hub valuation for one item. Stock is the movement ledger figure the
   * rest of the app already uses; lots value what they hold at their own
   * cost, and any ledger stock not held in a lot (opening balances,
   * adjustments, pre-lot history) is valued at the item's moving-average cost
   * so the total still reconciles to the stock figure.
   */
  static summarize(ledgerStock: number, costPrice: number, lots?: LotSummary) {
    const lotQty = lots?.lotQty || 0;
    const lotValue = lots?.lotValue || 0;
    const untrackedQty = Math.max(0, ledgerStock - lotQty);
    const untrackedValue = untrackedQty * (costPrice || 0);
    const totalValue = lotValue + untrackedValue;
    const valuedQty = lotQty + untrackedQty;
    return {
      activeLots: lots?.activeLots || 0,
      lotQty: round(lotQty, 4),
      lotValue: round(lotValue, 2),
      // Lot stock production can use now; the rest (expired / held) is shown
      // in stock but flagged, never offered as usable for production.
      usableLotQty: round(lots?.usableQty || 0, 4),
      expiredQty: round(lots?.expiredQty || 0, 4),
      // Stock Hub's available figure: ledger stock minus lot stock that can't
      // be used (expired or held). Nothing is written; the ledger is unchanged.
      usableStock: ((u) => (u < 0.0005 ? 0 : round(u, 4)))(ledgerStock - Math.max(0, lotQty - (lots?.usableQty || 0))),
      untrackedQty: round(untrackedQty, 4),
      untrackedValue: round(untrackedValue, 2),
      totalValue: round(totalValue, 2),
      weightedAvgCost: valuedQty > 0 ? round(totalValue / valuedQty, 4) : round(costPrice || 0, 4),
    };
  }

  /** Every lot of one item (newest first) with supplier/PO/GRN provenance. */
  static async getMaterialLots(itemId: string) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: itemId },
      select: { id: true, name: true, sku: true, unit: true, costPrice: true, minimumStock: true },
    });
    if (!item) throw new Error('Material not found');

    const [lots, pendingClaims] = await Promise.all([
      prisma.inventoryBatch.findMany({
        where: { inventoryItemId: itemId, status: { notIn: [...HELD_STATUSES_EXCLUDED] } },
        include: {
          warehouse: { select: { id: true, name: true } },
          vendor: { select: { id: true, name: true } },
          procurementOrder: { select: { id: true, poNumber: true, createdAt: true } },
          goodsReceiptItem: { select: { grnId: true, vendorBatchNo: true } },
        },
        orderBy: [{ receivedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      }),
      this.getPendingReturnClaims(prisma, { inventoryItemId: itemId }),
    ]);

    const now = new Date();
    return {
      item,
      lots: lots.map((lot) => {
        const unitCost = lot.unitCost || 0;
        const pending = pendingClaims.get(lot.id) || 0;
        // Same eligibility Production Planning applies (any warehouse).
        const issue = lot.currentQty > 0 ? productionLotIssue(lot, { now }) : null;
        return {
          id: lot.id,
          lotNumber: lot.lotNumber || lot.batchNumber,
          batchNumber: lot.batchNumber,
          billNumber: lot.billNumber,
          vendorBatchNo: lot.goodsReceiptItem?.vendorBatchNo || null,
          source: lot.goodsReceiptItemId || lot.billNumber ? 'PURCHASE' : (lot.productBatchId ? 'PRODUCTION' : 'OTHER'),
          supplier: lot.vendor,
          poNumber: lot.procurementOrder?.poNumber || null,
          poId: lot.procurementOrder?.id || null,
          grnId: lot.goodsReceiptItem?.grnId || null,
          purchaseDate: lot.procurementOrder?.createdAt || null,
          receivedAt: lot.receivedAt || lot.createdAt,
          purchaseQty: lot.purchaseQty,
          purchaseUnit: lot.purchaseUnit,
          purchasePrice: lot.purchasePrice,
          receivedQty: lot.initialQty,
          availableQty: round(lot.currentQty, 4),
          pendingReturnQty: round(pending, 4),
          unitCost: round(unitCost, 4),
          stockValue: round(lot.currentQty * unitCost, 2),
          mfgDate: lot.mfgDate,
          expDate: lot.expDate,
          status: lot.status,
          warehouse: lot.warehouse,
          expired: isLotExpired(lot.expDate, now),
          productionUsable: lot.currentQty > 0 && !issue,
          productionIssue: issue?.message || null,
        };
      }),
    };
  }

  /** Base-unit quantity already claimed on each lot by not-yet-completed returns. */
  static async getPendingReturnClaims(
    tx: any,
    where: { inventoryItemId?: string; batchIds?: string[]; excludeReturnId?: string },
  ): Promise<Map<string, number>> {
    const items = await tx.purchaseReturnItem.findMany({
      where: {
        inventoryBatchId: where.batchIds ? { in: where.batchIds } : { not: null },
        ...(where.inventoryItemId ? { inventoryBatch: { inventoryItemId: where.inventoryItemId } } : {}),
        return: {
          status: 'PENDING',
          ...(where.excludeReturnId ? { id: { not: where.excludeReturnId } } : {}),
        },
      },
      select: { inventoryBatchId: true, baseQty: true, quantity: true },
    });
    const map = new Map<string, number>();
    for (const it of items) {
      if (!it.inventoryBatchId) continue;
      map.set(it.inventoryBatchId, (map.get(it.inventoryBatchId) || 0) + (it.baseQty ?? it.quantity));
    }
    return map;
  }

  /**
   * Received lots from this vendor that can still be sent back, keyed by
   * material id. Available = what the lot physically still holds minus what
   * pending returns have already claimed on it.
   */
  static async getReturnableLotsForVendor(vendorId: string) {
    const lots = await prisma.inventoryBatch.findMany({
      where: {
        vendorId,
        currentQty: { gt: 0.0001 },
        status: { notIn: RETURN_BLOCKED_STATUSES as any },
      },
      include: {
        warehouse: { select: { name: true } },
        procurementOrder: { select: { poNumber: true } },
      },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
    });
    const pending = await this.getPendingReturnClaims(prisma, { batchIds: lots.map((l) => l.id) });

    const byMaterial = new Map<string, any[]>();
    for (const lot of lots) {
      const availableQty = round(lot.currentQty - (pending.get(lot.id) || 0), 4);
      if (availableQty <= 0) continue;
      const list = byMaterial.get(lot.inventoryItemId) || [];
      list.push({
        batchId: lot.id,
        lotNumber: lot.lotNumber || lot.batchNumber,
        billNumber: lot.billNumber,
        poNumber: lot.procurementOrder?.poNumber || null,
        receivedAt: lot.receivedAt || lot.createdAt,
        expDate: lot.expDate,
        unitCost: round(lot.unitCost || 0, 4),
        purchasePrice: lot.purchasePrice,
        purchaseUnit: lot.purchaseUnit,
        availableQty,
        warehouse: lot.warehouse?.name || null,
        status: lot.status,
      });
      byMaterial.set(lot.inventoryItemId, list);
    }
    return byMaterial;
  }

  /**
   * Deducts `quantity` (stock unit) from exactly one lot, row-locked, and
   * returns it in the FifoConsumptionResult shape so recordMovement can take
   * it as precalculatedFifo. Never spills into other lots; throws instead.
   */
  static async depleteLot(tx: any, batchId: string, itemId: string, quantity: number): Promise<FifoConsumptionResult> {
    const rows: Array<{ id: string; batchNumber: string; billNumber: string | null; productBatchId: string | null; currentQty: number; unitCost: number | null; inventoryItemId: string; status: string }> = await tx.$queryRaw(Prisma.sql`
      SELECT id, "batchNumber", "billNumber", "productBatchId", "currentQty", "unitCost", "inventoryItemId", status::text AS status
      FROM "InventoryBatch"
      WHERE id = ${batchId}
      FOR UPDATE
    `);
    const lot = rows[0];
    if (!lot) throw new Error('Selected lot no longer exists.');
    if (lot.inventoryItemId !== itemId) throw new Error(`Lot ${lot.batchNumber} does not belong to this material.`);
    if (RETURN_BLOCKED_STATUSES.includes(lot.status)) throw new Error(`Lot ${lot.batchNumber} is ${lot.status} and cannot be returned.`);
    if (lot.currentQty + 0.0001 < quantity) {
      throw new Error(`Lot ${lot.batchNumber} only has ${round(lot.currentQty, 4)} left; cannot return ${round(quantity, 4)}.`);
    }

    await tx.inventoryBatch.update({
      where: { id: lot.id },
      data: { currentQty: Math.max(0, lot.currentQty - quantity) },
    });
    const unitCost = lot.unitCost || 0;
    return {
      consumptions: [{
        batchId: lot.id,
        billNumber: lot.billNumber || lot.batchNumber,
        productBatchId: lot.productBatchId,
        qty: quantity,
        unitCost,
        totalCost: quantity * unitCost,
      }],
      consumedFromBatches: quantity,
      totalCost: quantity * unitCost,
      unitCost,
      blockedQtyAvailable: 0,
    };
  }
}

function round(n: number, dp: number) {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
}
