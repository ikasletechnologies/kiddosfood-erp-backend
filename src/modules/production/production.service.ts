import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProductionStatus } from '@prisma/client';

export class ProductionService {
  static async startProduction(data: {
    recipeId: string;
    quantity: number;
    franchiseId: string;
    targetInventoryItemId?: string;
    productionType: string;
    expiryDate?: string; // ISO date string for batch expiry
    userId?: string;
  }) {
    return prisma.$transaction(async tx => {
      // 1. Fetch recipe with ingredients
      const recipe = await tx.recipe.findUnique({
        where: { id: data.recipeId },
        include: {
          recipeItems: { include: { inventoryItem: true } },
          product: true,
        },
      });
      if (!recipe) throw new Error('Recipe not found');

      const scalar = data.quantity / recipe.yieldQty;

      // 2. Check all ingredients BEFORE deducting
      for (const item of recipe.recipeItems) {
        const amountNeeded = item.quantityRequired * scalar;
        const inv = await tx.inventoryItem.findFirst({
          where: { id: item.inventoryItemId, franchiseId: data.franchiseId },
        });
        if (!inv || inv.currentStock < amountNeeded) {
          throw new Error(
            `Insufficient stock for "${inv?.name ?? 'ingredient'}". ` +
            `Required: ${amountNeeded.toFixed(2)} ${inv?.unit ?? ''}, ` +
            `Available: ${inv?.currentStock ?? 0}`
          );
        }
      }

      // 3. Resolve target inventory item (auto-create if not linked)
      let targetId = data.targetInventoryItemId;
      if (!targetId) {
        const matchingItem = await tx.inventoryItem.findFirst({
          where: {
            franchiseId: data.franchiseId,
            OR: [
              { sku: recipe.product.sku ?? undefined },
              { name: recipe.product.name },
            ],
          },
        });

        if (matchingItem) {
          targetId = matchingItem.id;
        } else {
          const newItem = await tx.inventoryItem.create({
            data: {
              name: recipe.product.name,
              sku: recipe.product.sku || `PRD-${recipe.product.id.substring(0, 5)}`,
              category: data.productionType as any,
              currentStock: 0,
              unit: 'unit',
              minimumStock: 5,
              franchiseId: data.franchiseId,
            },
          });
          targetId = newItem.id;
        }
      }

      // 4. Create production record
      const production = await tx.production.create({
        data: {
          recipeId: data.recipeId,
          quantity: data.quantity,
          franchiseId: data.franchiseId,
          productionType: data.productionType,
          status: 'COMPLETED',
          producedBy: data.userId,
        },
      });

      // 5. Deduct raw materials (StockMovement OUT)
      for (const item of recipe.recipeItems) {
        const amountNeeded = item.quantityRequired * scalar;

        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PRODUCTION_OUT',
          quantity: -amountNeeded,
          referenceType: 'PRODUCTION',
          referenceId: production.id,
          note: `Consumed in production: ${data.quantity} × ${recipe.name}`,
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

      // 6. Add finished goods (StockMovement IN)
      await InventoryService.recordMovement(tx, {
        itemId: targetId!,
        type: 'PRODUCTION_IN',
        quantity: data.quantity,
        referenceType: 'PRODUCTION',
        referenceId: production.id,
        note: `Produced via recipe: ${recipe.name}`,
        userId: data.userId,
      });

      // 7. Create ProductBatch — every production creates a trackable batch
      const expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
      await tx.productBatch.create({
        data: {
          productId: recipe.productId,
          productionId: production.id,
          quantity: data.quantity,
          expiryDate,
          batchCode: `BATCH-${production.id.substring(0, 8).toUpperCase()}`,
        },
      });

      return tx.production.findUnique({
        where: { id: production.id },
        include: {
          recipe: { include: { product: true } },
          items: { include: { inventoryItem: true } },
          batches: true,
        },
      });
    });
  }

  static async getProductionHistory(franchiseId: string) {
    return prisma.production.findMany({
      where: { franchiseId },
      include: {
        recipe: { include: { product: true } },
        items: { include: { inventoryItem: true } },
        batches: true,
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
      },
    });
  }

  static async updateStatus(id: string, status: ProductionStatus) {
    return prisma.production.update({ where: { id }, data: { status } });
  }

  // Get all product batches with expiry status
  static async getProductBatches(productId?: string) {
    const now = new Date();
    const soonThreshold = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days

    const batches = await prisma.productBatch.findMany({
      where: productId ? { productId } : {},
      include: { product: true, production: { include: { recipe: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return batches.map(b => ({
      ...b,
      expiryStatus: !b.expiryDate
        ? 'NO_EXPIRY'
        : b.expiryDate < now
        ? 'EXPIRED'
        : b.expiryDate < soonThreshold
        ? 'EXPIRING_SOON'
        : 'VALID',
    }));
  }
}
