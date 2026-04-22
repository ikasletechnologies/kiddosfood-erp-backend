import prisma from '../../lib/prisma';

export class RecipeService {
  /**
   * Create or Update a Recipe for a Product
   */
  static async upsertRecipe(data: {
    productId: string,
    name: string,
    yieldQty: number,
    instructions: string,
    items: { inventoryItemId: string, quantityRequired: number, unit: string }[]
  }) {
    return prisma.$transaction(async (tx) => {
      // 1. Upsert the Recipe header
      const recipe = await tx.recipe.upsert({
        where: { productId: data.productId },
        update: {
          name: data.name,
          yieldQty: data.yieldQty,
          instructions: data.instructions,
        },
        create: {
          productId: data.productId,
          name: data.name,
          yieldQty: data.yieldQty,
          instructions: data.instructions,
        }
      });

      // 2. Clear old recipe items and add new ones
      await tx.recipeItem.deleteMany({ where: { recipeId: recipe.id } });
      await tx.recipeItem.createMany({
        data: data.items.map(item => ({
          recipeId: recipe.id,
          inventoryItemId: item.inventoryItemId,
          quantityRequired: item.quantityRequired,
          unit: item.unit
        }))
      });

      return tx.recipe.findUnique({
        where: { id: recipe.id },
        include: { recipeItems: { include: { inventoryItem: true } } }
      });
    });
  }

  static async getRecipes() {
    return prisma.recipe.findMany({
      include: { 
        product: true, 
        recipeItems: { include: { inventoryItem: true } } 
      }
    });
  }

  static async getRecipeById(id: string) {
    return prisma.recipe.findUnique({
      where: { id },
      include: { 
        product: true, 
        recipeItems: { include: { inventoryItem: true } } 
      }
    });
  }

  static async getRecipeByProduct(productId: string) {
    return prisma.recipe.findUnique({
      where: { productId },
      include: { 
        recipeItems: { include: { inventoryItem: true } } 
      }
    });
  }

  static async deleteRecipe(id: string) {
    return prisma.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { recipeId: id } });
      return tx.recipe.delete({ where: { id } });
    });
  }

  /**
   * Calculate Estimated Cost per Unit based on current inventory stock value (simple average or fixed)
   * Note: This is an estimation logic.
   */
  static async calculateCost(recipeId: string) {
    const recipe = await prisma.recipe.findUnique({
      where: { id: recipeId },
      include: { recipeItems: { include: { inventoryItem: true } } }
    });

    if (!recipe) throw new Error('Recipe not found');

    // Derive unit cost per ingredient from most recent PURCHASE_IN wastage cost records
    const ingredientIds = recipe.recipeItems.map(i => i.inventoryItemId);

    // Use wastage cost as a proxy for unit cost (cost / quantity = unit cost)
    const wastageCosts = await prisma.wastage.findMany({
      where: { inventoryItemId: { in: ingredientIds } },
      orderBy: { date: 'desc' }
    });

    // Build a map: inventoryItemId -> latest unit cost from wastage records
    const unitCostMap: Record<string, number> = {};
    for (const w of wastageCosts) {
      if (!unitCostMap[w.inventoryItemId] && w.quantity > 0) {
        unitCostMap[w.inventoryItemId] = w.cost / w.quantity;
      }
    }

    const breakdown: { name: string; qty: number; unit: string; unitCost: number; lineCost: number }[] = [];
    let totalCost = 0;

    for (const item of recipe.recipeItems) {
      const unitCost = unitCostMap[item.inventoryItemId] ?? 0;
      const lineCost = item.quantityRequired * unitCost;
      totalCost += lineCost;
      breakdown.push({
        name: item.inventoryItem.name,
        qty: item.quantityRequired,
        unit: item.unit,
        unitCost,
        lineCost
      });
    }

    return {
      recipeId,
      recipeName: recipe.name,
      yieldQty: recipe.yieldQty,
      totalCost,
      costPerYieldUnit: recipe.yieldQty > 0 ? totalCost / recipe.yieldQty : 0,
      breakdown
    };
  }
}
