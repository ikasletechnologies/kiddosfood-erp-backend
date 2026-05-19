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
        },
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

  static async approveProduction(id: string, userId?: string, actualYield?: number) {
    return prisma.$transaction(async tx => {
      const production = await tx.production.findUnique({
        where: { id },
        include: { recipe: { include: { product: true, recipeItems: true } } },
      });

      if (!production || production.status !== 'STOPPED') {
        throw new Error('Production must be stopped before approval');
      }

      // 1. Resolve target inventory item
      const recipe = production.recipe;
      let targetItem = await tx.inventoryItem.findFirst({
        where: {
          franchiseId: production.franchiseId,
          OR: [
            { sku: recipe.product.sku ?? undefined },
            { name: recipe.product.name },
          ],
        },
      });

      if (!targetItem) {
        targetItem = await tx.inventoryItem.create({
          data: {
            name: recipe.product.name,
            sku: recipe.product?.sku || `PRD-${(recipe.product?.id || Math.random().toString()).substring(0, 5).toUpperCase()}`,
            category: 'FINISHED_GOOD', // Explicitly mark as finished good for inventory visibility
            currentStock: 0,
            unit: recipe.recipeItems[0]?.unit || 'unit', // Fallback to first ingredient unit or 'unit'
            minimumStock: 5,
            franchiseId: production.franchiseId,
          },
        });
      }

      // 2. Add finished goods (Total Yield = Runs * Yield per run, unless actualYield is provided)
      const totalYield = actualYield !== undefined ? actualYield : (production.quantity * recipe.yieldQty);
      await InventoryService.recordMovement(tx, {
        itemId: targetItem.id,
        type: 'PRODUCTION_IN',
        quantity: totalYield,
        referenceType: 'PRODUCTION',
        referenceId: production.id,
        note: `Approved production: ${recipe.name} (${production.quantity} batches x ${recipe.yieldQty} yield)`,
        userId,
      });

      // 3. Create ProductBatch (Actual quantity produced)
      await tx.productBatch.create({
        data: {
          productId: recipe.productId,
          productionId: production.id,
          quantity: totalYield,
          expiryDate: production.expiryDate,
          batchCode: `BATCH-${production.id.substring(0, 8).toUpperCase()}`,
        },
      });

      // 4. Finalize status and record actual yield
      return tx.production.update({
        where: { id },
        data: { 
          status: 'COMPLETED',
          actualYield: totalYield
        },
      });
    });
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
}
