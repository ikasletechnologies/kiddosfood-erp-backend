import prisma from '../../lib/prisma';
import { convertMeasurement, ValidUnit } from '@businessgroupikasle/erp-units';
import { FormulationService } from './formulation.service';

interface RecipeItemWithInventory {
  quantityRequired: number;
  unit: string;
  inventoryItem: {
    name: string;
    unit: string;
    costPrice?: number | null;
    basePrice?: number | null;
  };
}

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

      // Recipe.productId is unique (one recipe per product)
      // check first and name the conflicting recipe, rather than letting Postgres reject
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
        // when none was typed in, so codes can't collide or be mistyped.
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

      // Legacy (quantity-bearing) form: keep the ingredient list and the
      // formulation history in step with the BOM it just wrote.
      await RecipeService.syncIngredients(tx, recipeId!, Array.from(new Set(data.items.map(i => i.inventoryItemId))));
      if (data.items.length > 0) {
        await FormulationService.recordLegacyFormVersion(tx, recipeId!, {
          yieldQty: data.yieldQty,
          yieldUnit: data.yieldUnit || 'KG',
          items: data.items,
        });
      }

      return tx.recipe.findUnique({
        where: { id: recipeId },
        include: {
          recipeItems: { include: { inventoryItem: true } },
          _count: { select: { productions: true } }
        }
      });
    });
  }

  /**
   * Simplified Recipe Master save: name, category, instructions and the
   * selected raw materials only. Never touches quantities: the legacy BOM
   * (RecipeItem / yieldQty / yieldUnit) and formulation versions are only
   * written by FormulationService from real, user-entered values.
   */
  static async saveSimplifiedRecipe(data: {
    id?: string;
    name: string;
    category: string;
    instructions?: string;
    ingredientIds: string[];
    productId?: string | null;
    recipeCode?: string;
    estimatedDurationMinutes?: number | null;
  }) {
    const name = (data.name || '').trim();
    const category = (data.category || '').trim();
    if (!name) throw new Error('Recipe name is required.');
    if (!category) throw new Error('Category is required.');
    const ids = (data.ingredientIds || []).filter(Boolean);
    if (ids.length === 0) throw new Error('Select at least one ingredient.');
    if (new Set(ids).size !== ids.length) throw new Error('Each ingredient can only be selected once.');

    return prisma.$transaction(async (tx) => {
      const found = await tx.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true } });
      if (found.length !== ids.length) throw new Error('One or more selected ingredients no longer exist in the Raw Material Master.');

      if (data.productId) {
        const conflict = await tx.recipe.findFirst({
          where: { productId: data.productId, ...(data.id ? { id: { not: data.id } } : {}) },
          include: { product: true },
        });
        if (conflict) {
          throw new Error(`"${conflict.product?.name || 'this product'}" is already linked to recipe "${conflict.name}" — each product can only have one recipe.`);
        }
      }

      let recipeId = data.id;
      const common = {
        name,
        category,
        instructions: data.instructions ?? null,
        ...(data.productId !== undefined ? { productId: data.productId || null } : {}),
        ...(data.estimatedDurationMinutes !== undefined ? { estimatedDurationMinutes: data.estimatedDurationMinutes ?? null } : {}),
      };
      if (recipeId) {
        const exists = await tx.recipe.findUnique({ where: { id: recipeId }, select: { id: true } });
        if (!exists) throw new Error('Recipe not found');
        await tx.recipe.update({ where: { id: recipeId }, data: common });
      } else {
        const recipeCode = data.recipeCode || `RCP-${((await tx.recipe.count()) + 1).toString().padStart(4, '0')}`;
        // yieldQty/yieldUnit get their column defaults here; they carry no
        // meaning until a formulation is saved (which overwrites them), and
        // Production refuses a recipe with no BOM.
        const created = await tx.recipe.create({ data: { ...common, recipeCode } });
        recipeId = created.id;
      }

      await RecipeService.syncIngredients(tx, recipeId!, ids);
      return tx.recipe.findUnique({
        where: { id: recipeId },
        include: RecipeService.recipeInclude,
      });
    });
  }

  /** Replaces the recipe's ingredient selection, keeping order. */
  static async syncIngredients(tx: any, recipeId: string, inventoryItemIds: string[]) {
    await tx.recipeIngredient.deleteMany({ where: { recipeId, inventoryItemId: { notIn: inventoryItemIds } } });
    for (let i = 0; i < inventoryItemIds.length; i++) {
      await tx.recipeIngredient.upsert({
        where: { recipeId_inventoryItemId: { recipeId, inventoryItemId: inventoryItemIds[i] } },
        create: { recipeId, inventoryItemId: inventoryItemIds[i], sortOrder: i },
        update: { sortOrder: i },
      });
    }
  }

  static recipeInclude = {
    product: true,
    recipeItems: { include: { inventoryItem: true } },
    ingredients: { include: { inventoryItem: true }, orderBy: { sortOrder: 'asc' as const } },
    formulations: {
      where: { isActive: true },
      include: { items: { include: { inventoryItem: true }, orderBy: { sortOrder: 'asc' as const } } },
      take: 1,
    },
    _count: { select: { productions: true } },
  };

  /** Adds `activeFormulation` (or null) and drops the raw relation list. */
  private static withActiveFormulation<T extends { formulations?: any[] }>(recipe: T) {
    const { formulations, ...rest } = recipe as any;
    return { ...rest, activeFormulation: formulations?.[0] ?? null };
  }

  static async getRecipes() {
    const recipes = await prisma.recipe.findMany({
      orderBy: { createdAt: 'desc' },
      include: RecipeService.recipeInclude,
    });
    return recipes.map((recipe) => {
      const { totalCost, breakdown } = RecipeService.computeCostBreakdown(recipe.recipeItems);
      const productionCount = recipe._count?.productions || 0;
      return {
        ...RecipeService.withActiveFormulation(recipe),
        totalCost,
        costPerYieldUnit: recipe.yieldQty > 0 ? totalCost / recipe.yieldQty : 0,
        costBreakdown: breakdown,
        productionCount,
        isUsedInProduction: productionCount > 0,
      };
    });
  }

  static async getRecipeById(id: string) {
    const recipe = await prisma.recipe.findUnique({
      where: { id },
      include: RecipeService.recipeInclude,
    });
    if (!recipe) return null;
    const productionCount = recipe._count?.productions || 0;
    return {
      ...RecipeService.withActiveFormulation(recipe),
      productionCount,
      isUsedInProduction: productionCount > 0,
    };
  }

  static async getRecipeByProduct(productId: string) {
    const recipe = await prisma.recipe.findUnique({
      where: { productId },
      include: { 
        recipeItems: { include: { inventoryItem: true } },
        _count: {
          select: { productions: true }
        }
      }
    });
    if (!recipe) return null;
    const productionCount = recipe._count?.productions || 0;
    return {
      ...recipe,
      productionCount,
      isUsedInProduction: productionCount > 0,
    };
  }

  static async deleteRecipe(id: string) {
    const recipe = await prisma.recipe.findUnique({
      where: { id },
      include: {
        _count: {
          select: { productions: true }
        }
      }
    });

    if (!recipe) {
      const err: any = new Error('Recipe not found');
      err.status = 404;
      throw err;
    }

    const productionCount = recipe._count?.productions || 0;
    if (productionCount > 0) {
      const err: any = new Error('This recipe cannot be deleted because it is already used in production.');
      err.status = 400;
      throw err;
    }

    return prisma.$transaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { recipeId: id } });
      await tx.recipeIngredient.deleteMany({ where: { recipeId: id } });
      await tx.recipeFormulation.deleteMany({ where: { recipeId: id } });
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

    const { totalCost, breakdown } = RecipeService.computeCostBreakdown(recipe.recipeItems);

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

  static computeCostBreakdown(recipeItems: RecipeItemWithInventory[]) {
    const breakdown: { name: string; qty: number; unit: string; unitCost: number; lineCost: number }[] = [];
    let totalCost = 0;

    for (const item of recipeItems) {
      const unitCost = item.inventoryItem.costPrice || item.inventoryItem.basePrice || 0;
      let qtyInStockUnit;
      try {
        qtyInStockUnit = convertMeasurement(
          item.quantityRequired,
          item.unit.toUpperCase() as ValidUnit,
          item.inventoryItem.unit.toUpperCase() as ValidUnit
        ).toNumber();
      } catch {
        qtyInStockUnit = item.quantityRequired;
      }
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

    return { totalCost, breakdown };
  }

  static async getCategories() {
    return prisma.recipeCategory.findMany({ orderBy: { name: 'asc' } });
  }

  static async createCategory(name: string) {
    return prisma.recipeCategory.create({ data: { name } });
  }
}
