/**
 * Purchase lot-wise production costing:
 *  - lot options and operator-selected lot deduction for Production Planning
 *  - additional expenses and per-packet costing for Packaging
 * Pure calculations live in production-costing.ts.
 */
import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { InventoryService, FifoConsumption, FifoConsumptionResult } from '../inventory/inventory.service';
import { FranchiseService } from '../franchise/franchise.service';
import {
  DEFAULT_EXPENSE_CATEGORIES, EXPENSE_CATEGORIES_SETTING, ExpenseCategory, ExpenseLineInput,
  SharedExpenseState, computePackagingCosts, normalizeExpenseLines, r4, simulateFifoCost,
  isPackagingCategory, snapshotExpenses, snapshotPackagingLines,
} from './production-costing';

const QTY_EPS = 0.0005;

export interface LotAllocationInput { batchId: string | null; qty: number }

export class ProductionCostingService {
  // ── Settings ───────────────────────────────────────────────────────────
  /** Expense categories (SystemSetting PRODUCTION_EXPENSE_CATEGORIES, JSON [{code,label}]). */
  static async getExpenseCategories(): Promise<ExpenseCategory[]> {
    const { SettingsService } = require('../settings/settings.service');
    const raw = await SettingsService.getSettingValue(EXPENSE_CATEGORIES_SETTING, '');
    if (!raw) return DEFAULT_EXPENSE_CATEGORIES;
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
            .map((c: any) => ({ code: String(c?.code || '').trim().toUpperCase(), label: String(c?.label || c?.code || '').trim() }))
            .filter((c: ExpenseCategory) => /^[A-Z0-9_]{1,40}$/.test(c.code) && c.label)
        : [];
      return list.length ? list : DEFAULT_EXPENSE_CATEGORIES;
    } catch {
      return DEFAULT_EXPENSE_CATEGORIES;
    }
  }

  // ── Production Planning: purchase lots ─────────────────────────────────
  /**
   * Lots each material can be produced from in `warehouseId`, oldest first
   * (the same eligibility as automatic FIFO: APPROVED, stock left, not
   * expired, this warehouse or no warehouse on record), plus any stock
   * that is not in a tracked lot (valued at the item's average cost).
   */
  static async getLotOptions(itemIds: string[], warehouseId: string) {
    const ids = Array.from(new Set(itemIds.filter(Boolean))).slice(0, 100);
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, sku: true, unit: true, costPrice: true },
    });
    return Promise.all(items.map(async (item) => {
      const [lots, otherLotQty, warehouseStock] = await Promise.all([
        prisma.inventoryBatch.findMany({
          where: {
            inventoryItemId: item.id,
            currentQty: { gt: 0 },
            status: 'APPROVED',
            OR: [{ expDate: null }, { expDate: { gte: new Date() } }],
            AND: [{ OR: [{ warehouseId }, { warehouseId: null }] }],
          },
          include: { vendor: { select: { name: true } } },
          orderBy: [{ mfgDate: 'asc' }, { createdAt: 'asc' }],
        }),
        this.lotQtyInWarehouse(prisma, item.id, warehouseId),
        InventoryService.computeWarehouseStock(item.id, warehouseId),
      ]);
      return {
        inventoryItemId: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        averageCost: r4(item.costPrice || 0),
        lots: lots.map((lot) => ({
          id: lot.id,
          lotNumber: lot.lotNumber || lot.batchNumber,
          billNumber: lot.billNumber,
          supplier: lot.vendor?.name || null,
          receivedAt: lot.receivedAt || lot.createdAt,
          expDate: lot.expDate,
          availableQty: r4(lot.currentQty),
          unitCost: r4(lot.unitCost || 0),
        })),
        untrackedQty: r4(Math.max(0, warehouseStock - otherLotQty)),
      };
    }));
  }

  /** Quantity held in any lot (except rejected) of this item in the warehouse. */
  private static async lotQtyInWarehouse(tx: any, itemId: string, warehouseId: string): Promise<number> {
    const agg = await tx.inventoryBatch.aggregate({
      where: {
        inventoryItemId: itemId,
        currentQty: { gt: 0 },
        status: { not: 'REJECTED' },
        OR: [{ warehouseId }, { warehouseId: null }],
      },
      _sum: { currentQty: true },
    });
    return agg._sum.currentQty || 0;
  }

  /** Validates an allocation list shape; returns entries with qty > 0. */
  static normalizeAllocations(raw: unknown, label: string): LotAllocationInput[] {
    if (!Array.isArray(raw)) throw new Error(`${label}: lot allocation must be a list.`);
    const seen = new Set<string>();
    const out: LotAllocationInput[] = [];
    for (const a of raw as any[]) {
      const qty = Number(a?.qty);
      const batchId = a?.batchId ? String(a.batchId) : null;
      if (!Number.isFinite(qty) || qty < 0) throw new Error(`${label}: allocated quantity must be 0 or more.`);
      const key = batchId || 'UNTRACKED';
      if (seen.has(key)) throw new Error(`${label}: the same lot is listed twice.`);
      seen.add(key);
      if (qty > 0) out.push({ batchId, qty });
    }
    return out;
  }

  /**
   * Deducts exactly the operator's allocation (stock unit) for one material,
   * row-locked, and returns it in the FIFO result shape for
   * InventoryService.recordMovement's precalculatedFifo. Each lot must be
   * APPROVED, unexpired, in this warehouse (or none on record) and hold the
   * quantity. A `batchId: null` entry draws untracked stock (no lot on
   * record), allowed only up to the warehouse stock not held in any lot.
   * Never spills into lots the operator didn't choose.
   */
  static async depleteAllocatedLots(
    tx: any,
    item: { id: string; name: string },
    allocations: LotAllocationInput[],
    requiredQty: number,
    warehouseId: string | undefined,
  ): Promise<FifoConsumptionResult> {
    const total = allocations.reduce((s, a) => s + a.qty, 0);
    if (Math.abs(total - requiredQty) > Math.max(QTY_EPS, requiredQty * 1e-6)) {
      throw new Error(`"${item.name}": allocated ${r4(total)} but ${r4(requiredQty)} is required. Allocated quantity must equal the requirement.`);
    }
    const lotAllocs = allocations.filter((a) => a.batchId);
    const untracked = allocations.filter((a) => !a.batchId).reduce((s, a) => s + a.qty, 0);

    const ids = lotAllocs.map((a) => a.batchId!) ;
    const rows: Array<{ id: string; batchNumber: string; lotNumber: string | null; billNumber: string | null; productBatchId: string | null; currentQty: number; unitCost: number | null; inventoryItemId: string; status: string; expDate: Date | null; warehouseId: string | null }> = ids.length
      ? await tx.$queryRaw(Prisma.sql`
          SELECT id, "batchNumber", "lotNumber", "billNumber", "productBatchId", "currentQty", "unitCost", "inventoryItemId", status::text AS status, "expDate", "warehouseId"
          FROM "InventoryBatch"
          WHERE id IN (${Prisma.join(ids)})
          ORDER BY id
          FOR UPDATE
        `)
      : [];

    if (untracked > 0) {
      if (!warehouseId) throw new Error(`"${item.name}": untracked stock can only be used with a selected warehouse.`);
      const whStock = await InventoryService.computeWarehouseStock(item.id, warehouseId, tx);
      const inLots = await this.lotQtyInWarehouse(tx, item.id, warehouseId);
      const allowed = Math.max(0, whStock - inLots);
      if (untracked > allowed + QTY_EPS) {
        throw new Error(`"${item.name}": only ${r4(allowed)} of stock is outside purchase lots; ${r4(untracked)} was allocated to it.`);
      }
    }

    const consumptions: FifoConsumption[] = [];
    let lotTotal = 0;
    let lotCost = 0;
    const now = Date.now();
    for (const a of lotAllocs) {
      const lot = rows.find((r) => r.id === a.batchId);
      const name = lot ? (lot.lotNumber || lot.batchNumber) : a.batchId;
      if (!lot || lot.inventoryItemId !== item.id) throw new Error(`"${item.name}": lot ${name} was not found for this material.`);
      if (lot.status !== 'APPROVED') throw new Error(`"${item.name}": lot ${name} is ${lot.status.toLowerCase().replace('_', ' ')} and cannot be used.`);
      if (lot.expDate && new Date(lot.expDate).getTime() < now) throw new Error(`"${item.name}": lot ${name} has expired.`);
      if (warehouseId && lot.warehouseId && lot.warehouseId !== warehouseId) throw new Error(`"${item.name}": lot ${name} is in a different warehouse.`);
      if (lot.currentQty + QTY_EPS < a.qty) throw new Error(`"${item.name}": lot ${name} only has ${r4(lot.currentQty)} available; ${r4(a.qty)} was allocated.`);

      const take = Math.min(a.qty, lot.currentQty);
      await tx.inventoryBatch.update({ where: { id: lot.id }, data: { currentQty: Math.max(0, lot.currentQty - take) } });
      const unitCost = lot.unitCost || 0;
      lotTotal += take;
      lotCost += take * unitCost;
      consumptions.push({
        batchId: lot.id,
        billNumber: lot.billNumber || lot.batchNumber,
        productBatchId: lot.productBatchId,
        qty: take,
        unitCost,
        totalCost: take * unitCost,
        // Marks an operator-chosen lot (vs automatic FIFO) in batchBreakdown.
        lotNumber: lot.lotNumber || lot.batchNumber,
        selectedBy: 'OPERATOR',
      } as FifoConsumption);
    }

    return {
      consumptions,
      consumedFromBatches: lotTotal,
      totalCost: lotCost,
      unitCost: lotTotal > 0 ? lotCost / lotTotal : 0,
      blockedQtyAvailable: 0,
    };
  }

  // ── Packaging: expenses & cost ─────────────────────────────────────────
  /** PER_BATCH totals for a batch and what earlier sessions already absorbed. */
  static async loadSharedExpenses(tx: any, batchId: string): Promise<SharedExpenseState[]> {
    // MANUFACTURING rows are already inside the batch cost; never share them again.
    const rows = await tx.productionExpense.findMany({ where: { productBatchId: batchId, basis: 'PER_BATCH', stage: 'PACKAGING' } });
    const totals = rows.filter((r: any) => !r.productPackagingId);
    return totals.map((t: any) => ({
      category: t.category,
      total: t.amount,
      allocatedBefore: r4(rows.filter((r: any) => r.productPackagingId && r.category === t.category).reduce((s: number, r: any) => s + r.amount, 0)),
    }));
  }

  /** Applies PER_BATCH totals from this request onto the stored ones (in memory). */
  static mergeShared(stored: SharedExpenseState[], lines: ExpenseLineInput[]): SharedExpenseState[] {
    const out = stored.map((s) => ({ ...s }));
    for (const l of lines.filter((x) => x.basis === 'PER_BATCH')) {
      const existing = out.find((s) => s.category === l.category);
      if (existing) existing.total = l.rate;
      else out.push({ category: l.category, total: l.rate, allocatedBefore: 0 });
    }
    return out;
  }

  /** Persists PER_BATCH totals entered with this request (batch row must be locked by the caller). */
  static async saveSharedTotals(tx: any, batchId: string, lines: ExpenseLineInput[], userId?: string) {
    for (const l of lines.filter((x) => x.basis === 'PER_BATCH')) {
      const existing = await tx.productionExpense.findFirst({
        where: { productBatchId: batchId, productPackagingId: null, basis: 'PER_BATCH', stage: 'PACKAGING', category: l.category },
      });
      if (existing) {
        const allocated = (await tx.productionExpense.aggregate({
          where: { productBatchId: batchId, productPackagingId: { not: null }, basis: 'PER_BATCH', stage: 'PACKAGING', category: l.category },
          _sum: { amount: true },
        }))._sum.amount || 0;
        if (l.rate + 0.005 < allocated) {
          throw new Error(`${l.category} for this batch cannot be lowered to ₹${l.rate}: ₹${r4(allocated)} has already been charged to packed goods.`);
        }
        if (Math.abs(existing.amount - l.rate) > 1e-9) {
          await tx.productionExpense.update({ where: { id: existing.id }, data: { amount: l.rate, rate: l.rate, createdBy: userId ?? existing.createdBy } });
        }
      } else {
        await tx.productionExpense.create({
          data: { productBatchId: batchId, category: l.category, basis: 'PER_BATCH', rate: l.rate, amount: l.rate, createdBy: userId },
        });
      }
    }
  }

  /** Batch cost header for the Packaging screen. */
  static async getBatchCostSummary(batchId: string) {
    const batch = await prisma.productBatch.findUnique({
      where: { id: batchId },
      include: {
        production: { include: { recipe: true, items: { include: { inventoryItem: { select: { name: true, unit: true } } } } } },
        packagings: { where: { status: 'CONFIRMED' }, orderBy: { confirmedAt: 'asc' } },
      },
    });
    if (!batch) throw new Error('Product batch not found');
    const p = batch.production;
    const unit = p?.plannedYieldUnit || p?.recipe?.yieldUnit || 'KG';
    const plannedYield = p ? (p.plannedYieldQty ?? (p.quantity * (p.recipe?.yieldQty || 0))) : null;
    const actualYield = p?.actualYield ?? batch.quantity ?? null;
    const items = p?.items || [];
    const materialCost = r4(p?.materialCost ?? items.reduce((s, i) => s + (i.totalCost || 0), 0));
    const additionalMaterialCost = r4(items.filter((i) => i.isAdditional).reduce((s, i) => s + (i.totalCost || 0), 0));
    const shared = await this.loadSharedExpenses(prisma, batchId);
    const categories = await this.getExpenseCategories();
    const labelOf = (code: string) => categories.find((c) => c.code === code)?.label || code;

    // Recipe expense snapshot (runs started after expenses moved to Recipe
    // Master) vs packaging-entered expenses (older runs, unchanged).
    const snapshot = p?.expenseSnapshot ?? null;
    const snapshotList = snapshotExpenses(snapshot);
    const expenseRows = await prisma.productionExpense.findMany({ where: { productBatchId: batchId }, orderBy: { createdAt: 'asc' } });
    const manufacturingRows = expenseRows.filter((e) => e.stage === 'MANUFACTURING');
    const manufacturingExpenseTotal = r4(manufacturingRows.reduce((s, e) => s + e.amount, 0));
    const totalManufacturingCost = r4(snapshot ? materialCost + manufacturingExpenseTotal : (p?.totalCost ?? materialCost));

    return {
      batchId: batch.id,
      batchCode: batch.batchCode,
      unit,
      plannedYield: plannedYield != null ? r4(plannedYield) : null,
      actualYield: actualYield != null ? r4(actualYield) : null,
      materialCost,
      additionalMaterialCost,
      otherProductionCost: r4((p?.totalCost ?? materialCost) - materialCost),
      plannedMaterialCostPerUnit: plannedYield && plannedYield > 0 ? r4(materialCost / plannedYield) : null,
      actualMaterialCostPerUnit: actualYield && actualYield > 0 ? r4(materialCost / actualYield) : null,
      bulkUnitCost: batch.unitCost != null ? r4(batch.unitCost) : null,
      packedQty: r4(batch.packagedQty || 0),
      remainingQty: r4(Math.max(0, (batch.approvedQty || batch.quantity || 0) - (batch.packagedQty || 0))),
      materials: items.map((i) => ({
        name: i.inventoryItem?.name,
        unit: i.inventoryItem?.unit,
        qty: r4(i.usedQuantity),
        cost: r4(i.totalCost || 0),
        isAdditional: i.isAdditional,
        lots: Array.isArray(i.batchBreakdown) ? (i.batchBreakdown as any[]).map((b) => ({
          lot: b.lotNumber || b.billNumber, qty: r4(b.qty), unitCost: r4(b.unitCost), cost: r4(b.totalCost),
        })) : [],
      })),
      sharedExpenses: shared.map((s) => ({
        ...s,
        label: categories.find((c) => c.code === s.category)?.label || s.category,
        remaining: r4(Math.max(0, s.total - s.allocatedBefore)),
      })),
      sessions: batch.packagings.map((pk) => ({
        id: pk.id,
        packetSize: pk.packetSize,
        good: pk.goodQty ?? 0,
        damaged: pk.damagedQty ?? 0,
        confirmedAt: pk.confirmedAt,
        cost: pk.costBreakdown ?? null,
      })),
      categories,
      expenseSource: snapshot ? 'RECIPE_SNAPSHOT' : 'LEGACY',
      expenseSnapshot: snapshot
        ? { configVersion: (snapshot as any).configVersion ?? null, capturedAt: (snapshot as any).capturedAt ?? null, expenses: snapshotList.map((e) => ({ ...e, label: e.label || labelOf(e.category) })) }
        : null,
      manufacturingExpenses: manufacturingRows.map((e) => ({
        category: e.category, label: labelOf(e.category), basis: e.basis, rate: r4(e.rate), baseQty: r4(e.baseQty), amount: r4(e.amount),
      })),
      manufacturingExpenseTotal,
      totalManufacturingCost,
      manufacturingCostPerUnit: actualYield && actualYield > 0 ? r4(totalManufacturingCost / actualYield) : null,
      // Charged at packaging from the snapshot: Packaging Materials and any per-packet manufacturing expense.
      packagingExpenses: snapshotList
        .filter((e) => isPackagingCategory(e.category) || e.basis === 'PER_PACKET')
        .map((e) => ({ ...e, label: e.label || labelOf(e.category) })),
      packagingExpenseCharged: r4(expenseRows.filter((e) => e.stage === 'PACKAGING' && e.productPackagingId).reduce((s, e) => s + e.amount, 0)),
    };
  }

  /**
   * Cost preview for a packaging request, without writing anything. Uses
   * the same bulk-lot order startPackaging consumes (FIFO across the bulk
   * pool) and the same calculation packageAndConfirm posts.
   */
  static async previewPackagingCost(batchId: string, input: {
    rows: Array<{ packetSize: string; packedQty: number; damagedQty?: number; productId?: string; sellingPrice?: number }>;
    expenses?: unknown;
  }, parseWeight: (size: string, unit: string) => number, resolveBulkItem: (tx: any, batch: any, franchiseId: string | null) => Promise<any>) {
    const batch = await prisma.productBatch.findUnique({
      where: { id: batchId },
      include: { product: true, production: { include: { recipe: true } } },
    });
    if (!batch) throw new Error('Product batch not found');
    const franchiseId = batch.franchiseId || batch.production?.franchiseId;
    if (!franchiseId) throw new Error('Franchise ID not found for batch');
    const categories = await this.getExpenseCategories();
    const rowsIn = Array.isArray(input.rows) ? input.rows.slice(0, 20) : [];
    // Same rule as packageAndConfirm: a recipe snapshot decides the expenses.
    const snapshot = batch.production?.expenseSnapshot ?? null;
    const lines = snapshot
      ? snapshotPackagingLines(snapshotExpenses(snapshot), rowsIn.map((r) => ({ packetSize: String(r.packetSize || '') })))
      : normalizeExpenseLines(input.expenses, categories, rowsIn.length);
    const yieldUnit = batch.production?.recipe?.yieldUnit || 'KG';

    // Bulk lots in the order startPackaging draws them. A batch still
    // awaiting release has no lot yet; it joins the pool last at its own cost.
    const invFranchiseId = await FranchiseService.toInventoryScopeId(prisma, franchiseId);
    let bulkItem: any = null;
    try { bulkItem = await resolveBulkItem(prisma, batch, invFranchiseId); } catch { bulkItem = null; }
    const bulkUnit = bulkItem?.unit || yieldUnit;
    const lots: Array<{ available: number; unitCost: number }> = bulkItem
      ? (await prisma.inventoryBatch.findMany({
          where: { inventoryItemId: bulkItem.id, currentQty: { gt: 0 }, status: 'APPROVED', OR: [{ expDate: null }, { expDate: { gte: new Date() } }] },
          orderBy: [{ mfgDate: 'asc' }, { createdAt: 'asc' }],
          select: { currentQty: true, unitCost: true },
        })).map((l) => ({ available: l.currentQty, unitCost: l.unitCost || 0 }))
      : [];
    const batchUnitCost = batch.unitCost ?? ((batch.totalCost || 0) / (batch.quantity || 1));
    if ((batch.qcStatus || 'PENDING') === 'PENDING') lots.push({ available: batch.quantity || 0, unitCost: batchUnitCost });

    const productIds = rowsIn.map((r) => r.productId).filter(Boolean) as string[];
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, basePrice: true } })
      : [];

    const costRows = rowsIn.map((r) => {
      const good = Math.max(0, Math.floor(Number(r.packedQty) || 0));
      const damaged = Math.max(0, Math.floor(Number(r.damagedQty) || 0));
      let packWeight = 0;
      try { packWeight = parseWeight(String(r.packetSize || ''), bulkUnit); } catch { packWeight = 0; }
      const weight = packWeight * (good + damaged);
      const price = r.productId ? products.find((p) => p.id === r.productId)?.basePrice : r.sellingPrice;
      return {
        packetSize: String(r.packetSize || ''),
        packWeight,
        good,
        damaged,
        bulkCost: simulateFifoCost(lots, weight, bulkItem?.costPrice || batchUnitCost),
        sellingPrice: price ?? null,
      };
    });

    const yieldQty = batch.approvedQty || batch.quantity || 0;
    const requested = costRows.reduce((s, r) => s + r.packWeight * (r.good + r.damaged), 0);
    const finishesBatch = (batch.packagedQty || 0) + requested >= yieldQty - 0.001;
    const shared = this.mergeShared(await this.loadSharedExpenses(prisma, batchId), lines);
    const result = computePackagingCosts({ rows: costRows, bulkUnit, lines, shared, yieldQty, finishesBatch, categories });
    return { unit: bulkUnit, rows: result.rows, finishesBatch, shared, expenseSource: snapshot ? 'RECIPE_SNAPSHOT' : 'LEGACY' };
  }
}
