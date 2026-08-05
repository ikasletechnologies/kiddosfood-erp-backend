import prisma from '../../lib/prisma';

export class RecipeService {
  /**
   * Create or Update a Recipe for a Product
   */
  static async upsertRecipe(data: {
    id?: string,
    productId?: string,
    recipeCode?: string,
    category?: string,
    name: string,
    yieldQty: number,
    yieldUnit?: string,
    instructions: string,
    estimatedDurationMinutes?: number | null,
    items: { inventoryItemId: string, quantityRequired: number, unit: string }[]
  }) {
    return prisma.$transaction(async (tx) => {
      let recipeId = data.id;

      if (recipeId) {
        await tx.recipe.update({
          where: { id: recipeId },
          data: {
            productId: data.productId || null,
            recipeCode: data.recipeCode || null,
            category: data.category || null,
            name: data.name,
            yieldQty: data.yieldQty,
            yieldUnit: data.yieldUnit || "KG",
            instructions: data.instructions,
            estimatedDurationMinutes: data.estimatedDurationMinutes ?? null,
          }
        });
      } else {
        // Auto-generate a unique, sequential recipe code (RCP-0001, RCP-0002, ...)
        // when none was typed in, so codes can't collide or be mistyped. Typing
        // a code manually still wins — this only fills the gap when left blank.
        const recipeCode = data.recipeCode || `RCP-${((await tx.recipe.count()) + 1).toString().padStart(4, '0')}`;

        const recipe = await tx.recipe.create({
          data: {
            productId: data.productId || null,
            recipeCode,
            category: data.category || null,
            name: data.name,
            yieldQty: data.yieldQty,
            yieldUnit: data.yieldUnit || "KG",
            instructions: data.instructions,
            estimatedDurationMinutes: data.estimatedDurationMinutes ?? null,
          }
        });
        recipeId = recipe.id;
      }

      // 2. Clear old recipe items and add new ones
      await tx.recipeItem.deleteMany({ where: { recipeId: recipeId } });
      await tx.recipeItem.createMany({
        data: data.items.map(item => ({
          recipeId: recipeId!,
          inventoryItemId: item.inventoryItemId,
          quantityRequired: item.quantityRequired,
          unit: item.unit
        }))
      });

      return tx.recipe.findUnique({
        where: { id: recipeId },
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

    // Derive unit cost per ingredient (Wastage logic removed as Wastage model was deleted)
    const unitCostMap: Record<string, number> = {};

    const breakdown: { name: string; qty: number; unit: string; unitCost: number; lineCost: number }[] = [];
    let totalCost = 0;

    for (const item of recipe.recipeItems) {
      const unitCost = item.inventoryItem.costPrice || item.inventoryItem.basePrice || 0;
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
      yieldUnit: recipe.yieldUnit,
      totalCost,
      costPerYieldUnit: recipe.yieldQty > 0 ? totalCost / recipe.yieldQty : 0,
      breakdown
    };
  }

  static async getCategories() {
    return prisma.recipeCategory.findMany({ orderBy: { name: 'asc' } });
  }

  static async createCategory(name: string) {
    return prisma.recipeCategory.create({ data: { name } });
  }
}
