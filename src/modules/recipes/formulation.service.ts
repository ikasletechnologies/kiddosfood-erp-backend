import { Prisma } from '@prisma/client';
import { UNITS, convertMeasurement, ValidUnit } from '@businessgroupikasle/erp-units';
import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProductionCostingService } from '../production/production-costing.service';
import { computeManufacturingExpenses, isPackagingCategory, readRecipeExpenses } from '../production/production-costing';
import { REQUIREMENT_ROUNDING_POLICY, roundRequirement } from '../production/requirement-rounding';

/**
 * Reference formulations for recipes (Recipe Master holds only WHICH
 * ingredients; a formulation says HOW MUCH of each makes a reference yield).
 *
 * Compatibility contract: the active formulation is mirrored into the legacy
 * Recipe.yieldQty / yieldUnit and RecipeItem rows. Every existing consumer
 * (ProductionService.startProduction/approve, POS made-to-order, franchise
 * order planning, finance costing, dashboard) keeps reading those fields
 * unchanged and gets the real saved values — never a default.
 */

// Quantities are carried at 6 dp; display layers round further.
const QTY_DP = 6;
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;
type DecimalValue = number | string | Prisma.Decimal;
const round = (d: DecimalValue) => new Decimal(d).toDecimalPlaces(QTY_DP).toNumber();

export interface FormulationInput {
  yieldQty: number;
  yieldUnit: string;
  notes?: string;
  items: Array<{ inventoryItemId: string; quantity: number; unit: string }>;
}

export interface ScaledLine {
  inventoryItemId: string;
  name: string;
  referenceQty: number;
  unit: string;
  /** Scaled exactly from the reference, before the rounding policy. */
  calculatedQty: number;
  /** What the run consumes: calculatedQty under REQUIREMENT_ROUNDING_POLICY. */
  requiredQty: number;
  stockUnit: string;
  requiredInStockUnit: number;
}

export class FormulationError extends Error {
  status = 400;
}

export function normalizeUnit(unit: string | null | undefined): ValidUnit {
  const u = String(unit || '').trim().toUpperCase();
  if (!(u in UNITS)) throw new FormulationError(`Unsupported unit "${unit}". Use one of: ${Object.keys(UNITS).join(', ')}.`);
  return u as ValidUnit;
}

/** Converts between units of the same dimension (g↔kg, ml↔L); throws otherwise. */
export function convertQty(qty: DecimalValue, from: string, to: string): Decimal {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (f === t) return new Decimal(qty);
  try {
    return new Decimal(convertMeasurement(new Decimal(qty).toString(), f, t).toString());
  } catch (e: any) {
    throw new FormulationError(`Cannot convert ${from} to ${to}: ${e.message}`);
  }
}

export class FormulationService {
  static async getVersions(recipeId: string) {
    return prisma.recipeFormulation.findMany({
      where: { recipeId },
      include: { items: { include: { inventoryItem: { select: { id: true, name: true, sku: true, unit: true } } }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { version: 'desc' },
    });
  }

  static async getActive(tx: any, recipeId: string) {
    return tx.recipeFormulation.findFirst({
      where: { recipeId, isActive: true },
      include: { items: { include: { inventoryItem: true }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * Saves a new active version (authorised users only — route-level) after
   * full validation, deactivates the previous one, and mirrors it into the
   * legacy BOM fields. Previous versions and every production snapshot that
   * referenced them are kept untouched.
   */
  static async saveVersion(recipeId: string, input: FormulationInput, userId?: string) {
    return prisma.$transaction(tx => this.saveVersionInTransaction(tx, recipeId, input, userId));
  }

  static async saveVersionInTransaction(tx: Prisma.TransactionClient, recipeId: string, input: FormulationInput, userId?: string, source: 'PLANNING' | 'RECIPE_FORM' = 'PLANNING') {
      await tx.$queryRaw`SELECT id FROM "Recipe" WHERE id = ${recipeId} FOR UPDATE`;
      const recipe = await tx.recipe.findUnique({
        where: { id: recipeId },
        include: { ingredients: true, _count: { select: { productions: true } } },
      });
      if (!recipe) throw new FormulationError('Recipe not found');

      const yieldUnit = normalizeUnit(input.yieldUnit);
      const yieldQty = Number(input.yieldQty);
      if (!Number.isFinite(yieldQty) || yieldQty <= 0) throw new FormulationError('Reference yield must be greater than zero.');

      // Batches, packaging and recall read the finished unit from
      // Recipe.yieldUnit, so it can't change once the recipe has been produced.
      if (recipe._count.productions > 0 && normalizeUnit(recipe.yieldUnit) !== yieldUnit) {
        throw new FormulationError(`This recipe has already been produced in ${recipe.yieldUnit}; the reference yield unit must stay ${recipe.yieldUnit}.`);
      }

      const ingredientIds = new Set(recipe.ingredients.map((i) => i.inventoryItemId));
      if (ingredientIds.size === 0) throw new FormulationError('Add ingredients to the recipe in Recipe Master first.');

      const items = Array.isArray(input.items) ? input.items : [];
      const seen = new Set<string>();
      const materials = await tx.inventoryItem.findMany({
        where: { id: { in: items.map((i) => i.inventoryItemId) } },
        select: { id: true, name: true, unit: true },
      });
      const materialById = new Map(materials.map((m) => [m.id, m]));

      const clean = items.map((item, idx) => {
        const material = materialById.get(item.inventoryItemId);
        if (!material) throw new FormulationError(`Ingredient #${idx + 1} is not a known raw material.`);
        if (!ingredientIds.has(item.inventoryItemId)) throw new FormulationError(`"${material.name}" is not an ingredient of this recipe.`);
        if (seen.has(item.inventoryItemId)) throw new FormulationError(`"${material.name}" appears more than once.`);
        seen.add(item.inventoryItemId);
        const quantity = Number(item.quantity);
        if (!Number.isFinite(quantity) || quantity < 0) throw new FormulationError(`Enter a valid quantity (0 or more) for "${material.name}".`);
        const unit = normalizeUnit(item.unit);
        // Must be convertible to the unit the material is stocked in, or
        // Production could never deduct it (e.g. PCS vs KG).
        try {
          convertQty(1, unit, material.unit);
        } catch {
          throw new FormulationError(`"${material.name}" is stocked in ${material.unit}; ${unit} can't be converted to it. Use a ${material.unit}-compatible unit.`);
        }
        return { inventoryItemId: item.inventoryItemId, quantity, unit, sortOrder: idx };
      });

      const missing = recipe.ingredients.filter((i) => !seen.has(i.inventoryItemId));
      if (missing.length > 0) {
        const names = await tx.inventoryItem.findMany({ where: { id: { in: missing.map((m) => m.inventoryItemId) } }, select: { name: true } });
        throw new FormulationError(`Enter a quantity for every ingredient. Missing: ${names.map((n) => n.name).join(', ')}.`);
      }
      if (!clean.some((i) => i.quantity > 0)) throw new FormulationError('At least one ingredient must have a quantity greater than zero.');

      const last = await tx.recipeFormulation.findFirst({ where: { recipeId }, orderBy: { version: 'desc' }, select: { version: true } });
      // An imported formulation's output stage, unresolved ("As Required")
      // lines and source ingredient names carry over when it is re-saved here.
      const previous = await tx.recipeFormulation.findFirst({
        where: { recipeId, isActive: true },
        select: { notes: true, outputStage: true, unresolvedItems: true, items: { select: { inventoryItemId: true, sourceName: true, sourceText: true } } },
      });
      if (source === 'RECIPE_FORM') {
        const active = await this.getActive(tx, recipeId);
        if (active && active.yieldQty === yieldQty && active.yieldUnit === yieldUnit && active.items.length === clean.length && clean.every(c => active.items.some((i: any) => i.inventoryItemId === c.inventoryItemId && i.quantity === c.quantity && i.unit === c.unit && i.sortOrder === c.sortOrder))) return active;
      }
      await tx.recipeFormulation.updateMany({ where: { recipeId, isActive: true }, data: { isActive: false } });
      const created = await tx.recipeFormulation.create({
        data: {
          recipeId,
          version: (last?.version || 0) + 1,
          yieldQty,
          yieldUnit,
          notes: input.notes === undefined && source === 'RECIPE_FORM' ? previous?.notes ?? null : input.notes?.trim() || null,
          source,
          isActive: true,
          createdBy: userId || null,
          outputStage: previous?.outputStage ?? null,
          unresolvedItems: previous?.unresolvedItems ?? undefined,
          items: {
            create: clean.map((c) => {
              const src = previous?.items.find((p) => p.inventoryItemId === c.inventoryItemId);
              return { ...c, sourceName: src?.sourceName ?? null, sourceText: src?.sourceText ?? null };
            }),
          },
        },
        include: { items: { include: { inventoryItem: true }, orderBy: { sortOrder: 'asc' } } },
      });

      await this.mirrorToLegacyBom(tx, recipeId, created);
      return created;
  }

  /** Writes the active formulation into Recipe.yieldQty/yieldUnit + RecipeItem. */
  static async mirrorToLegacyBom(tx: any, recipeId: string, f: { yieldQty: number; yieldUnit: string; items: Array<{ inventoryItemId: string; quantity: number; unit: string }> }) {
    await tx.recipe.update({ where: { id: recipeId }, data: { yieldQty: f.yieldQty, yieldUnit: f.yieldUnit } });
    await tx.recipeItem.deleteMany({ where: { recipeId } });
    await tx.recipeItem.createMany({
      data: f.items.map((i) => ({ recipeId, inventoryItemId: i.inventoryItemId, quantityRequired: i.quantity, unit: i.unit })),
    });
  }

  /** Records a version as-is (no strict validation, no mirror) for the legacy recipe form path. */
  static async recordLegacyFormVersion(tx: any, recipeId: string, f: { yieldQty: number; yieldUnit: string; items: Array<{ inventoryItemId: string; quantityRequired: number; unit: string }> }) {
    const last = await tx.recipeFormulation.findFirst({ where: { recipeId }, orderBy: { version: 'desc' }, select: { version: true } });
    await tx.recipeFormulation.updateMany({ where: { recipeId, isActive: true }, data: { isActive: false } });
    await tx.recipeFormulation.create({
      data: {
        recipeId,
        version: (last?.version || 0) + 1,
        yieldQty: f.yieldQty,
        yieldUnit: f.yieldUnit,
        source: 'RECIPE_FORM',
        isActive: true,
        items: { create: f.items.map((i, idx) => ({ inventoryItemId: i.inventoryItemId, quantity: i.quantityRequired, unit: i.unit, sortOrder: idx })) },
      },
    });
  }

  /**
   * Pure scaling: factor = target (in reference unit) / reference yield;
   * required = reference qty × factor, also expressed in each material's
   * stock unit.
   */
  static scale(
    f: { yieldQty: number; yieldUnit: string; items: Array<{ inventoryItemId: string; quantity: number; unit: string; inventoryItem: { name: string; unit: string } }> },
    targetQty: number,
    targetUnit: string,
  ) {
    if (!Number.isFinite(Number(targetQty)) || Number(targetQty) <= 0) throw new FormulationError('Target production quantity must be greater than zero.');
    if (!(f.yieldQty > 0)) throw new FormulationError('This formulation has no valid reference yield.');
    const targetInRefUnit = convertQty(targetQty, targetUnit, f.yieldUnit);
    const factor = targetInRefUnit.dividedBy(f.yieldQty);
    const lines: ScaledLine[] = f.items.map((i) => {
      const calculated = new Decimal(i.quantity).times(factor);
      // Same rule ProductionService.startProduction deducts by.
      const required = new Decimal(roundRequirement(calculated.toNumber(), i.unit));
      return {
        inventoryItemId: i.inventoryItemId,
        name: i.inventoryItem.name,
        referenceQty: i.quantity,
        unit: i.unit,
        calculatedQty: round(calculated),
        requiredQty: round(required),
        stockUnit: i.inventoryItem.unit,
        requiredInStockUnit: round(convertQty(required, i.unit, i.inventoryItem.unit)),
      };
    });
    return { factor: factor.toNumber(), targetInRefUnit: round(targetInRefUnit), lines };
  }

  /** The saved active formulation must cover exactly the recipe's current ingredient list. */
  static assertMatchesIngredients(recipe: { ingredients: Array<{ inventoryItemId: string }> }, f: { version: number; items: Array<{ inventoryItemId: string }> }) {
    const ing = new Set(recipe.ingredients.map((i) => i.inventoryItemId));
    const form = new Set(f.items.map((i) => i.inventoryItemId));
    const same = ing.size === form.size && [...ing].every((id) => form.has(id));
    if (!same) {
      throw new FormulationError(`The recipe's ingredients changed after formulation v${f.version} was saved. Update and save the formulation before producing.`);
    }
  }

  /** Read-only plan: requirements + warehouse availability. Never moves stock. */
  static async preview(params: { recipeId: string; targetQty: number; targetUnit: string; warehouseId?: string }) {
    const recipe = await prisma.recipe.findUnique({ where: { id: params.recipeId }, include: { ingredients: true } });
    if (!recipe) throw new FormulationError('Recipe not found');
    const f = await this.getActive(prisma, params.recipeId);
    if (!f) throw new FormulationError('This recipe has no saved formulation yet.');
    this.assertMatchesIngredients(recipe, f);
    const scaled = this.scale(f, params.targetQty, params.targetUnit);

    const lines = await Promise.all(scaled.lines.map(async (l) => {
      const available = params.warehouseId ? await InventoryService.computeWarehouseStock(l.inventoryItemId, params.warehouseId) : null;
      const shortage = available === null ? null : round(Math.max(0, l.requiredInStockUnit - available));
      return { ...l, available: available === null ? null : round(available), shortage, sufficient: shortage === null ? null : shortage <= 0.000001 };
    }));
    return {
      formulation: {
        id: f.id, version: f.version, yieldQty: f.yieldQty, yieldUnit: f.yieldUnit,
        source: f.source, outputStage: f.outputStage ?? null,
        // Lines with no quantity to scale ("As Required"): shown, never calculated.
        unresolvedItems: f.unresolvedItems ?? [],
      },
      targetQty: Number(params.targetQty),
      targetUnit: normalizeUnit(params.targetUnit),
      factor: scaled.factor,
      lines,
      readyToProduce: !!params.warehouseId && lines.every((l) => l.sufficient),
      costEstimate: await this.estimateCost(recipe, f, scaled),
    };
  }

  /**
   * Estimated production cost for the plan: raw materials at each
   * material's average cost (the lot panel refines this with the chosen
   * lots) plus the recipe's manufacturing expenses on the planned output.
   * Read-only: nothing is deducted or posted.
   */
  private static async estimateCost(
    recipe: { expenseConfig: unknown; expenseConfigVersion: number },
    f: { yieldUnit: string; items: Array<{ inventoryItemId: string; inventoryItem: { costPrice?: number | null } }> },
    scaled: { targetInRefUnit: number; lines: ScaledLine[] },
  ) {
    const categories = await ProductionCostingService.getExpenseCategories();
    const enabled = readRecipeExpenses(recipe.expenseConfig, categories).filter((e) => e.enabled);
    const materialCost = scaled.lines.reduce((sum, l) => {
      const unitCost = f.items.find((i) => i.inventoryItemId === l.inventoryItemId)?.inventoryItem.costPrice || 0;
      return sum.plus(new Decimal(l.requiredInStockUnit).times(unitCost));
    }, new Decimal(0));
    let manufacturing: ReturnType<typeof computeManufacturingExpenses> = { lines: [], deferred: [], total: 0 };
    let expenseError: string | null = null;
    try {
      manufacturing = computeManufacturingExpenses(enabled, scaled.targetInRefUnit, f.yieldUnit);
    } catch (e: any) {
      expenseError = e.message;
    }
    const total = materialCost.plus(manufacturing.total);
    return {
      configVersion: recipe.expenseConfigVersion ?? 0,
      materialCost: materialCost.toDecimalPlaces(4).toNumber(),
      materialCostBasis: 'AVERAGE_COST' as const,
      manufacturingExpenses: manufacturing.lines,
      manufacturingExpenseTotal: manufacturing.total,
      // Charged at packaging, once pack sizes and packet counts are known.
      deferredToPackaging: manufacturing.deferred,
      packagingExpenses: enabled.filter((e) => isPackagingCategory(e.category)),
      estimatedProductionCost: total.toDecimalPlaces(4).toNumber(),
      estimatedCostPerUnit: scaled.targetInRefUnit > 0 ? total.dividedBy(scaled.targetInRefUnit).toDecimalPlaces(4).toNumber() : null,
      expenseError,
    };
  }

  /**
   * Builds the frozen snapshot and the values ProductionService.startProduction
   * already understands: quantity = scaling factor (its "number of reference
   * runs"), with the active formulation mirrored into the recipe BOM.
   * startProduction re-checks, under a recipe row lock, that the formulation
   * is still active and the mirror matches, then validates warehouse stock
   * and deducts exactly as before.
   */
  static async buildPlannedStart(params: { recipeId: string; formulationId: string; targetQty: number; targetUnit: string }) {
    const recipe = await prisma.recipe.findUnique({ where: { id: params.recipeId }, include: { ingredients: true } });
    if (!recipe) throw new FormulationError('Recipe not found');
    const f = await this.getActive(prisma, params.recipeId);
    if (!f) throw new FormulationError('This recipe has no saved formulation yet. Save the reference formulation first.');
    if (f.id !== params.formulationId) throw new FormulationError('The formulation was updated since you loaded it. Reload Production Planning and try again.');
    this.assertMatchesIngredients(recipe, f);
    const scaled = this.scale(f, params.targetQty, params.targetUnit);

    return {
      quantity: scaled.factor,
      planning: {
        formulationId: f.id,
        plannedYieldQty: scaled.targetInRefUnit,
        plannedYieldUnit: f.yieldUnit,
        snapshot: {
          formulationId: f.id,
          formulationVersion: f.version,
          referenceYieldQty: f.yieldQty,
          referenceYieldUnit: f.yieldUnit,
          outputStage: f.outputStage ?? null,
          unresolvedItems: f.unresolvedItems ?? [],
          targetQty: Number(params.targetQty),
          targetUnit: normalizeUnit(params.targetUnit),
          scalingFactor: scaled.factor,
          quantityRounding: REQUIREMENT_ROUNDING_POLICY,
          ingredients: scaled.lines,
        },
      },
    };
  }
}
