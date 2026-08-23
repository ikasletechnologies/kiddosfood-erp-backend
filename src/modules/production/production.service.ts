import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProductionStatus } from '@prisma/client';

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
  if (product) {
    const bulkSku = product.sku
      ? (product.sku.endsWith('-BULK') ? product.sku : `${product.sku}-BULK`)
      : `PRD-${product.id.substring(0, 5).toUpperCase()}-BULK`;
    const bulkName = product.name.endsWith(' - Bulk') ? product.name : `${product.name} - Bulk`;
    return { bulkSku, bulkName };
  }

  const baseCode = recipe?.recipeCode || recipe?.name || 'RECIPE';
  const bulkSku = baseCode.toUpperCase().endsWith('-BULK') ? baseCode.toUpperCase() : `${baseCode.toUpperCase()}-BULK`;
  const baseName = recipe?.name || baseCode;
  const bulkName = baseName.endsWith(' - Bulk') ? baseName : `${baseName} - Bulk`;
  return { bulkSku, bulkName };
}

export class ProductionService {
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
      let franchiseId = data.franchiseId;
      if (!franchiseId) {
        let fallbackFranchise = await tx.franchise.findFirst({ orderBy: { createdAt: 'asc' } });
        if (!fallbackFranchise) {
          // Genuinely none exist — this is internal bookkeeping the user
          // never sees or manages for production, so self-heal instead of
          // blocking the run on a setup step that shouldn't matter to them.
          fallbackFranchise = await tx.franchise.create({
            data: {
              name: 'Default',
              location: 'N/A',
              ownerName: 'N/A',
              contactNum: 'N/A',
              status: 'ACTIVE',
            },
          });
        }
        franchiseId = fallbackFranchise.id;
      }

      // Calculate scalar based on batches (frontend sends number of batches/runs)
      // If recipe yield is 5 and we run it 2 times, scalar is 2.
      const scalar = data.quantity;

      // 2. Check ingredients. Stock is a warehouse concept, not a franchise
      // one — when a warehouse is given, availability is checked against
      // what's actually in THAT warehouse (matching what Formula Scaling /
      // Production Planning show on screen), not the item's franchise-wide
      // total. franchiseId is only a fallback for callers that predate
      // warehouse selection.
      for (const item of recipe.recipeItems) {
        const amountNeeded = item.quantityRequired * scalar;
        if (data.warehouseId) {
          const available = await InventoryService.computeWarehouseStock(item.inventoryItemId, data.warehouseId, tx);
          if (available < amountNeeded) {
            throw new Error(`Insufficient stock for "${item.inventoryItem.name}" in the selected warehouse`);
          }
        } else {
          const inv = await tx.inventoryItem.findFirst({
            where: { id: item.inventoryItemId, franchiseId },
          });
          if (!inv || inv.currentStock < amountNeeded) {
            throw new Error(`Insufficient stock for "${inv?.name ?? 'ingredient'}"`);
          }
        }
      }

      // 3. Expiry is derived from the linked Product's configured shelf life
      // (Production Date + shelfLifeDays) — that's the single source of truth
      // so it stays correct as new products/shelf-life values are added, instead
      // of every caller having to compute and pass its own expiry. A caller-supplied
      // expiryDate or the DEFAULT_SHELF_LIFE_DAYS fallback only apply until the
      // product's shelf life gets configured. Computed once here and stored on the
      // Production row, so changing a product's shelf life later never rewrites the
      // expiry of batches already produced.
      const DEFAULT_SHELF_LIFE_DAYS = 7;
      const shelfLifeDays = recipe.product?.shelfLifeDays;
      const expiryDate = shelfLifeDays
        ? new Date(Date.now() + shelfLifeDays * 24 * 60 * 60 * 1000)
        : data.expiryDate
        ? new Date(data.expiryDate)
        : new Date(Date.now() + DEFAULT_SHELF_LIFE_DAYS * 24 * 60 * 60 * 1000);

      // 4. Create production record (IN_PROGRESS)
      const production = await tx.production.create({
        data: {
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
        const amountNeeded = item.quantityRequired * scalar;
        const { fifo } = await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PRODUCTION_OUT',
          quantity: -amountNeeded,
          referenceType: 'PRODUCTION',
          referenceId: production.id,
          note: `Production started: ${recipe.name}`,
          userId: data.userId,
          warehouseId: data.warehouseId,
        });

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

      await tx.production.update({
        where: { id: production.id },
        data: {
          materialCost,
          totalCost: materialCost + (production.laborCost || 0) + (production.overheadCost || 0),
        },
      });

      return production;
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

  static async approveProduction(id: string, userId?: string, actualYield?: number, remarks?: string) {
    return prisma.$transaction(async tx => {
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

      // Create ProductBatch with PENDING QC status. Deliberately does NOT
      // touch stock — finished-good stock is credited exactly once, at QC
      // acceptance (inspectBatch, guarded against re-inspection), never here.
      const batchCode = `BATCH-${production.id.substring(0, 8).toUpperCase()}`;
      await tx.productBatch.create({
        data: {
          productId: recipe.productId ?? null,
          productionId: production.id,
          quantity: totalYield,
          expiryDate: production.expiryDate,
          batchCode,
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
      return tx.production.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          actualYield: totalYield,
          endTime: new Date(),
          ...(remarks ? { remarks } : {}),
        },
      });
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
      // Enforced here, not just in the UI — accepted + rejected must equal
      // what was actually produced. Approved quantity is always derived from
      // that, never entered separately, so the two can't drift apart.
      if (rejection < 0 || rejection > batch.quantity) {
        throw new Error(`Rejected quantity must be between 0 and the produced quantity (${batch.quantity})`);
      }
      const approvedQty = Math.max(0, batch.quantity - rejection);
      // Status is derived from the actual split, not trusted from the
      // caller — a batch is only fully APPROVED when nothing was rejected,
      // only fully REJECTED when nothing was approved, otherwise it's a
      // genuine partial outcome.
      const qcStatus = rejection <= 0 ? 'APPROVED' : approvedQty <= 0 ? 'REJECTED' : 'PARTIALLY_APPROVED';

      const updatedBatch = await tx.productBatch.update({
        where: { id: data.batchId },
        data: {
          qcStatus,
          moistureCheck: data.moistureCheck,
          colorCheck: data.colorCheck,
          textureCheck: data.textureCheck,
          rejectionQty: rejection,
          approvedQty: approvedQty,
          qcRemarks: data.qcRemarks || null,
        },
      });

      const needsTargetItem = approvedQty > 0 || rejection > 0;

      if (needsTargetItem) {
        const franchiseId = batch.franchiseId || batch.production?.franchiseId;
        if (!franchiseId) throw new Error('Franchise ID not found for batch');

        // The finished-good's real unit is whatever the recipe yields it in
        // (e.g. "KG") — packageBatch's weight parser converts packet sizes
        // relative to this unit, so a generic placeholder here silently
        // broke that conversion (a "unit"-labeled bulk item can't be told
        // apart from grams/kilograms, producing wildly wrong stock math).
        const finishedGoodUnit = batch.production?.recipe?.yieldUnit || 'KG';

        const { bulkSku, bulkName } = resolveBulkIdentity(batch.product, batch.production?.recipe);

        let targetItem = await tx.inventoryItem.findFirst({
          where: {
            franchiseId,
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
              franchiseId,
            },
          });
        } else if (!RECOGNIZED_PACK_UNITS.includes(targetItem.unit.toLowerCase()) && RECOGNIZED_PACK_UNITS.includes(finishedGoodUnit.toLowerCase())) {
          targetItem = await tx.inventoryItem.update({
            where: { id: targetItem.id },
            data: { unit: finishedGoodUnit },
          });
        }

        if (approvedQty > 0) {
          // Carries the batch's real FIFO-derived material cost into a fresh
          // InventoryBatch for the finished good, so a later sale draws from
          // (and gets costed at) this batch's actual cost — not a generic
          // average — exactly like raw materials already do off GRN batches.
          await InventoryService.recordMovement(tx, {
            itemId: targetItem.id,
            type: 'PRODUCTION_IN',
            quantity: approvedQty,
            referenceType: 'PRODUCTION',
            referenceId: batch.productionId || batch.id,
            note: `QC Approved batch: ${batch.batchCode} (${approvedQty} units approved after ${rejection} rejected)`,
            userId: data.userId,
            warehouseId: batch.production?.warehouseId || undefined,
            receiveAtCost: {
              unitCost: batch.unitCost || 0,
              batchNumber: batch.batchCode || undefined,
              mfgDate: batch.mfgDate,
              expDate: batch.expiryDate,
              productBatchId: batch.id,
            },
          });
        }

        // Rejected quantity never entered inventory, so this is a WasteEntry
        // record only (for cost/traceability reporting) — not a stock movement,
        // since there's no stock to deduct. Previously the rejected quantity was
        // simply discarded with no trace at all.
        if (rejection > 0) {
          await tx.wasteEntry.create({
            data: {
              inventoryItemId: targetItem.id,
              franchiseId,
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

  static async packageBatch(data: {
    batchId: string;
    packetSize: string;
    quantityPackets: number;
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

      // Recall check — must be inside the transaction so the check and the
      // subsequent stock deduction are atomic. If a recall is initiated between
      // the pre-flight check and the actual deduction, the transaction will
      // re-read the recall row and reject here before any movement is written.
      const recall = await tx.batchRecall.findUnique({ where: { productBatchId: data.batchId } });
      if (recall?.status === 'IN_PROGRESS') {
        throw new Error('Packaging blocked — batch is under recall.');
      }

      const franchiseId = batch.franchiseId || batch.production?.franchiseId;
      if (!franchiseId) throw new Error('Franchise ID not found for batch');

      const { bulkSku, bulkName } = resolveBulkIdentity(batch.product, batch.production?.recipe);

      let bulkItem = await tx.inventoryItem.findFirst({
        where: {
          franchiseId,
          OR: [
            { sku: bulkSku },
            { name: bulkName },
          ],
        },
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

      const unitMultiplier = this.parseWeight(data.packetSize, bulkItem.unit);
      const totalWeightNeeded = data.quantityPackets * unitMultiplier;

      if (bulkItem.currentStock < totalWeightNeeded) {
        const shortage = totalWeightNeeded - bulkItem.currentStock;
        throw new Error(`Insufficient bulk stock. Required: ${totalWeightNeeded.toFixed(2)} ${bulkItem.unit}, Available: ${bulkItem.currentStock.toFixed(2)} ${bulkItem.unit}, Shortage: ${shortage.toFixed(2)} ${bulkItem.unit}`);
      }

      // Cap against this batch's own QC-approved quantity — only approved
      // output ever became usable stock, so that's the real packaging ceiling
      // (not the raw batch.quantity, which includes anything QC rejected).
      const remainingInBatch = (batch.approvedQty || 0) - (batch.packagedQty || 0);
      if (batch.packagingStatus === 'PACKAGED' || remainingInBatch <= 0.001) {
        throw new Error('This batch is already fully packaged.');
      }
      if (totalWeightNeeded > remainingInBatch + 0.001) {
        throw new Error(`Cannot package more than the batch's remaining approved quantity (${remainingInBatch.toFixed(2)} ${bulkItem.unit} left).`);
      }

      await InventoryService.recordMovement(tx, {
        itemId: bulkItem.id,
        type: 'PRODUCTION_OUT',
        quantity: -totalWeightNeeded,
        referenceType: 'PACKAGING',
        referenceId: batch.id,
        note: `Packaging conversion: Deducted bulk stock for ${data.quantityPackets} x ${data.packetSize} packs`,
        userId: data.userId,
      });

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
      const cleanBaseName = batch.product
        ? (baseName.replace(/\s+\d+(\.\d+)?\s*(kg|g|l|ml|pcs|units?)\.?$/i, '').trim() || baseName)
        : baseName;
      const cleanBaseSku = batch.product
        ? (stripTrailingSizeSegments(baseSku) || baseSku)
        : baseSku;

      const packetSizeMatch = data.packetSize.match(/^(\d+(\.\d+)?)\s*(g|kg|l|ml|pcs|unit)$/i);
      const formattedPacketSize = packetSizeMatch ? `${packetSizeMatch[1]} ${packetSizeMatch[3].toUpperCase()}` : data.packetSize;
      const cleanPacketSize = data.packetSize.toUpperCase().replace(/\s+/g, '');

      const retailSku = cleanBaseSku.includes(cleanPacketSize) ? cleanBaseSku : `${cleanBaseSku}-${cleanPacketSize}`;
      const retailName = cleanBaseName.toLowerCase().includes(formattedPacketSize.toLowerCase())
        ? cleanBaseName
        : `${cleanBaseName} ${formattedPacketSize}`;
      
      let retailItem = await tx.inventoryItem.findFirst({
        where: {
          franchiseId,
          sku: retailSku,
        },
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
            franchiseId,
            basePrice: bulkItem.basePrice ? bulkItem.basePrice * unitMultiplier : 0,
            costPrice: bulkItem.costPrice ? bulkItem.costPrice * unitMultiplier : 0,
          },
        });
      }

      await InventoryService.recordMovement(tx, {
        itemId: retailItem.id,
        type: 'PRODUCTION_IN',
        quantity: data.quantityPackets,
        referenceType: 'PACKAGING',
        referenceId: batch.id,
        note: `Packaging conversion: Created retail stock from batch ${batch.batchCode}`,
        userId: data.userId,
      });

      const barcode = `PKG-${batch.batchCode}-${data.packetSize.toUpperCase()}-${Date.now().toString().substring(8)}`;
      const packaging = await tx.productPackaging.create({
        data: {
          batchId: batch.id,
          packetSize: data.packetSize,
          quantityPackets: data.quantityPackets,
          totalWeight: totalWeightNeeded,
          barcode,
          printedLabels: true,
        },
      });

      // A batch can be packaged across multiple runs — only mark it fully
      // PACKAGED once the cumulative packaged weight covers the batch quantity,
      // otherwise it's PARTIALLY_PACKED (previously this was hardcoded to
      // PACKAGED on every single packaging run, even a partial one).
      const newPackagedQty = (batch.packagedQty || 0) + totalWeightNeeded;
      const newPackagingStatus = newPackagedQty >= (batch.approvedQty || 0) - 0.001 ? 'PACKAGED' : 'PARTIALLY_PACKED';

      await tx.productBatch.update({
        where: { id: batch.id },
        data: {
          packagingStatus: newPackagingStatus,
          packagedQty: newPackagedQty,
        },
      });

      return {
        packaging,
        retailItem,
        bulkItem,
      };
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
    const unit = match[3].toLowerCase();
    const bUnit = bulkUnit.toLowerCase();

    if (unit === bUnit) return val;

    if (bUnit === 'kg' && unit === 'g') return val / 1000;
    if (bUnit === 'g' && unit === 'kg') return val * 1000;
    if (bUnit === 'l' && unit === 'ml') return val / 1000;
    if (bUnit === 'ml' && unit === 'l') return val * 1000;

    // No known conversion between the packet's unit and the bulk item's
    // unit — returning val here would silently compare incompatible
    // quantities (e.g. grams against a bulk stock tracked in a stray
    // "units" label), producing a wrong-but-plausible shortage or surplus.
    throw new Error(`Cannot convert packet size "${size}" to bulk stock unit "${bulkUnit}" — the product's recipe yield unit must be KG, G, L, or ML.`);
  }


  static async getProductionHistory(franchiseId?: string) {
    return prisma.production.findMany({
      where: franchiseId ? { franchiseId } : {},
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
        // So the Batch Registry (and any other list consuming this
        // endpoint) can show IN_PROGRESS/COMPLETED/CANCELLED recall status
        // instead of only ever showing APPROVED/PENDING QC status.
        recall: { select: { status: true, step: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return batches.map(b => {
      const effectiveExpiry = b.expiryDate || b.production?.expiryDate;
      const packedQuantity = b.packagedQty || 0;
      const bulkQuantity = Math.max(0, (b.approvedQty || 0) - (b.packagedQty || 0));
      const availableQuantity = b.packagings?.reduce((sum, p) => sum + (p.quantityPackets || 0), 0) || 0;

      return {
        ...b,
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
  }

  static async getPendingQCBatches(franchiseId?: string) {
    return prisma.productBatch.findMany({
      where: {
        qcStatus: 'PENDING',
        ...(franchiseId ? { franchiseId } : {})
      },
      include: { product: true, franchise: true, production: { include: { recipe: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getPackagings(franchiseId?: string) {
    return prisma.productPackaging.findMany({
      where: franchiseId ? { batch: { franchiseId } } : {},
      include: { batch: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getAllProductBatches(franchiseId?: string) {
    return prisma.productBatch.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: {
        product: true,
        franchise: true,
        production: { include: { recipe: true } },
        packagings: true,
        recall: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
