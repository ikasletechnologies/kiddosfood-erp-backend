import prisma from '../../lib/prisma';
import { convertUnit } from '../../lib/conversion';

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
      // Validate items before saving to prevent DB constraint errors
      if (data.items && data.items.length > 0) {
        for (const item of data.items) {
          if (!item.inventoryItemId) {
            throw new Error("Cannot save recipe: One or more ingredients are missing a selected material.");
          }
          if (!item.quantityRequired || Number(item.quantityRequired) <= 0) {
            throw new Error("Cannot save recipe: One or more ingredients have an invalid quantity.");
          }
        }
      }

      let recipeId = data.id;

      // Recipe.productId is unique (one recipe per product) — check first
      // and name the conflicting recipe, rather than letting Postgres reject
      // the write and leaking a raw constraint-violation stack trace to the
      // client. Excludes the recipe being edited so re-saving it with the
      // same product it already has doesn't false-positive.
      if (data.productId) {
        const conflict = await tx.recipe.findFirst({
          where: { productId: data.productId, ...(recipeId ? { id: { not: recipeId } } : {}) },
          include: { product: true }
        });
        if (conflict) {
          const productName = conflict.product?.name || 'this product';
          throw new Error(`"${productName}" is already linked to recipe "${conflict.name}" — each product can only have one recipe. Unlink it there first, or choose a different product.`);
        }
      }

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
      // costPrice/basePrice are per item.inventoryItem.unit (e.g. per KG),
      // while quantityRequired is expressed in the recipe's own item.unit
      // (e.g. g) — convert before pricing, or a 500 g line prices out as if
      // it were 500 KG.
      const unitCost = item.inventoryItem.costPrice || item.inventoryItem.basePrice || 0;
      const qtyInStockUnit = convertUnit(item.quantityRequired, item.unit, item.inventoryItem.unit);
      const lineCost = qtyInStockUnit * unitCost;
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
