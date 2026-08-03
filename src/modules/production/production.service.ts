import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProductionStatus } from '@prisma/client';

export class ProductionService {
  static async startProduction(data: {
    recipeId: string;
    quantity: number;
    franchiseId: string;
    customerId?: string;
    productionType: string;
    expiryDate?: string;
    userId?: string;
  }) {
    return prisma.$transaction(async tx => {
      // 1. Fetch recipe
      const recipe = await tx.recipe.findUnique({
        where: { id: data.recipeId },
        include: { recipeItems: { include: { inventoryItem: true } }, product: true },
      });
      if (!recipe) throw new Error('Recipe not found');

      // Calculate scalar based on batches (frontend sends number of batches/runs)
      // If recipe yield is 5 and we run it 2 times, scalar is 2.
      const scalar = data.quantity;

      // 2. Check ingredients
      for (const item of recipe.recipeItems) {
        const amountNeeded = item.quantityRequired * scalar;
        const inv = await tx.inventoryItem.findFirst({
          where: { id: item.inventoryItemId, franchiseId: data.franchiseId },
        });
        if (!inv || inv.currentStock < amountNeeded) {
          throw new Error(`Insufficient stock for "${inv?.name ?? 'ingredient'}"`);
        }
      }

      // 3. Create production record (IN_PROGRESS)
      const production = await tx.production.create({
        data: {
          recipeId: data.recipeId,
          quantity: data.quantity,
          franchiseId: data.franchiseId,
          customerId: data.customerId,
          productionType: data.productionType,
          status: 'IN_PROGRESS',
          startTime: new Date(),
          producedBy: data.userId,
          expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
          currentStage: 'QUEUED',
          stageUpdatedAt: new Date(),
        },
      });

      await tx.productionStageLog.create({
        data: { productionId: production.id, stage: 'QUEUED' },
      });

      // 4. Deduct raw materials
      for (const item of recipe.recipeItems) {
        const amountNeeded = item.quantityRequired * scalar;
        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PRODUCTION_OUT',
          quantity: -amountNeeded,
          referenceType: 'PRODUCTION',
          referenceId: production.id,
          note: `Production started: ${recipe.name}`,
          userId: data.userId,
        });

        await tx.productionItem.create({
          data: {
            productionId: production.id,
            inventoryItemId: item.inventoryItemId,
            usedQuantity: amountNeeded,
          },
        });
      }

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

  static async approveProduction(id: string, userId?: string, actualYield?: number) {
    return prisma.$transaction(async tx => {
      const production = await tx.production.findUnique({
        where: { id },
        include: { recipe: { include: { product: true, recipeItems: true } } },
      });

      if (!production || production.status !== 'STOPPED') {
        throw new Error('Production must be stopped before approval');
      }

      const recipe = production.recipe;
      if (!recipe || !recipe.productId) {
        throw new Error('Recipe or associated product not found');
      }
      const totalYield = actualYield !== undefined ? actualYield : (production.quantity * recipe.yieldQty);

      // Create ProductBatch with PENDING QC status (does NOT add stock to finished goods inventory yet)
      const batchCode = `BATCH-${production.id.substring(0, 8).toUpperCase()}`;
      await tx.productBatch.create({
        data: {
          productId: recipe.productId,
          productionId: production.id,
          quantity: totalYield,
          expiryDate: production.expiryDate,
          batchCode,
          franchiseId: production.franchiseId,
          qcStatus: "PENDING",
          approvedQty: 0,
          rejectionQty: 0,
          packagingStatus: "PENDING",
        },
      });

      // Finalize status and record actual yield
      return tx.production.update({
        where: { id },
        data: { 
          status: 'COMPLETED',
          actualYield: totalYield
        },
      });
    });
  }

  static async inspectBatch(data: {
    batchId: string;
    qcStatus: string;
    moistureCheck?: number;
    colorCheck?: string;
    textureCheck?: string;
    rejectionQty?: number;
    userId?: string;
  }) {
    return prisma.$transaction(async tx => {
      const batch = await tx.productBatch.findUnique({
        where: { id: data.batchId },
        include: { product: true, production: true },
      });
      if (!batch) throw new Error('Product batch not found');

      const rejection = data.rejectionQty || 0;
      const approvedQty = Math.max(0, batch.quantity - rejection);

      const updatedBatch = await tx.productBatch.update({
        where: { id: data.batchId },
        data: {
          qcStatus: data.qcStatus,
          moistureCheck: data.moistureCheck,
          colorCheck: data.colorCheck,
          textureCheck: data.textureCheck,
          rejectionQty: rejection,
          approvedQty: approvedQty,
        },
      });

      const needsTargetItem = (data.qcStatus === 'APPROVED' && approvedQty > 0) || rejection > 0;

      if (needsTargetItem) {
        const franchiseId = batch.franchiseId || batch.production?.franchiseId;
        if (!franchiseId) throw new Error('Franchise ID not found for batch');

        let targetItem = await tx.inventoryItem.findFirst({
          where: {
            franchiseId,
            OR: [
              { sku: batch.product.sku ?? undefined },
              { name: batch.product.name },
            ],
          },
        });

        if (!targetItem) {
          targetItem = await tx.inventoryItem.create({
            data: {
              name: batch.product.name,
              sku: batch.product?.sku || `PRD-${batch.productId.substring(0, 5).toUpperCase()}`,
              category: 'FINISHED_GOOD',
              currentStock: 0,
              unit: 'unit',
              minimumStock: 5,
              franchiseId,
            },
          });
        }

        if (data.qcStatus === 'APPROVED' && approvedQty > 0) {
          await InventoryService.recordMovement(tx, {
            itemId: targetItem.id,
            type: 'PRODUCTION_IN',
            quantity: approvedQty,
            referenceType: 'PRODUCTION',
            referenceId: batch.productionId || batch.id,
            note: `QC Approved batch: ${batch.batchCode} (${approvedQty} units approved after ${rejection} rejected)`,
            userId: data.userId,
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
              note: `QC rejected from batch ${batch.batchCode}`,
              costAtTime: rejection * (targetItem.costPrice || 0),
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
        include: { product: true, production: true },
      });
      if (!batch) throw new Error('Product batch not found');
      if (batch.qcStatus !== 'APPROVED') throw new Error('Batch must be QC APPROVED before packaging');

      const franchiseId = batch.franchiseId || batch.production?.franchiseId;
      if (!franchiseId) throw new Error('Franchise ID not found for batch');

      let bulkItem = await tx.inventoryItem.findFirst({
        where: {
          franchiseId,
          OR: [
            { sku: batch.product.sku ?? undefined },
            { name: batch.product.name },
          ],
        },
      });
      if (!bulkItem) throw new Error('Bulk inventory item not found');

      const unitMultiplier = this.parseWeight(data.packetSize, bulkItem.unit);
      const totalWeightNeeded = data.quantityPackets * unitMultiplier;

      if (bulkItem.currentStock < totalWeightNeeded) {
        throw new Error(`Insufficient bulk stock. Needed: ${totalWeightNeeded} ${bulkItem.unit}, Available: ${bulkItem.currentStock} ${bulkItem.unit}`);
      }

      // Cap against this batch's own QC-approved quantity — only approved
      // output ever became usable stock, so that's the real packaging ceiling
      // (not the raw batch.quantity, which includes anything QC rejected).
      const remainingInBatch = (batch.approvedQty || 0) - (batch.packagedQty || 0);
      if (totalWeightNeeded > remainingInBatch + 0.001) {
        throw new Error(`Cannot package more than the batch's remaining approved quantity (${remainingInBatch} ${bulkItem.unit} left).`);
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

      const retailSku = `${bulkItem.sku}-${data.packetSize.toUpperCase().replace(/\s+/g, '')}`;
      const retailName = `${bulkItem.name} (${data.packetSize})`;
      
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
    if (!match) return 1.0;
    const val = parseFloat(match[1]);
    const unit = match[3].toLowerCase();
    const bUnit = bulkUnit.toLowerCase();

    if (unit === bUnit) return val;

    if (bUnit === 'kg' && unit === 'g') return val / 1000;
    if (bUnit === 'g' && unit === 'kg') return val * 1000;
    if (bUnit === 'l' && unit === 'ml') return val / 1000;
    if (bUnit === 'ml' && unit === 'l') return val * 1000;

    return val;
  }


  static async getProductionHistory(franchiseId?: string) {
    return prisma.production.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: {
        recipe: { include: { product: true } },
        items: { include: { inventoryItem: true } },
        batches: true,
        customer: true,
      },
      orderBy: { producedAt: 'desc' },
    });
  }

  static async getBatchById(id: string) {
    return prisma.production.findUnique({
      where: { id },
      include: {
        recipe: { include: { product: true } },
        items: { include: { inventoryItem: true } },
        batches: true,
        customer: true,
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
      include: { product: true, franchise: true, production: { include: { recipe: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return batches.map(b => {
      const effectiveExpiry = b.expiryDate || b.production?.expiryDate;
      return {
        ...b,
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
      include: { product: true, franchise: true, production: { include: { recipe: true } }, packagings: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}
