import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProductionStatus } from '@prisma/client';

export class ProductionService {
  /**
   * Main Production Batch Logic
   * 1. Load Recipe
   * 2. Deduct Ingredients from Inventory (PRODUCTION_OUT)
   * 3. Add Produced Item to Inventory (PRODUCTION_IN)
   */
  static async startProduction(data: {
    recipeId: string,
    quantity: number,
    franchiseId: string,
    targetInventoryItemId: string, // The semi-finished/finished item being produced
    productionType: string, // SEMI_FINISHED or FINISHED_GOOD
    userId?: string
  }) {
    return prisma.$transaction(async (tx) => {
      // 1. Fetch Recipe & Items
      const recipe = await tx.recipe.findUnique({
        where: { id: data.recipeId },
        include: { recipeItems: { include: { inventoryItem: true } } }
      });

      if (!recipe) throw new Error('Recipe not found');

      // 2. Calculate and Validate Raw Materials
      // recipe.yieldQty produces 'yieldQty' units. 
      // scalar = quantity / yieldQty
      const scalar = data.quantity / recipe.yieldQty;

      // 3. Create Production Header
      const production = await tx.production.create({
        data: {
          recipeId: data.recipeId,
          quantity: data.quantity,
          franchiseId: data.franchiseId,
          productionType: data.productionType,
          status: 'COMPLETED', // Or PENDING if using workflows
          producedBy: data.userId
        }
      });

      // 4. Process Ingredients
      for (const item of recipe.recipeItems) {
        const amountNeeded = item.quantityRequired * scalar;

        // Check if enough stock exists in this franchise
        const inventory = await tx.inventoryItem.findFirst({
          where: { id: item.inventoryItemId, franchiseId: data.franchiseId }
        });

        if (!inventory || inventory.currentStock < amountNeeded) {
          throw new Error(`Insufficient stock for ${inventory?.name || 'ingredient'}. Needed: ${amountNeeded}, Available: ${inventory?.currentStock || 0}`);
        }

        // 4.1 Deduct Material
        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PRODUCTION_OUT',
          quantity: -amountNeeded,
          referenceType: 'PRODUCTION',
          referenceId: production.id,
          note: `Used in production of ${data.quantity} units of ${recipe.name}`,
          userId: data.userId
        });

        // 4.2 Record in ProductionItem
        await tx.productionItem.create({
          data: {
            productionId: production.id,
            inventoryItemId: item.inventoryItemId,
            usedQuantity: amountNeeded
          }
        });
      }

      // 5. Add Produced Item to Inventory
      await InventoryService.recordMovement(tx, {
        itemId: data.targetInventoryItemId,
        type: 'PRODUCTION_IN',
        quantity: data.quantity,
        referenceType: 'PRODUCTION',
        referenceId: production.id,
        note: `Produced batch using recipe: ${recipe.name}`,
        userId: data.userId
      });

      return production;
    });
  }

  static async getProductionHistory(franchiseId: string) {
    return prisma.production.findMany({
      where: { franchiseId },
      include: { 
        recipe: true, 
        items: { include: { inventoryItem: true } } 
      },
      orderBy: { producedAt: 'desc' }
    });
  }

  static async getBatchById(id: string) {
    return prisma.production.findUnique({
      where: { id },
      include: { recipe: true, items: { include: { inventoryItem: true } } }
    });
  }

  static async updateStatus(id: string, status: ProductionStatus) {
    return prisma.production.update({
      where: { id },
      data: { status }
    });
  }
}
