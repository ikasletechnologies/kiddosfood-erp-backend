import prisma from '../../lib/prisma';
import { convertMeasurement, ValidUnit } from '@businessgroupikasle/erp-units';
import { FormulationService } from './formulation.service';
import { ProductionCostingService } from '../production/production-costing.service';
import { normalizeRecipeExpenses, readRecipeExpenses, sameRecipeExpenses, RecipeExpenseItem, ExpenseCategory } from '../production/production-costing';

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
   * Confirms packaged Finished Goods as variants of one bulk recipe.
   * Existing links are never moved: a conflict must be reviewed explicitly.
   */
  static async linkProducts(recipeId: string, productIds: string[], userId?: string) {
    const ids = Array.from(new Set((productIds || []).filter(Boolean)));
    if (!ids.length) throw new Error('Select at least one Finished Good variant.');
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Recipe" WHERE id = ${recipeId} FOR UPDATE`;
      const recipe = await tx.recipe.findUnique({ where: { id: recipeId }, select: { id: true, productId: true } });
      if (!recipe) throw new Error('Recipe not found.');
      const products = await tx.product.findMany({ where: { id: { in: ids }, isActive: true, productType: 'FINISHED_GOOD' }, select: { id: true, name: true } });
      if (products.length !== ids.length) throw new Error('One or more selected variants are not active Finished Goods.');
      const conflicts = await tx.recipeProduct.findMany({ where: { productId: { in: ids }, recipeId: { not: recipeId } }, include: { product: true, recipe: true } });
      if (conflicts.length) throw new Error(`Variant "${conflicts[0].product.name}" is already linked to recipe "${conflicts[0].recipe.name}".`);
      await tx.recipeProduct.createMany({
        data: ids.filter((id) => id !== recipe.productId).map((productId) => ({ recipeId, productId, createdBy: userId || null })),
        skipDuplicates: true,
      });
      return tx.recipeProduct.findMany({ where: { recipeId }, include: { product: true } });
    });
  }
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
    // A new recipe starts with the default Additional Expenses (as in Recipe Master).
    const expenseCategories = data.id ? null : await ProductionCostingService.getExpenseCategories();
    const defaultExpenses = expenseCategories ? await ProductionCostingService.getDefaultRecipeExpenses(expenseCategories) : null;
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
        // Next free RCP-nnnn: the count alone can land on a code still in use
        // once a recipe has been removed (same rule as the Word import).
        let recipeCode = data.recipeCode;
        if (!recipeCode) {
          let n = (await tx.recipe.count()) + 1;
          recipeCode = `RCP-${String(n).padStart(4, '0')}`;
          while (await tx.recipe.findUnique({ where: { recipeCode }, select: { id: true } })) recipeCode = `RCP-${String(++n).padStart(4, '0')}`;
        }

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
        if (defaultExpenses && expenseCategories) await RecipeService.saveExpenseConfig(tx, recipe.id, defaultExpenses, expenseCategories);
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
    // Additional Expenses. Omitted = leave the saved configuration as it is
    // (a new recipe then gets the default expenses).
    additionalExpenses?: unknown;
  }, userId?: string) {
    const name = (data.name || '').trim();
    const category = (data.category || '').trim();
    if (!name) throw new Error('Recipe name is required.');
    if (!category) throw new Error('Category is required.');
    const ids = (data.ingredientIds || []).filter(Boolean);
    if (ids.length === 0) throw new Error('Select at least one ingredient.');
    if (new Set(ids).size !== ids.length) throw new Error('Each ingredient can only be selected once.');
    const categories = await ProductionCostingService.getExpenseCategories();
    // A new recipe saved without an expense list starts with the defaults
    // (₹5/packet), persisted like any other configuration.
    const expenses = data.additionalExpenses !== undefined
      ? normalizeRecipeExpenses(data.additionalExpenses, categories)
      : !data.id ? await ProductionCostingService.getDefaultRecipeExpenses(categories) : undefined;

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
        // Next free RCP-nnnn: the count alone can land on a code still in use
        // once a recipe has been removed (same rule as the Word import).
        let recipeCode = data.recipeCode;
        if (!recipeCode) {
          let n = (await tx.recipe.count()) + 1;
          recipeCode = `RCP-${String(n).padStart(4, '0')}`;
          while (await tx.recipe.findUnique({ where: { recipeCode }, select: { id: true } })) recipeCode = `RCP-${String(++n).padStart(4, '0')}`;
        }
        // yieldQty/yieldUnit get their column defaults here; they carry no
        // meaning until a formulation is saved (which overwrites them), and
        // Production refuses a recipe with no BOM.
        const created = await tx.recipe.create({ data: { ...common, recipeCode } });
        recipeId = created.id;
      }

      await RecipeService.syncIngredients(tx, recipeId!, ids);
      if (expenses) await RecipeService.saveExpenseConfig(tx, recipeId!, expenses, categories, userId);
      const saved = await tx.recipe.findUnique({
        where: { id: recipeId },
        include: RecipeService.recipeInclude,
      });
      return saved ? { ...saved, additionalExpenses: readRecipeExpenses(saved.expenseConfig, categories) } : saved;
    });
  }

  /**
   * Stores a changed Additional Expenses configuration: bumps its version
   * and records old/new in the audit log. Runs already started keep their
   * own snapshot (Production.expenseSnapshot), so their cost never changes.
   */
  static async saveExpenseConfig(tx: any, recipeId: string, next: RecipeExpenseItem[], categories: ExpenseCategory[], userId?: string) {
    await tx.$queryRaw`SELECT id FROM "Recipe" WHERE id = ${recipeId} FOR UPDATE`;
    const current = await tx.recipe.findUnique({ where: { id: recipeId }, select: { expenseConfig: true, expenseConfigVersion: true } });
    const previous = readRecipeExpenses(current?.expenseConfig ?? null, categories);
    if (sameRecipeExpenses(previous, next)) return;
    const version = (current?.expenseConfigVersion ?? 0) + 1;
    await tx.recipe.update({ where: { id: recipeId }, data: { expenseConfig: next as any, expenseConfigVersion: version } });
    await tx.auditLog.create({
      data: {
        module: 'RECIPE',
        action: 'EXPENSE_CONFIG_UPDATE',
        recordId: recipeId,
        oldValue: { version: current?.expenseConfigVersion ?? 0, expenses: current?.expenseConfig ?? null } as any,
        newValue: { version, expenses: next } as any,
        performedBy: userId || 'SYSTEM',
      },
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
    // Finished-goods variants made from this recipe (read-only here).
    productLinks: { include: { product: { select: { id: true, name: true, sku: true, basePrice: true, isActive: true } } } },
    // formulations: Word-imported versions (any, active or not), so Recipe
    // Master can tell an imported recipe from a manually created one.
    _count: { select: { productions: true, formulations: { where: { source: 'IMPORT' } } } },
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
    const categories = await ProductionCostingService.getExpenseCategories();
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
        isImported: (recipe._count?.formulations || 0) > 0,
        additionalExpenses: readRecipeExpenses(recipe.expenseConfig, categories),
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
      additionalExpenses: readRecipeExpenses(recipe.expenseConfig, await ProductionCostingService.getExpenseCategories()),
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
    const clean = String(name || '').trim();
    if (!clean) throw new Error('Category name is required.');
    return prisma.$transaction(async (tx) => {
      // Serialize category creation so differently-cased concurrent retries
      // cannot both pass the case-insensitive existence check.
      await tx.$executeRaw`LOCK TABLE "RecipeCategory" IN SHARE ROW EXCLUSIVE MODE`;
      const existing = await tx.recipeCategory.findFirst({ where: { name: { equals: clean, mode: 'insensitive' } } });
      if (existing) throw new Error(`Recipe category "${existing.name}" already exists.`);
      return tx.recipeCategory.create({ data: { name: clean } });
    });
  }
}
