import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { WasteService } from '../waste/waste.service';
import { FranchiseService } from '../franchise/franchise.service';
import { ProductionStatus } from '@prisma/client';
import { convertMeasurement, ValidUnit } from '@businessgroupikasle/erp-units';
import { generateSku } from '../product/product.service';

// Units parseWeight() knows how to convert between (kg<->g, l<->ml) or treat
// as identity (pcs, unit). Anything outside this set — a stray label like
// "units" left over from before a bulk item's unit tracked the recipe's real
// yieldUnit — can't be safely converted and must trigger the self-heal below,
// not fall through to an unconverted 1:1 comparison.
const RECOGNIZED_PACK_UNITS = ['kg', 'g', 'l', 'ml', 'pcs', 'unit'];

// Derives the bulk SEMI_FINISHED item's name/SKU. A ProductBatch's Product
// link is optional (bulk-manufacturing recipes like FRUITMIX have none —
// only POS made-to-order recipes need one, see pos.controller.ts), so when
// there's no Product this falls back to the recipe's own identity instead of
// creating one. recipe.recipeCode is the canonical base SKU; recipe.name is
// the display-name fallback.
function resolveBulkIdentity(
  product: { id: string; sku: string | null; name: string } | null | undefined,
  recipe: { recipeCode: string | null; name: string } | null | undefined,
): { bulkSku: string; bulkName: string } {
  if (recipe) {
    const baseCode = recipe.recipeCode || recipe.name || 'RECIPE';
    const bulkSku = baseCode.toUpperCase().endsWith('-BULK') ? baseCode.toUpperCase() : `${baseCode.toUpperCase()}-BULK`;
    const baseName = recipe.name || baseCode;
    const bulkName = baseName.endsWith(' - Bulk') ? baseName : `${baseName} - Bulk`;
    return { bulkSku, bulkName };
  }

  if (product) {
    const bulkSku = product.sku
      ? (product.sku.endsWith('-BULK') ? product.sku : `${product.sku}-BULK`)
      : `PRD-${product.id.substring(0, 5).toUpperCase()}-BULK`;
    const bulkName = product.name.endsWith(' - Bulk') ? product.name : `${product.name} - Bulk`;
    return { bulkSku, bulkName };
  }

  return { bulkSku: 'RECIPE-BULK', bulkName: 'RECIPE - Bulk' };
}

export class ProductionService {
  /**
   * Allocate the one business-facing batch identity for a production run.
   * The NumberSequence upsert is atomic within the surrounding transaction,
   * so retries/concurrent starts cannot reuse a code.
   */
  private static async nextProductionBatchCode(tx: any): Promise<string> {
    const year = new Date().getFullYear();
    const seq = await tx.numberSequence.upsert({
      where: { key: `PRODUCTION_BATCH_${year}` },
      create: { key: `PRODUCTION_BATCH_${year}`, value: 1 },
      update: { value: { increment: 1 } },
    });
    return `PRD-${year}-${String(seq.value).padStart(4, '0')}`;
  }

  static async startProduction(data: {
    recipeId: string;
    quantity: number;
    franchiseId?: string;
    warehouseId?: string;
    customerId?: string;
    productionType: string;
    expiryDate?: string;
    userId?: string;
    operatorId?: string;
  }) {
    return prisma.$transaction(async tx => {
      // 1. Fetch recipe
      const recipe = await tx.recipe.findUnique({
        where: { id: data.recipeId },
        include: { recipeItems: { include: { inventoryItem: true } }, product: true },
      });
      if (!recipe) throw new Error('Recipe not found');

      // franchiseId is a required column on Production (other reports still
      // key off it) but no longer a user-facing concept for production —
      // resolve it server-side instead of trusting every caller to always
      // supply one (a SUPER_ADMIN with no franchise assigned + a frontend
      // fetch that hasn't resolved yet was hitting this and crashing the launch).
      // Always the real HQ franchise, never "whichever franchise happens to
      // be oldest" — that heuristic silently drifted onto whatever row had
      // the earliest createdAt (in practice, root-franchise) and, with zero
      // franchises, used to self-heal by creating an untracked, unflagged
      // "Default" franchise that bypassed FranchiseService.create entirely.
      const franchiseId: string = data.franchiseId ?? (await FranchiseService.getHqFranchise(tx)).id;

      // Calculate scalar based on batches (frontend sends number of batches/runs)
      // If recipe yield is 5 and we run it 2 times, scalar is 2.
      const scalar = data.quantity;

      // 2. Check ingredients. Stock is a warehouse concept, not a franchise
      // one — when a warehouse is given, availability is checked against
      // what's actually in THAT warehouse (matching what Formula Scaling /
      // Production Planning show on screen), not the item's franchise-wide
      // total. franchiseId is only a fallback for callers that predate
      // warehouse selection.
      //
      // RecipeItem.quantityRequired is expressed in the recipe's own unit
      // (item.unit, e.g. "g") while InventoryItem.currentStock/movements are
      // tracked in that item's own unit (item.inventoryItem.unit, e.g.
      // "KG") — two independent free-text fields with no guarantee they
      // match. Every amount compared against or deducted from stock must be
      // converted into the inventory item's unit first, via the same
      // centralized convertUnit() used below at deduction time, or an 8 KG
      // stock reads as "8" against a 500 g requirement and looks short by
      // 3 orders of magnitude.
      for (const item of recipe.recipeItems) {
        // Validate and convert recipe quantity into the inventory canonical unit.
        // convertMeasurement throws "Incompatible units" if recipe and inventory
        // units are from different dimensions (e.g. G vs ML), which is the
        // correct behavior — we never want a silent 1:1 fallback here.
        let amountNeededInCanonical: number;
        try {
          amountNeededInCanonical = convertMeasurement(
            item.quantityRequired * scalar,
            item.unit.toUpperCase() as ValidUnit,
            item.inventoryItem.unit.toUpperCase() as ValidUnit
          ).toNumber();
        } catch (e: any) {
          throw new Error(
            `Unit mismatch for ingredient "${item.inventoryItem.name}": ` +
            `recipe requires ${item.unit} but inventory tracks ${item.inventoryItem.unit}. ` +
            `${e.message}`
          );
        }
        if (data.warehouseId) {
          const available = await InventoryService.computeWarehouseStock(item.inventoryItemId, data.warehouseId, tx);
          if (available < amountNeededInCanonical) {
            throw new Error(`Insufficient stock for "${item.inventoryItem.name}" in the selected warehouse (need ${amountNeededInCanonical.toFixed(3)} ${item.inventoryItem.unit}, have ${available.toFixed(3)} ${item.inventoryItem.unit})`);
          }
        } else {
          const inv = await tx.inventoryItem.findFirst({
            where: { id: item.inventoryItemId, franchiseId },
          });
          if (!inv || inv.currentStock < amountNeededInCanonical) {
            throw new Error(`Insufficient stock for "${inv?.name ?? 'ingredient'}"`);
          }
        }
      }

      // 3. Expiry is derived from the linked Product's configured shelf life,
      // the earliest expiry date of the consumed GRN raw material ingredients, or fallback.
      const DEFAULT_SHELF_LIFE_DAYS = 7;
      const shelfLifeDays = recipe.product?.shelfLifeDays;

      // Look up the earliest GRN ingredient batch expiry date for recipe items
      const ingredientItemIds = recipe.recipeItems.map(ri => ri.inventoryItemId);
      const ingredientBatches = await tx.inventoryBatch.findMany({
        where: {
          inventoryItemId: { in: ingredientItemIds },
          currentQty: { gt: 0 },
          expDate: { not: null },
          status: 'APPROVED',
        },
        orderBy: { expDate: 'asc' },
        take: 1,
      });
      const earliestIngredientExpiry = ingredientBatches[0]?.expDate;

      let expiryDate: Date;
      if (data.expiryDate) {
        expiryDate = new Date(data.expiryDate);
      } else if (shelfLifeDays) {
        const productExpiry = new Date(Date.now() + shelfLifeDays * 24 * 60 * 60 * 1000);
        expiryDate = earliestIngredientExpiry && earliestIngredientExpiry < productExpiry
          ? earliestIngredientExpiry
          : productExpiry;
      } else if (earliestIngredientExpiry) {
        expiryDate = earliestIngredientExpiry;
      } else {
        expiryDate = new Date(Date.now() + DEFAULT_SHELF_LIFE_DAYS * 24 * 60 * 60 * 1000);
      }

      // 4. Create production record (IN_PROGRESS). This code is the single
      // business identity for the run and every downstream batch reference.
      const productionBatchCode = await this.nextProductionBatchCode(tx);
      const production = await tx.production.create({
        data: {
          productionBatchCode,
          recipeId: data.recipeId,
          quantity: data.quantity,
          franchiseId,
          warehouseId: data.warehouseId || null,
          customerId: data.customerId,
          productionType: data.productionType,
          status: 'IN_PROGRESS',
          startTime: new Date(),
          producedBy: data.userId,
          operatorId: data.operatorId || null,
          expiryDate,
          currentStage: 'QUEUED',
          stageUpdatedAt: new Date(),
        },
      });

      await tx.productionStageLog.create({
        data: { productionId: production.id, stage: 'QUEUED' },
      });

      // 5. Deduct raw materials, capturing the real FIFO lot cost of whatever
      // was actually consumed (oldest/cheapest purchase lot first) instead of
      // letting it get discarded once the batch rows are decremented.
      let materialCost = 0;
      for (const item of recipe.recipeItems) {
        // Pass the recipe unit and raw quantity to recordMovement. The engine
        // normalizes to the inventory canonical unit (item.inventoryItem.unit)
        // internally, storing transactionUnit on the ledger row for audit
        // traceability. We do NOT pre-convert here — the single source of
        // truth for conversion is @businessgroupikasle/erp-units inside recordMovement.
        const rawQty = item.quantityRequired * scalar; // in item.unit (e.g. 500 g)
        // Also compute the canonical amount for cost calculations below
        const amountNeededInCanonical = convertMeasurement(
          rawQty,
          item.unit.toUpperCase() as ValidUnit,
          item.inventoryItem.unit.toUpperCase() as ValidUnit
        ).toNumber();
        const { fifo } = await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PRODUCTION_OUT',
          quantity: -rawQty,
          transactionUnit: item.unit,
          referenceType: 'PRODUCTION',
          referenceId: production.id,
          note: `Production started: ${recipe.name}`,
          userId: data.userId,
          warehouseId: data.warehouseId,
        });
        const amountNeeded = amountNeededInCanonical; // alias for cost section below

        // Fall back to the item's moving-average costPrice for any portion
        // that had no tracked batch to draw from (e.g. opening stock), so a
        // gap in batch tracking doesn't just silently zero out the cost.
        const untracked = amountNeeded - (fifo?.consumedFromBatches || 0);
        const fallbackCost = untracked > 0
          ? untracked * (item.inventoryItem.costPrice || 0)
          : 0;
        const totalCost = (fifo?.totalCost || 0) + fallbackCost;
        const unitCost = amountNeeded > 0 ? totalCost / amountNeeded : 0;
        materialCost += totalCost;

        // Every kilogram accounted for in totalCost needs to be visible in
        // the breakdown, not just the portion that had a tracked purchase
        // batch — otherwise the UI shows a blended unit cost with no way to
        // see where part of it came from.
        const breakdown = fifo?.consumptions ? [...fifo.consumptions] : [];
        if (untracked > 0) {
          breakdown.push({
            batchId: null,
            billNumber: 'Weighted avg. (no purchase batch on record)',
            productBatchId: null,
            qty: untracked,
            unitCost: item.inventoryItem.costPrice || 0,
            totalCost: fallbackCost,
          } as any);
        }

        await tx.productionItem.create({
          data: {
            productionId: production.id,
            inventoryItemId: item.inventoryItemId,
            usedQuantity: amountNeeded,
            unitCost,
            totalCost,
            batchBreakdown: breakdown.length ? (breakdown as any) : undefined,
          },
        });
      }

      return tx.production.update({
        where: { id: production.id },
        data: {
          materialCost,
          totalCost: materialCost + (production.laborCost || 0) + (production.overheadCost || 0),
        },
      });
    });
  }

  static async stopProduction(id: string) {
    return prisma.production.update({
      where: { id },
      data: {
        status: 'STOPPED',
        endTime: new Date(),
      },
    });
  }

  /**
   * Advance a run's physical stage (Queued -> Mixing -> Cooking -> Cooling ->
   * Ready for QC). Previously the Active Runs UI showed a hardcoded "Current
   * Stage: Mixing" and a hardcoded elapsed-time/completion% regardless of
   * what was actually happening — this makes that data real.
   */
  static async advanceStage(id: string, stage: string) {
    return prisma.$transaction(async tx => {
      const production = await tx.production.findUnique({ where: { id } });
      if (!production) throw new Error('Production run not found');
      if (production.status !== 'IN_PROGRESS') {
        throw new Error('Can only update stage while the run is in progress');
      }

      const updated = await tx.production.update({
        where: { id },
        data: { currentStage: stage as any, stageUpdatedAt: new Date() },
      });

      await tx.productionStageLog.create({
        data: { productionId: id, stage: stage as any },
      });

      return updated;
    });
  }

  static async getStageHistory(id: string) {
    return prisma.productionStageLog.findMany({
      where: { productionId: id },
      orderBy: { enteredAt: 'asc' },
    });
  }

  static async approveProduction(id: string, userId?: string, actualYield?: number, remarks?: string, expiryDate?: string) {
    return prisma.$transaction(async tx => {
      // Row-lock the production row first. Without this, two concurrent
      // Complete Production calls for the same run (a double-click, a
      // retried request) can both read status IN_PROGRESS and
      // productionBatchCode null before either commits, both pass the
      // guard below, and both allocate a batch code + create a
      // ProductBatch — leaving two batches for one run, with the
      // Production row's productionBatchCode ending up as whichever
      // commit won last (see the ProductBatch.productionId @unique
      // constraint, which now also backstops this at the DB level). The
      // lock forces the second call to wait, then see the first call's
      // committed COMPLETED status and reject via the guard below —
      // mirroring the same pattern already used in confirmPackaging.
      await tx.$queryRaw`SELECT id FROM "Production" WHERE id = ${id} FOR UPDATE`;
      const production = await tx.production.findUnique({
        where: { id },
        include: { recipe: { include: { product: true, recipeItems: true } } },
      });

      // The normal path is Queued -> Mixing -> Cooking -> Cooling -> QC while
      // status stays IN_PROGRESS the whole time (advanceStage only touches
      // currentStage, never status) — "STOPPED" is a separate manual pause
      // action, not something every run passes through. Requiring it here
      // made completing a run that was never paused always fail.
      if (!production || (production.status !== 'STOPPED' && production.status !== 'IN_PROGRESS')) {
        throw new Error('Production must be in progress or stopped before approval');
      }

      const recipe = production.recipe;
      if (!recipe) {
        throw new Error('Recipe not found');
      }
      // recipe.productId is optional — a recipe only needs a linked Product
      // for the POS made-to-order sale path (see pos.controller.ts). Bulk
      // manufacturing recipes go Production -> QC -> Bulk -> Packaging
      // without ever needing a Product, so ProductBatch.productId is
      // likewise optional and simply mirrors whatever the recipe has.
      const totalYield = actualYield !== undefined ? actualYield : (production.quantity * recipe.yieldQty);

      // The batch's real unit cost: whatever raw materials this specific run
      // actually consumed (FIFO lot cost, see startProduction), spread over
      // the yield. Two runs of the same recipe can land on different unit
      // costs if the second one drew from a pricier purchase lot.
      const totalCost = production.totalCost ?? production.materialCost ?? 0;
      const unitCost = totalYield > 0 ? totalCost / totalYield : 0;

      // A legacy in-progress run may predate productionBatchCode. Allocate it
      // once here, then persist it on Production before creating ProductBatch.
      const productionBatchCode = production.productionBatchCode
        || await this.nextProductionBatchCode(tx);
      if (!production.productionBatchCode) {
        await tx.production.update({
          where: { id: production.id },
          data: { productionBatchCode },
        });
      }

      // Create ProductBatch with PENDING QC status. Deliberately does NOT
      // touch stock — finished-good stock is credited exactly once, at QC
      // acceptance (inspectBatch, guarded against re-inspection), never here.
      // The operator completing this run can confirm/correct the expiry
      // date at handoff time (same as GRN's expiry capture for raw
      // material lots) — it overrides the estimate computed at
      // startProduction, since actual cook/QC timing can shift it.
      const batch = await tx.productBatch.create({
        data: {
          productId: recipe.productId ?? null,
          productionId: production.id,
          quantity: totalYield,
          expiryDate: expiryDate ? new Date(expiryDate) : production.expiryDate,
          batchCode: productionBatchCode,
          franchiseId: production.franchiseId,
          qcStatus: "PENDING",
          approvedQty: 0,
          rejectionQty: 0,
          packagingStatus: "PENDING",
          unitCost,
          totalCost,
        },
      });

      // Finalize status and record actual yield. endTime previously only
      // ever got set by stopProduction (a pause) — a run that finished
      // normally had no recorded completion time at all.
      const completedProduction = await tx.production.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          actualYield: totalYield,
          endTime: new Date(),
          ...(remarks ? { remarks } : {}),
        },
      });
      return { production: completedProduction, batch };
    });
  }

  static async inspectBatch(data: {
    batchId: string;
    moistureCheck?: number;
    colorCheck?: string;
    textureCheck?: string;
    rejectionQty?: number;
    qcRemarks?: string;
    userId?: string;
  }) {
    return prisma.$transaction(async tx => {
      const batch = await tx.productBatch.findUnique({
        where: { id: data.batchId },
        include: { product: true, production: { include: { recipe: true } } },
      });
      if (!batch) throw new Error('Product batch not found');

      // Finished-good stock is credited exactly once, at QC acceptance —
      // approveProduction() deliberately never touches stock (it only creates
      // this batch as PENDING). Without this guard, re-submitting QC on the
      // same batch would call recordMovement() again below and double the
      // stock increase, since nothing else prevents re-inspection.
      if (batch.qcStatus !== 'PENDING') {
        throw new Error(`Batch ${batch.batchCode} has already been QC inspected (status: ${batch.qcStatus}). Stock was credited once at that time and cannot be re-applied.`);
      }

      const rejection = data.rejectionQty || 0;
      if (rejection < 0 || rejection > batch.quantity) {
        throw new Error(`Rejected quantity must be between 0 and the produced quantity (${batch.quantity})`);
      }
      const approvedQty = Math.max(0, batch.quantity - rejection);
      const qcStatus = rejection <= 0 ? 'APPROVED' : approvedQty <= 0 ? 'REJECTED' : 'PARTIALLY_APPROVED';

      const totalBatchCost = batch.totalCost || batch.production?.totalCost || batch.production?.materialCost || 0;
      const effectiveBulkUnitCost = approvedQty > 0
        ? Number((totalBatchCost / approvedQty).toFixed(4))
        : (batch.unitCost || 0);

      const updatedBatch = await tx.productBatch.update({
        where: { id: data.batchId },
        data: {
          qcStatus,
          moistureCheck: data.moistureCheck,
          colorCheck: data.colorCheck,
          textureCheck: data.textureCheck,
          rejectionQty: rejection,
          approvedQty: approvedQty,
          unitCost: effectiveBulkUnitCost,
          qcRemarks: data.qcRemarks || null,
        },
      });

      const needsTargetItem = approvedQty > 0 || rejection > 0;

      if (needsTargetItem) {
        const franchiseId = batch.franchiseId || batch.production?.franchiseId;
        if (!franchiseId) throw new Error('Franchise ID not found for batch');
        const invFranchiseId = await FranchiseService.toInventoryScopeId(tx, franchiseId);
        const finishedGoodUnit = batch.production?.recipe?.yieldUnit || 'KG';

        const { bulkSku, bulkName } = resolveBulkIdentity(batch.product, batch.production?.recipe);

        let targetItem = await tx.inventoryItem.findFirst({
          where: {
            franchiseId: invFranchiseId,
            OR: [
              { sku: bulkSku },
              { name: bulkName },
            ],
          },
        });

        if (!targetItem) {
          targetItem = await tx.inventoryItem.create({
            data: {
              name: bulkName,
              sku: bulkSku,
              category: 'SEMI_FINISHED',
              currentStock: 0,
              unit: finishedGoodUnit,
              minimumStock: 5,
              franchiseId: invFranchiseId,
            },
          });
        } else if (!RECOGNIZED_PACK_UNITS.includes(targetItem.unit.toLowerCase()) && RECOGNIZED_PACK_UNITS.includes(finishedGoodUnit.toLowerCase())) {
          targetItem = await tx.inventoryItem.update({
            where: { id: targetItem.id },
            data: { unit: finishedGoodUnit },
          });
        }

        if (approvedQty > 0) {
          // Credits approved bulk stock carrying the effective cost (total batch cost / approvedQty)
          await InventoryService.recordMovement(tx, {
            itemId: targetItem.id,
            type: 'PRODUCTION_IN',
            quantity: approvedQty,
            transactionUnit: finishedGoodUnit,
            referenceType: 'PRODUCTION',
            referenceId: batch.productionId || batch.id,
            note: `QC Approved batch: ${batch.batchCode} (${approvedQty} units approved after ${rejection} rejected at effective unit cost ₹${effectiveBulkUnitCost.toFixed(4)})`,
            userId: data.userId,
            warehouseId: batch.production?.warehouseId || undefined,
            receiveAtCost: {
              unitCost: effectiveBulkUnitCost,
              batchNumber: batch.batchCode || undefined,
              mfgDate: batch.mfgDate,
              expDate: batch.expiryDate,
              productBatchId: batch.id,
            },
          });
        }

        if (rejection > 0) {
          await tx.wasteEntry.create({
            data: {
              inventoryItemId: targetItem.id,
              franchiseId,
              warehouseId: batch.production?.warehouseId || undefined,
              quantity: rejection,
              reason: 'QC_FAIL',
              note: data.qcRemarks || `QC rejected from batch ${batch.batchCode}`,
              costAtTime: rejection * (batch.unitCost || targetItem.costPrice || 0),
            },
          });
        }
      }

      return updatedBatch;
    });
  }

  // Derives the retail FINISHED_GOOD item's name/SKU from the bulk item plus
  // pack size. Shared by confirmPackaging (the only place that still needs
  // it — see the module-level two-phase-packaging note above startPackaging).
  private static deriveRetailIdentity(
    bulkItem: { sku: string; name: string },
    packetSize: string,
    hasLinkedProduct: boolean,
  ): { retailSku: string; retailName: string } {
    const baseSku = bulkItem.sku.replace(/-BULK$/i, '');
    const baseName = bulkItem.name.replace(/\s+-\s+Bulk$/i, '').replace(/\s+\(Bulk\)$/i, '');

    // The base product's own name/SKU often already carries the master
    // pack size (e.g. product "Idly Batter 1 Kg", sku "...-1-KG-1KG") —
    // naively appending the retail pack size on top produced stacked,
    // conflicting sizes like "Idly Batter 1 Kg (250g)" / "...-1-KG-1KG-250G".
    // Strip any trailing weight/volume/count token first so the retail
    // variant reads as its own size, not the master's size plus the pack's.
    // This only applies to a linked Product's own name/SKU — a recipe-code
    // fallback base (e.g. "RCP-0001") has no embedded master pack size, and
    // its trailing digits are part of the code's identity, not a size to
    // strip (stripping them collapsed "RCP-0001" down to "RCP").
    const stripTrailingSizeSegments = (sku: string): string => {
      const segments = sku.split('-');
      const isSizeSegment = (seg: string) =>
        /^\d+(\.\d+)?$/.test(seg) ||
        /^(KG|G|L|ML|PCS|UNITS?)$/i.test(seg) ||
        /^\d+(\.\d+)?(KG|G|L|ML|PCS|UNITS?)$/i.test(seg);
      while (segments.length > 1 && isSizeSegment(segments[segments.length - 1])) {
        segments.pop();
      }
      return segments.join('-');
    };
    const cleanBaseName = hasLinkedProduct
      ? (baseName.replace(/\s+\d+(\.\d+)?\s*(kg|g|l|ml|pcs|units?)\.?$/i, '').trim() || baseName)
      : baseName;
    const cleanBaseSku = hasLinkedProduct
      ? (stripTrailingSizeSegments(baseSku) || baseSku)
      : baseSku;

    const packetSizeMatch = packetSize.match(/^(\d+(\.\d+)?)\s*(g|kg|l|ml|pcs|unit)$/i);
    const formattedPacketSize = packetSizeMatch ? `${packetSizeMatch[1]} ${packetSizeMatch[3].toUpperCase()}` : packetSize;
    const cleanPacketSize = packetSize.toUpperCase().replace(/\s+/g, '');

    const retailSku = cleanBaseSku.includes(cleanPacketSize) ? cleanBaseSku : `${cleanBaseSku}-${cleanPacketSize}`;
    const retailName = cleanBaseName.toLowerCase().includes(formattedPacketSize.toLowerCase())
      ? cleanBaseName
      : `${cleanBaseName} ${formattedPacketSize}`;

    return { retailSku, retailName };
  }

  // Re-run at both startPackaging and confirmPackaging: looks up the bulk
  // item for a batch and self-heals a stale generic 'unit' label so the
  // g/kg conversion below stays correct. Throws if there's no bulk item at
  // all — a batch can't be packaged (started or confirmed) without one.
  private static async resolveBulkItem(tx: any, batch: any, franchiseId: string | null) {
    const { bulkSku, bulkName } = resolveBulkIdentity(batch.product, batch.production?.recipe);

    let bulkItem = await tx.inventoryItem.findFirst({
      where: { franchiseId, OR: [{ sku: bulkSku }, { name: bulkName }] },
    });
    if (!bulkItem) throw new Error('Bulk inventory item not found');

    // Self-heal a bulk item still carrying the old generic 'unit' label
    // (from before finished-goods items recorded their real yield unit) —
    // this is the actual point where a wrong unit breaks the g/kg
    // conversion below, not just at creation time in inspectBatch, so a
    // batch that was already QC-approved before that fix shipped needs
    // correcting here too.
    if (!RECOGNIZED_PACK_UNITS.includes(bulkItem.unit.toLowerCase())) {
      const finishedGoodUnit = batch.production?.recipe?.yieldUnit || 'KG';
      if (RECOGNIZED_PACK_UNITS.includes(finishedGoodUnit.toLowerCase())) {
        bulkItem = await tx.inventoryItem.update({
          where: { id: bulkItem.id },
          data: { unit: finishedGoodUnit },
        });
      }
    }

    return bulkItem;
  }

  // ── Two-phase packaging ───────────────────────────────────────────────
  // Phase 1 (this method): create an AWAITING_CONFIRMATION ticket only.
  // Nothing here touches InventoryItem/StockMovement/ProductBatch.packagedQty
  // — bulk deduction and Finished Goods creation only happen once the
  // operator has physically packed + labeled the run and reports the real
  // good/damaged/spoiled split via confirmPackaging (phase 2, below). This
  // replaces the old one-shot packageBatch, which deducted bulk and created
  // sellable Finished Goods stock the instant this button was clicked —
  // before a single physical label had been printed or a single packet
  // inspected.
  static async startPackaging(data: {
    batchId: string;
    packetSize: string;
    quantityPackets: number;
    productId?: string;
    userId?: string;
  }) {
    return prisma.$transaction(async tx => {
      const batch = await tx.productBatch.findUnique({
        where: { id: data.batchId },
        include: { product: true, production: { include: { recipe: true } } },
      });
      if (!batch) throw new Error('Product batch not found');

      // Allow both APPROVED and PARTIALLY_APPROVED — both have legitimate
      // approved bulk stock equal to batch.approvedQty.
      if (batch.qcStatus !== 'APPROVED' && batch.qcStatus !== 'PARTIALLY_APPROVED') {
        throw new Error('Batch must be QC approved (or partially approved) before packaging.');
      }

      const recall = await tx.batchRecall.findUnique({ where: { productBatchId: data.batchId } });
      if (recall?.status === 'IN_PROGRESS') {
        throw new Error('Packaging blocked — batch is under recall.');
      }

      if (data.productId) {
        const chosen = await tx.product.findUnique({ where: { id: data.productId } });
        if (chosen) {
          await tx.productBatch.update({
            where: { id: batch.id },
            data: { productId: chosen.id },
          });
        }
      }

      const franchiseId = batch.franchiseId || batch.production?.franchiseId;
      if (!franchiseId) throw new Error('Franchise ID not found for batch');
      const invFranchiseId = await FranchiseService.toInventoryScopeId(tx, franchiseId);

      let bulkItem = await this.resolveBulkItem(tx, batch, invFranchiseId);

      // Row-lock the bulk item so two concurrent Start Packaging calls for
      // this batch (a double-click, two tabs, two operators) can't both read
      // the same currentStock, both pass the check below, and both reserve
      // against stock that only really covers one of them. Re-read after the
      // lock is acquired — resolveBulkItem's read above may now be stale.
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${bulkItem.id} FOR UPDATE`;
      bulkItem = await tx.inventoryItem.findUniqueOrThrow({ where: { id: bulkItem.id } });

      const unitMultiplier = this.parseWeight(data.packetSize, bulkItem.unit);
      const totalWeightNeeded = data.quantityPackets * unitMultiplier;

      // This check and the reservation deduction below are the single
      // authoritative point where bulk availability is enforced — the lock
      // above makes it safe against concurrent Start Packaging calls, and
      // confirmPackaging deliberately does not re-check (see the comment
      // there): re-checking against currentStock post-reservation would
      // compare against a pool that already has this run's own reservation
      // subtracted from it, failing every confirm with a phantom shortage.
      if (bulkItem.currentStock < totalWeightNeeded) {
        const shortage = totalWeightNeeded - bulkItem.currentStock;
        throw new Error(`Insufficient bulk stock. Required: ${totalWeightNeeded.toFixed(2)} ${bulkItem.unit}, Available: ${bulkItem.currentStock.toFixed(2)} ${bulkItem.unit}, Shortage: ${shortage.toFixed(2)} ${bulkItem.unit}`);
      }

      // Cap against this batch's own QC-approved quantity minus both already-confirmed
      // packaging runs AND any in-flight pending packaging runs.
      const confirmedWeight = batch.packagedQty || 0;
      const pendingRuns = await tx.productPackaging.findMany({
        where: {
          batchId: batch.id,
          status: 'AWAITING_CONFIRMATION',
        },
        select: { totalWeight: true },
      });
      const pendingWeight = pendingRuns.reduce((sum, r) => sum + (r.totalWeight || 0), 0);
      const remainingAvailable = (batch.approvedQty || 0) - confirmedWeight - pendingWeight;

      if (batch.packagingStatus === 'PACKAGED' || remainingAvailable <= 0.001) {
        throw new Error('This batch is already fully packaged (or all remaining bulk is reserved by pending packaging runs).');
      }
      if (totalWeightNeeded > remainingAvailable + 0.001) {
        throw new Error(`Cannot package more than the batch's available approved quantity (${Math.max(0, remainingAvailable).toFixed(2)} ${bulkItem.unit} available; ${pendingWeight.toFixed(2)} ${bulkItem.unit} is already reserved in pending runs).`);
      }

      const barcode = `PKG-${batch.batchCode}-${data.packetSize.toUpperCase()}-${Date.now().toString().substring(8)}`;
      const packaging = await tx.productPackaging.create({
        data: {
          batchId: batch.id,
          packetSize: data.packetSize,
          quantityPackets: data.quantityPackets,
          totalWeight: totalWeightNeeded,
          barcode,
          printedLabels: false,
          status: 'AWAITING_CONFIRMATION',
        },
      });

      // Reserve the required bulk stock immediately against this run.
      // This ensures it cannot be consumed by other concurrent packaging runs
      // and acts as the transactional deduction.
      const { fifo } = await InventoryService.recordMovement(tx, {
        itemId: bulkItem.id,
        type: 'PRODUCTION_OUT',
        quantity: -totalWeightNeeded,
        referenceType: 'PACKAGING',
        referenceId: batch.id,
        note: `Packaging started: Reserved bulk stock for ${data.quantityPackets} x ${data.packetSize} packs`,
        userId: data.userId,
      });

      // The bulk pool is shared across every ProductBatch of this recipe —
      // FIFO can draw from an older/cheaper (or newer/pricier) batch than
      // the one being packaged here. Record exactly which lot(s) it actually
      // consumed so confirmPackaging() can cost this run from the real
      // consumption instead of just this ProductBatch's own unitCost, and so
      // recall traceability can follow material across batch boundaries.
      const bulkBreakdown = fifo?.consumptions?.map(c => ({
        batchId: c.batchId,
        productBatchId: c.productBatchId,
        billNumber: c.billNumber,
        qty: c.qty,
        unitCost: c.unitCost,
        totalCost: c.totalCost,
      })) ?? [];
      if (bulkBreakdown.length) {
        await tx.productPackaging.update({
          where: { id: packaging.id },
          data: { bulkBreakdown },
        });
      }

      return { packaging };
    });
  }

  static async savePackagingVerification(data: {
    packagingId: string;
    stickersPrinted: number;
    physicalChecked: boolean;
    goodQty: number;
    damagedQty: number;
    spoiledQty: number;
  }) {
    const packaging = await prisma.productPackaging.findUnique({
      where: { id: data.packagingId },
    });
    if (!packaging) throw new Error('Packaging run not found');
    if (packaging.status !== 'AWAITING_CONFIRMATION') {
      throw new Error(`This packaging run is already ${packaging.status.toLowerCase().replace('_', ' ')} and cannot be verified again.`);
    }

    return prisma.productPackaging.update({
      where: { id: data.packagingId },
      data: {
        stickersPrinted: data.stickersPrinted,
        physicalChecked: data.physicalChecked,
        goodQty: data.goodQty,
        damagedQty: data.damagedQty,
        spoiledQty: data.spoiledQty
      }
    });
  }

  // Phase 2: the operator reports the real outcome of the physical
  // packaging run (good / damaged / spoiled, summing to exactly the planned
  // quantityPackets from startPackaging — not checked sticker-by-sticker).
  // Only now does bulk get deducted and Finished Goods get created; damaged
  // and spoiled quantities never touch Finished Goods at all, mirroring how
  // a QC-rejected batch quantity never touches inventory either (see the
  // rejection-qty WasteEntry a few lines up in inspectBatch).
  static async confirmPackaging(data: {
    packagingId: string;
    goodQty: number;
    damagedQty: number;
    spoiledQty: number;
    productId?: string;
    userId?: string;
  }) {
    return prisma.$transaction(async tx => {
      // Row-lock the packaging ticket first. Without this, two concurrent
      // Confirm calls for the same ticket (a double-click, a retried
      // request) can both read status AWAITING_CONFIRMATION before either
      // commits its status update, both pass the guard below, and both
      // create Finished Goods stock + waste entries — the exact
      // double-deduction/duplicate-entry the status guard is meant to
      // prevent. The lock forces the second call to wait, then see the
      // first call's committed CONFIRMED status.
      await tx.$queryRaw`SELECT id FROM "ProductPackaging" WHERE id = ${data.packagingId} FOR UPDATE`;
      const packaging = await tx.productPackaging.findUnique({
        where: { id: data.packagingId },
        include: {
          batch: {
            include: { product: true, production: { include: { recipe: true } }, recall: true },
          },
        },
      });
      if (!packaging) throw new Error('Packaging run not found');
      // The ticket-status guard is what makes "confirm twice" and "bulk
      // deducted twice" impossible — a second confirm attempt fails right
      // here, before anything is touched.
      if (packaging.status !== 'AWAITING_CONFIRMATION') {
        throw new Error(`This packaging run is already ${packaging.status.toLowerCase().replace('_', ' ')} and cannot be confirmed again.`);
      }

      const batch = packaging.batch;

      // Re-check recall — a recall could have been initiated in the gap
      // between Start Packaging and Confirm, a gap that didn't exist under
      // the old one-shot flow.
      if (batch.recall?.status === 'IN_PROGRESS') {
        throw new Error('Cannot confirm — batch is under recall.');
      }

      const good = Number(data.goodQty) || 0;
      const damaged = Number(data.damagedQty) || 0;
      const spoiled = Number(data.spoiledQty) || 0;
      if (good < 0 || damaged < 0 || spoiled < 0) {
        throw new Error('Quantities cannot be negative.');
      }
      if (good + damaged + spoiled !== packaging.quantityPackets) {
        throw new Error(`Good + Damaged + Spoiled (${good + damaged + spoiled}) must equal the planned packaging quantity (${packaging.quantityPackets}).`);
      }

      let selectedProduct: any = null;
      if (data.productId) {
        selectedProduct = await tx.product.findUnique({ where: { id: data.productId } });
        if (!selectedProduct) {
          // If not found by primary ID, try looking up by SKU or exact Name
          selectedProduct = await tx.product.findFirst({
            where: {
              OR: [
                { sku: data.productId },
                { name: { equals: data.productId, mode: 'insensitive' } },
              ],
            },
          });
        }
        if (!selectedProduct) {
          // If data.productId was actually a Recipe ID, check if that recipe links to a real Product
          const recipe = await tx.recipe.findUnique({
            where: { id: data.productId },
            include: { product: true },
          });
          if (recipe?.product) {
            selectedProduct = recipe.product;
          }
        }
        if (selectedProduct && selectedProduct.isActive === false) {
          throw new Error('Selected sellable product is inactive.');
        }
        if (selectedProduct) {
          await tx.productBatch.update({
            where: { id: batch.id },
            data: { productId: selectedProduct.id },
          });
        }
      }

      const franchiseId = batch.franchiseId || batch.production?.franchiseId;
      if (!franchiseId) throw new Error('Franchise ID not found for batch');
      const invFranchiseId = await FranchiseService.toInventoryScopeId(tx, franchiseId);

      const bulkItem = await this.resolveBulkItem(tx, batch, invFranchiseId);

      const unitMultiplier = this.parseWeight(packaging.packetSize, bulkItem.unit);
      const totalWeightNeeded = packaging.quantityPackets * unitMultiplier;

      // The authoritative check and bulk deduction have already occurred in
      // startPackaging (which acts as a reservation). We do not re-check
      // bulkItem.currentStock here to avoid double-deducting or failing when
      // the reservation is the only reason stock is "short".

      const remainingInBatch = (batch.approvedQty || 0) - (batch.packagedQty || 0);
      if (batch.packagingStatus === 'PACKAGED' || remainingInBatch <= 0.001) {
        throw new Error('This batch is already fully packaged.');
      }
      if (totalWeightNeeded > remainingInBatch + 0.001) {
        throw new Error(`Cannot confirm — exceeds the batch's remaining approved quantity (${remainingInBatch.toFixed(2)} ${bulkItem.unit} left).`);
      }

      const linkedProduct = selectedProduct || (batch as any).product || (batch as any).production?.recipe?.product;
      let retailSku: string;
      let retailName: string;

      if (linkedProduct?.sku) {
        retailSku = linkedProduct.sku;
        retailName = linkedProduct.name;
      } else {
        const baseName = bulkItem.name.replace(/\s+-\s+Bulk$/i, '').replace(/\s+\(Bulk\)$/i, '');
        retailSku = generateSku('FINISHED_GOOD', baseName, packaging.packetSize);
        const packetSizeMatch = packaging.packetSize.match(/^(\d+(\.\d+)?)\s*(g|kg|l|ml|pcs|unit)$/i);
        const formattedPacketSize = packetSizeMatch ? `${packetSizeMatch[1]} ${packetSizeMatch[3].toUpperCase()}` : packaging.packetSize;
        retailName = baseName.toLowerCase().includes(formattedPacketSize.toLowerCase())
          ? baseName
          : `${baseName} ${formattedPacketSize}`;

        // Idempotent automatic catalog Product creation for unlinked recipe
        let product = await tx.product.findUnique({ where: { sku: retailSku } });
        if (!product) {
          product = await tx.product.create({
            data: {
              name: retailName,
              sku: retailSku,
              category: 'FINISHED_GOOD',
              productType: 'FINISHED_GOOD',
              basePrice: bulkItem.basePrice ? bulkItem.basePrice * unitMultiplier : 0,
              taxPercent: 5,
              isActive: true,
            },
          });
        }
      }

      let retailItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: invFranchiseId, sku: retailSku },
      });
      if (!retailItem) {
        retailItem = await tx.inventoryItem.create({
          data: {
            name: retailName,
            sku: retailSku,
            category: 'FINISHED_GOOD',
            currentStock: 0,
            unit: 'packet',
            minimumStock: 10,
            franchiseId: invFranchiseId,
            basePrice: bulkItem.basePrice ? bulkItem.basePrice * unitMultiplier : 0,
            costPrice: bulkItem.costPrice ? bulkItem.costPrice * unitMultiplier : 0,
          },
        });
      }

      // Total bulk cost allocated to this packaging run. The bulk pool is
      // shared across every ProductBatch of this recipe, so FIFO in
      // startPackaging() may have drawn from a different batch's lot than
      // the one being packaged here (see bulkBreakdown, recorded there at
      // reservation time). Cost this run from what was ACTUALLY consumed,
      // not from this ProductBatch's own unitCost — otherwise the physical
      // lot consumed and the cost charged to it can silently diverge.
      const bulkBreakdown: any[] = Array.isArray(packaging.bulkBreakdown) ? packaging.bulkBreakdown : [];
      const allocatedBulkCost = bulkBreakdown.length
        ? bulkBreakdown.reduce((s, b) => s + (b.totalCost || 0), 0)
        // Fallback for packaging tickets created before bulkBreakdown existed.
        : totalWeightNeeded * (batch.unitCost || bulkItem.costPrice || 0);
      // Effective unit cost per good packet (allocated bulk cost absorbed by good packets)
      const effectiveRetailUnitCost = good > 0
        ? Number((allocatedBulkCost / good).toFixed(4))
        : (bulkItem.costPrice ? bulkItem.costPrice * unitMultiplier : 0);

      // Only the GOOD quantity ever becomes sellable Finished Goods.
      // Credited at effectiveRetailUnitCost so good packets absorb packaging rejection.
      if (good > 0) {
        await InventoryService.recordMovement(tx, {
          itemId: retailItem.id,
          type: 'PRODUCTION_IN',
          quantity: good,
          referenceType: 'PACKAGING',
          referenceId: batch.id,
          note: `Packaging confirmed: ${good} good units from batch ${batch.batchCode} at effective unit cost ₹${effectiveRetailUnitCost.toFixed(4)}`,
          userId: data.userId,
          warehouseId: batch.production?.warehouseId || undefined,
          receiveAtCost: {
            unitCost: effectiveRetailUnitCost,
            batchNumber: batch.batchCode || undefined,
            mfgDate: batch.mfgDate,
            expDate: batch.expiryDate,
            productBatchId: batch.id,
          },
        });
      }

      const wasteEntries: any[] = [];
      if (damaged > 0) {
        wasteEntries.push(await WasteService.createFromProductionReject(tx, {
          inventoryItemId: retailItem.id,
          franchiseId,
          warehouseId: batch.production?.warehouseId || undefined,
          quantity: damaged,
          reason: 'DAMAGED',
          note: `Damaged during packaging confirmation of batch ${batch.batchCode}`,
          productPackagingId: packaging.id,
          unitCost: effectiveRetailUnitCost || undefined,
        }));
      }
      if (spoiled > 0) {
        wasteEntries.push(await WasteService.createFromProductionReject(tx, {
          inventoryItemId: retailItem.id,
          franchiseId,
          warehouseId: batch.production?.warehouseId || undefined,
          quantity: spoiled,
          reason: 'SPOILAGE',
          note: `Spoiled during packaging confirmation of batch ${batch.batchCode}`,
          productPackagingId: packaging.id,
          unitCost: effectiveRetailUnitCost || undefined,
        }));
      }

      // A batch can be packaged across multiple confirmed runs — only mark
      // it fully PACKAGED once the cumulative confirmed weight covers the
      // batch quantity, otherwise it's PARTIALLY_PACKED.
      const newPackagedQty = (batch.packagedQty || 0) + totalWeightNeeded;
      const newPackagingStatus = newPackagedQty >= (batch.approvedQty || 0) - 0.001 ? 'PACKAGED' : 'PARTIALLY_PACKED';

      await tx.productBatch.update({
        where: { id: batch.id },
        data: {
          packagingStatus: newPackagingStatus,
          packagedQty: newPackagedQty,
        },
      });

      const confirmedPackaging = await tx.productPackaging.update({
        where: { id: packaging.id },
        data: {
          status: 'CONFIRMED',
          goodQty: good,
          damagedQty: damaged,
          spoiledQty: spoiled,
          confirmedAt: new Date(),
        },
      });

      return { packaging: confirmedPackaging, retailItem, bulkItem, wasteEntries };
    });
  }

  static async cancelPackaging(data: { packagingId: string; userId?: string; reason?: string }) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ProductPackaging" WHERE id = ${data.packagingId} FOR UPDATE`;
      const packaging = await tx.productPackaging.findUnique({
        where: { id: data.packagingId },
        include: {
          batch: {
            include: { product: true, production: { include: { recipe: true } } },
          },
        },
      });
      if (!packaging) throw new Error('Packaging run not found');
      if (packaging.status !== 'AWAITING_CONFIRMATION') {
        throw new Error(`This packaging run is already ${packaging.status.toLowerCase().replace('_', ' ')} and cannot be cancelled.`);
      }

      const batch = packaging.batch;
      const franchiseId = batch.franchiseId || batch.production?.franchiseId;
      if (!franchiseId) throw new Error('Franchise ID not found for batch');
      const invFranchiseId = await FranchiseService.toInventoryScopeId(tx, franchiseId);

      const bulkItem = await this.resolveBulkItem(tx, batch, invFranchiseId);

      // Refund / release the reserved bulk stock back to InventoryItem
      await InventoryService.recordMovement(tx, {
        itemId: bulkItem.id,
        type: 'PRODUCTION_IN',
        quantity: packaging.totalWeight,
        referenceType: 'PACKAGING',
        referenceId: batch.id,
        note: `Packaging run cancelled: Released reserved bulk stock of ${packaging.totalWeight} ${bulkItem.unit} for ticket ${packaging.barcode}${data.reason ? ` (Reason: ${data.reason})` : ''}`,
        userId: data.userId,
      });

      const updatedPackaging = await tx.productPackaging.update({
        where: { id: packaging.id },
        data: {
          status: 'CANCELLED',
        },
      });

      return { packaging: updatedPackaging, bulkItem };
    });
  }

  private static parseWeight(size: string, bulkUnit: string): number {
    const match = size.match(/^(\d+(\.\d+)?)\s*(g|kg|l|ml|pcs|unit)$/i);
    // Silently treating an unparseable size as "1 KG per packet" let a typo
    // (missing/garbled unit) produce a wrong-but-plausible stock deduction
    // with no warning. Fail loudly instead — this is what actually decides
    // how much bulk stock gets consumed.
    if (!match) {
      throw new Error(`Invalid packet size "${size}" — expected a number with a unit, e.g. "250 g" or "1 Kg".`);
    }
    const val = parseFloat(match[1]);
    const packetUnit = match[3].toUpperCase();
    const targetUnit = bulkUnit.toUpperCase();

    if (packetUnit === targetUnit) return val;

    try {
      return convertMeasurement(val, packetUnit as ValidUnit, targetUnit as ValidUnit).toNumber();
    } catch {
      throw new Error(`Cannot convert packet size "${size}" to bulk stock unit "${bulkUnit}" — the product's recipe yield unit must be KG, G, L, or ML.`);
    }
  }


  static async getProductionHistory(franchiseId?: string, startDate?: string, endDate?: string, status?: string) {
    const where: any = {};
    if (franchiseId) where.franchiseId = franchiseId;
    if (status) where.status = status;
    if (startDate || endDate) {
      // Production has no createdAt column — producedAt is the model's own
      // date field (also what this query already orders by below).
      const producedAtFilter: any = {};
      if (startDate) producedAtFilter.gte = new Date(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000`);
      if (endDate) producedAtFilter.lte = new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999`);
      where.producedAt = producedAtFilter;
    }
    return prisma.production.findMany({
      where,
      include: {
        recipe: { include: { product: true, recipeItems: { include: { inventoryItem: true } } } },
        items: { include: { inventoryItem: true } },
        batches: true,
        customer: true,
        operator: { include: { user: true } },
      },
      orderBy: { producedAt: 'desc' },
    });
  }

  static async getBatchById(id: string) {
    return prisma.production.findUnique({
      where: { id },
      include: {
        recipe: { include: { product: true, recipeItems: { include: { inventoryItem: true } } } },
        items: { include: { inventoryItem: true } },
        batches: true,
        customer: true,
        operator: { include: { user: true } },
      },
    });
  }

  static async updateStatus(id: string, status: ProductionStatus) {
    return prisma.production.update({ where: { id }, data: { status } });
  }

  // Get all product batches with expiry status (filtered by franchise if provided)
  static async getProductBatches(productId?: string, franchiseId?: string) {
    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days (1 week)

    const where: any = {
      OR: [
        { expiryDate: { not: null } },
        { production: { expiryDate: { not: null } } }
      ]
    };
    if (productId) where.productId = productId;
    if (franchiseId) where.franchiseId = franchiseId;

    const batches = await prisma.productBatch.findMany({
      where,
      include: {
        product: true,
        franchise: true,
        packagings: true,
        production: {
          include: {
            recipe: true,
            items: { include: { inventoryItem: true } },
            stageLogs: { orderBy: { enteredAt: 'asc' } },
          },
        },
        // Real remaining stock for "Available FG" (see below) — only lots on
        // the FINISHED_GOOD retail item count; the bulk SEMI_FINISHED lot
        // created at QC approval is also linked to this same productBatchId
        // and must not be counted here.
        inventoryBatches: { include: { inventoryItem: true } },
        // So the Batch Registry (and any other list consuming this
        // endpoint) can show IN_PROGRESS/COMPLETED/CANCELLED recall status
        // instead of only ever showing APPROVED/PENDING QC status.
        recall: { select: { status: true, step: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const mappedProductBatches = batches.map(b => {
      const effectiveExpiry = b.expiryDate || b.production?.expiryDate;
      const packedQuantity = b.packagedQty || 0;
      const bulkQuantity = Math.max(0, (b.approvedQty || 0) - (b.packagedQty || 0));
      // "Available FG" — stock from this batch still actually sitting in
      // inventory right now, not just historical good-output. confirmPackaging
      // credits the good quantity as a real lot (productBatchId-linked
      // InventoryBatch), which every subsequent sale/transfer/waste already
      // depletes FIFO — so this lot's remaining currentQty naturally falls as
      // that stock moves out. Falls back to the historical good-produced
      // count only for batches packaged before that lot-tracking existed
      // (no FINISHED_GOOD lot on record at all), so old batches don't
      // suddenly show 0.
      const fgLots = (b.inventoryBatches || []).filter(ib => ib.inventoryItem?.category === 'FINISHED_GOOD');
      const availableQuantity = fgLots.length > 0
        ? fgLots.reduce((sum, ib) => sum + (ib.currentQty || 0), 0)
        : (b.packagings
            ?.filter(p => p.status === 'CONFIRMED')
            .reduce((sum, p) => sum + (p.goodQty ?? p.quantityPackets ?? 0), 0) || 0);

      return {
        ...b,
        // ProductBatch.product is legitimately null for bulk-manufacturing
        // recipes with no linked Product (see approveProduction) — the
        // recipe itself is still the batch's real, canonical product
        // reference. Every consumer of this endpoint (Batch Registry,
        // Expiry Tracking, Batch Recall) should resolve the same name
        // instead of independently guessing at a fallback.
        product: b.product || (b.production?.recipe ? { id: b.production.recipe.id, name: b.production.recipe.name, sku: b.production.recipe.recipeCode ?? null } : null),
        packedQuantity,
        bulkQuantity,
        availableQuantity,
        expiryStatus: !effectiveExpiry
          ? 'VALID' // Fallback (should be filtered out by DB query)
          : effectiveExpiry < now
          ? 'EXPIRED'
          : effectiveExpiry < soonThreshold
          ? 'EXPIRING_SOON'
          : 'VALID',
      };
    });

    // Also include GRN raw material / inventory batches that carry expiry
    // dates — genuine RAW_MATERIAL lots only. SEMI_FINISHED (QC-approved
    // bulk, awaiting Packaging) and FINISHED_GOOD (Confirm Packaging output)
    // InventoryBatch lots are real inventory records in their own right, but
    // they already belong to a ProductBatch row above — appending them here
    // too would show the same production batch twice under two different
    // formulas (see ProductionService.getProductBatches investigation).
    const inventoryBatches = await prisma.inventoryBatch.findMany({
      where: {
        expDate: { not: null },
        inventoryItem: {
          category: 'RAW_MATERIAL',
          ...(franchiseId ? { franchiseId } : {}),
        },
        ...(productId ? { inventoryItemId: productId } : {}),
      },
      include: {
        inventoryItem: {
          include: { franchise: true },
        },
        warehouse: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const mappedInventoryBatches = inventoryBatches.map(ib => {
      const effectiveExpiry = ib.expDate;
      return {
        id: ib.id,
        batchCode: ib.lotNumber || ib.batchNumber || `GRN-${ib.id.substring(0, 8).toUpperCase()}`,
        productId: ib.inventoryItemId,
        product: {
          id: ib.inventoryItem?.id,
          name: ib.inventoryItem?.name || 'Raw Material',
          sku: ib.inventoryItem?.sku,
        },
        franchise: ib.inventoryItem?.franchise || (ib.warehouse ? { name: ib.warehouse.name } : null),
        franchiseId: ib.inventoryItem?.franchiseId,
        quantity: ib.initialQty,
        approvedQty: ib.initialQty,
        bulkQuantity: ib.currentQty,
        packagedQty: 0,
        packedQuantity: 0,
        availableQuantity: ib.currentQty,
        mfgDate: ib.mfgDate || ib.createdAt,
        createdAt: ib.createdAt,
        expiryDate: ib.expDate,
        qcStatus: ib.status,
        unit: ib.inventoryItem?.unit || 'KG',
        batchType: 'GRN_RAW_MATERIAL',
        expiryStatus: !effectiveExpiry
          ? 'VALID'
          : effectiveExpiry < now
          ? 'EXPIRED'
          : effectiveExpiry < soonThreshold
          ? 'EXPIRING_SOON'
          : 'VALID',
      } as any;
    });

    return [...mappedProductBatches, ...mappedInventoryBatches].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  static async getPendingQCBatches(franchiseId?: string, startDate?: string, endDate?: string, qcStatus?: string) {
    const where: any = {};
    if (franchiseId) where.franchiseId = franchiseId;
    if (qcStatus) where.qcStatus = qcStatus;
    if (startDate || endDate) {
      const createdAtFilter: any = {};
      if (startDate) createdAtFilter.gte = new Date(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000`);
      if (endDate) createdAtFilter.lte = new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999`);
      where.createdAt = createdAtFilter;
    }
    return prisma.productBatch.findMany({
      where,
      include: { product: true, franchise: true, production: { include: { recipe: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getPackagings(franchiseId?: string) {
    const packagings = await prisma.productPackaging.findMany({
      where: franchiseId ? { batch: { franchiseId } } : {},
      include: { batch: { include: { product: true, production: { include: { recipe: { include: { product: true } } } } } } },
      orderBy: { createdAt: 'desc' },
    });

    // Same canonical product/recipe fallback as getProductBatches/
    // getAllProductBatches — batch.product is legitimately null for a
    // recipe with no linked Product, and Confirm Packaging (Awaiting
    // Confirmation + History) consumes this same list, so it was showing a
    // blank product name for any such batch.
    return packagings.map(p => {
      const linkedProduct = p.batch.product || p.batch.production?.recipe?.product || null;
      return {
        ...p,
        batch: {
          ...p.batch,
          product: linkedProduct || (p.batch.production?.recipe ? {
            id: null,
            name: p.batch.production.recipe.name,
            sku: p.batch.production.recipe.recipeCode ?? null,
            category: p.batch.production.recipe.category ?? 'FINISHED_GOOD',
          } : null),
        },
      };
    });
  }

  static async getAllProductBatches(franchiseId?: string) {
    const batches = await prisma.productBatch.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: {
        product: true,
        franchise: true,
        production: {
          include: {
            recipe: true,
            items: { include: { inventoryItem: true } },
            stageLogs: { orderBy: { enteredAt: 'asc' } },
          },
        },
        packagings: true,
        recall: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Same canonical product/recipe fallback as getProductBatches (Batch
    // Registry, Expiry Tracking, Batch Recall) — ProductBatch.product is
    // legitimately null for a recipe with no linked Product, and the recipe
    // itself is still the batch's real product identity. Packaging Queue
    // consumes this same list, so it was showing a blank product name for
    // any such batch instead of falling back like every other consumer does.
    return batches.map(b => ({
      ...b,
      product: b.product || (b.production?.recipe ? { id: b.production.recipe.id, name: b.production.recipe.name, sku: b.production.recipe.recipeCode ?? null } : null),
    }));
  }
}
