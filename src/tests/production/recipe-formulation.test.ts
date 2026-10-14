/**
 * Simplified Recipe Master + Production Planning formulation scaling.
 *
 * Writes real rows (uniquely named per run). Run against a disposable DB:
 *   DATABASE_URL=<test db> npx tsx src/tests/production/recipe-formulation.test.ts
 */
import prisma from '../../lib/prisma';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { FormulationService } from '../../modules/recipes/formulation.service';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

let passed = 0;
function check(title: string, condition: boolean, details?: unknown) {
  if (!condition) {
    console.error(`[FAIL] ${title}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
  passed++;
  console.log(`[PASS] ${title}`);
}
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 1e-6;
async function rejects(fn: () => Promise<unknown>, contains: string) {
  try { await fn(); } catch (e: any) { return String(e?.message).includes(contains) ? null : e?.message; }
  return 'did not throw';
}

const ts = Date.now();

async function startPlanned(recipeId: string, formulationId: string, targetQty: number, targetUnit: string, warehouseId: string) {
  const planned = await FormulationService.buildPlannedStart({ recipeId, formulationId, targetQty, targetUnit });
  return ProductionService.startProduction({
    recipeId, quantity: planned.quantity, warehouseId, productionType: 'FINISHED_GOOD',
    expiryDate: '2027-12-31', planning: planned.planning,
  });
}

async function run() {
  console.log('=== RECIPE FORMULATION & PLANNING ===\n');

  if (!(await prisma.franchise.findFirst({ where: { isHQ: true } }))) {
    await prisma.franchise.create({ data: { name: `HQ ${ts}`, isHQ: true, location: 'HQ', ownerName: 'HQ', contactNum: '0' } });
  }
  const wh = await prisma.warehouse.create({ data: { name: `Kitchen ${ts}`, nameKey: `kitchen-${ts}`, status: 'ACTIVE' } });
  const mk = (name: string, unit: string) => prisma.inventoryItem.create({
    data: { name: `${name} ${ts}`, sku: `RM-${name.replace(/\s/g, '')}-${ts}`, category: 'RAW_MATERIAL', unit, currentStock: 0, minimumStock: 0, costPrice: 0 },
  });
  const rice = await mk('Rice', 'KG');
  const dal = await mk('White Urad Dal', 'KG');
  const egg = await mk('Egg', 'PCS');
  const water = await mk('Water', 'L');

  // Stock in the kitchen warehouse: Rice 8 KG @ ₹50, Dal 2 KG @ ₹120
  await prisma.$transaction(async (tx) => {
    await InventoryService.recordMovement(tx, { itemId: rice.id, type: 'PURCHASE_IN', quantity: 8, warehouseId: wh.id, receiveAtCost: { unitCost: 50 } });
    await InventoryService.recordMovement(tx, { itemId: dal.id, type: 'PURCHASE_IN', quantity: 2, warehouseId: wh.id, receiveAtCost: { unitCost: 120 } });
  });

  // 1–2. Simplified recipes (no quantities)
  const batter = await RecipeService.saveSimplifiedRecipe({ name: `Veg Dosa Batter ${ts}`, category: 'Batters', instructions: 'Soak, grind, ferment.', ingredientIds: [rice.id, dal.id] });
  check('1a. Simplified recipe saved with 2 ingredients', batter!.ingredients.length === 2);
  check('1b. No BOM lines or formulation created', batter!.recipeItems.length === 0 && (await prisma.recipeFormulation.count({ where: { recipeId: batter!.id } })) === 0);
  const single = await RecipeService.saveSimplifiedRecipe({ name: `Plain Rice ${ts}`, category: 'Basics', ingredientIds: [rice.id] });
  check('1c. Single-ingredient recipe saved', single!.ingredients.length === 1);
  check('2a. Duplicate ingredient rejected', (await rejects(() => RecipeService.saveSimplifiedRecipe({ name: 'X', category: 'C', ingredientIds: [rice.id, rice.id] }), 'only be selected once')) === null);
  check('2b. No ingredients rejected', (await rejects(() => RecipeService.saveSimplifiedRecipe({ name: 'X', category: 'C', ingredientIds: [] }), 'at least one ingredient')) === null);
  check('2c. Missing category rejected', (await rejects(() => RecipeService.saveSimplifiedRecipe({ name: 'X', category: ' ', ingredientIds: [rice.id] }), 'Category is required')) === null);

  // Edit: rename, recategorise, add & remove ingredients, reload
  const edited = await RecipeService.saveSimplifiedRecipe({ id: single!.id, name: `Rice Mix ${ts}`, category: 'Mixes', ingredientIds: [rice.id, water.id] });
  const reloaded = await RecipeService.getRecipeById(single!.id);
  check('2d. Edit name/category + add ingredient persists on reload',
    reloaded!.name === `Rice Mix ${ts}` && reloaded!.category === 'Mixes' && reloaded!.ingredients.map((i: any) => i.inventoryItemId).join() === [rice.id, water.id].join() && edited!.id === single!.id);
  await RecipeService.saveSimplifiedRecipe({ id: single!.id, name: `Rice Mix ${ts}`, category: 'Mixes', ingredientIds: [water.id] });
  check('2e. Remove ingredient persists', (await RecipeService.getRecipeById(single!.id))!.ingredients.length === 1);

  // 3. No formulation yet → nothing can silently produce from it
  check('3a. Preview refuses recipe with no formulation', (await rejects(() => FormulationService.preview({ recipeId: batter!.id, targetQty: 3, targetUnit: 'KG', warehouseId: wh.id }), 'no saved formulation')) === null);
  check('3b. Legacy start refuses recipe with no BOM', (await rejects(() => ProductionService.startProduction({ recipeId: batter!.id, quantity: 1, warehouseId: wh.id, productionType: 'FINISHED_GOOD' }), 'no saved formulation')) === null);

  // 4–5. Formulation validation + save
  const base = { yieldQty: 3, yieldUnit: 'KG', items: [{ inventoryItemId: rice.id, quantity: 1, unit: 'KG' }, { inventoryItemId: dal.id, quantity: 250, unit: 'G' }] };
  check('4a. Zero reference yield rejected', (await rejects(() => FormulationService.saveVersion(batter!.id, { ...base, yieldQty: 0 }), 'greater than zero')) === null);
  check('4b. Negative quantity rejected', (await rejects(() => FormulationService.saveVersion(batter!.id, { ...base, items: [base.items[0], { ...base.items[1], quantity: -1 }] }), 'valid quantity')) === null);
  check('4c. Missing ingredient quantity rejected', (await rejects(() => FormulationService.saveVersion(batter!.id, { ...base, items: [base.items[0]] }), 'Missing')) === null);
  check('4d. All-zero quantities rejected', (await rejects(() => FormulationService.saveVersion(batter!.id, { ...base, items: base.items.map(i => ({ ...i, quantity: 0 })) }), 'greater than zero')) === null);
  check('4e. Unknown unit rejected', (await rejects(() => FormulationService.saveVersion(batter!.id, { ...base, yieldUnit: 'BUCKET' }), 'Unsupported unit')) === null);
  const eggRecipe = await RecipeService.saveSimplifiedRecipe({ name: `Egg Mix ${ts}`, category: 'Mixes', ingredientIds: [egg.id] });
  check('4f. Pieces can\'t be entered as weight (Egg PCS vs KG)', (await rejects(() => FormulationService.saveVersion(eggRecipe!.id, { yieldQty: 1, yieldUnit: 'KG', items: [{ inventoryItemId: egg.id, quantity: 1, unit: 'KG' }] }), 'can\'t be converted')) === null);

  const v1 = await FormulationService.saveVersion(batter!.id, base, 'tester');
  const afterSave = await prisma.recipe.findUnique({ where: { id: batter!.id }, include: { recipeItems: true } });
  check('5a. Formulation v1 saved and active', v1.version === 1 && v1.isActive && v1.items.length === 2);
  check('5b. Mirrored into legacy BOM for existing consumers',
    afterSave!.yieldQty === 3 && afterSave!.yieldUnit === 'KG' && afterSave!.recipeItems.length === 2 &&
    afterSave!.recipeItems.some(r => r.inventoryItemId === dal.id && r.quantityRequired === 250 && r.unit === 'G'));

  // 6–11. Scaling
  const scaled = async (q: number, u: string) => {
    const p = await FormulationService.preview({ recipeId: batter!.id, targetQty: q, targetUnit: u, warehouseId: wh.id });
    const r = p.lines.find(l => l.inventoryItemId === rice.id)!;
    const d = p.lines.find(l => l.inventoryItemId === dal.id)!;
    return { p, r, d };
  };
  let s = await scaled(3, 'KG');
  check('7. Target 3 KG → Rice 1 KG, Dal 250 g', near(s.r.requiredQty, 1) && s.r.unit === 'KG' && near(s.d.requiredQty, 250) && s.d.unit === 'G' && near(s.p.factor, 1), s.p);
  s = await scaled(12, 'KG');
  check('9. Target 12 KG → factor 4, Rice 4 KG, Dal 1000 g (= 1 KG)', near(s.p.factor, 4) && near(s.r.requiredQty, 4) && near(s.d.requiredQty, 1000) && near(s.d.requiredInStockUnit, 1), s.p);
  s = await scaled(30, 'KG');
  check('11. Target 30 KG → Rice 10 KG, Dal 2.5 KG', near(s.r.requiredQty, 10) && near(s.d.requiredInStockUnit, 2.5), s.p);
  s = await scaled(12000, 'G');
  check('11b. Target 12000 g scales the same as 12 KG', near(s.p.factor, 4) && near(s.r.requiredQty, 4));
  check('11c. Non-convertible target unit rejected', (await rejects(() => FormulationService.preview({ recipeId: batter!.id, targetQty: 5, targetUnit: 'PCS' }), 'Cannot convert')) === null);

  // 12–13. Availability
  s = await scaled(12, 'KG');
  check('12. 12 KG: available Rice 8 / Dal 2, no shortage, ready', near(s.r.available, 8) && near(s.d.available, 2) && s.p.readyToProduce === true, s.p.lines);
  s = await scaled(30, 'KG');
  check('13a. 30 KG: Rice short 2 KG, Dal short 0.5 KG, not ready', near(s.r.shortage, 2) && near(s.d.shortage, 0.5) && s.p.readyToProduce === false, s.p.lines);
  const riceBefore = await InventoryService.computeWarehouseStock(rice.id, wh.id);
  check('13b. Starting 30 KG is refused by backend stock check', (await rejects(() => startPlanned(batter!.id, v1.id, 30, 'KG', wh.id), 'Insufficient stock')) === null);
  check('13c. Preview and refused start moved no stock', near(await InventoryService.computeWarehouseStock(rice.id, wh.id), riceBefore));

  // 14–15. Start 12 KG and verify exact consumption
  const prod = await startPlanned(batter!.id, v1.id, 12, 'KG', wh.id);
  const run = await prisma.production.findUnique({ where: { id: prod.id }, include: { items: true } });
  check('14. Production started with formulation + frozen snapshot',
    run!.formulationId === v1.id && near(run!.plannedYieldQty, 12) && run!.plannedYieldUnit === 'KG' && near(run!.quantity, 4) &&
    (run!.formulationSnapshot as any)?.formulationVersion === 1 && (run!.formulationSnapshot as any)?.ingredients?.length === 2, run);
  check('15a. Exact consumption: Rice 8→4 KG, Dal 2→1 KG',
    near(await InventoryService.computeWarehouseStock(rice.id, wh.id), 4) && near(await InventoryService.computeWarehouseStock(dal.id, wh.id), 1));
  const ri = run!.items.find(i => i.inventoryItemId === rice.id)!;
  const di = run!.items.find(i => i.inventoryItemId === dal.id)!;
  check('15b. Production items record 4 KG + 1 KG at lot cost (₹200 + ₹120)', near(ri.usedQuantity, 4) && near(di.usedQuantity, 1) && near(run!.materialCost, 320), { ri, di, cost: run!.materialCost });

  // 16. History preserved through a formulation update
  const v2 = await FormulationService.saveVersion(batter!.id, { ...base, items: [{ inventoryItemId: rice.id, quantity: 1.2, unit: 'KG' }, base.items[1]] }, 'tester');
  const v1After = await prisma.recipeFormulation.findUnique({ where: { id: v1.id }, include: { items: true } });
  const runAfter = await prisma.production.findUnique({ where: { id: prod.id } });
  check('16a. v2 active, v1 kept unchanged as history', v2.version === 2 && v1After!.isActive === false && v1After!.items.some(i => i.inventoryItemId === rice.id && i.quantity === 1));
  check('16b. Earlier run keeps its v1 snapshot, quantities and cost', runAfter!.formulationId === v1.id && (runAfter!.formulationSnapshot as any).formulationVersion === 1 && near(runAfter!.materialCost, 320));
  check('16c. Starting with the stale v1 id is refused', (await rejects(() => startPlanned(batter!.id, v1.id, 3, 'KG', wh.id), 'updated since')) === null);
  check('16d. Yield unit of a produced recipe cannot change', (await rejects(() => FormulationService.saveVersion(batter!.id, { ...base, yieldUnit: 'G', yieldQty: 3000 }), 'must stay')) === null);
  await RecipeService.saveSimplifiedRecipe({ id: batter!.id, name: `Veg Dosa Batter ${ts}`, category: 'Batters', ingredientIds: [rice.id, dal.id, water.id] });
  check('16e. After adding an ingredient, start requires a new formulation', (await rejects(() => startPlanned(batter!.id, v2.id, 3, 'KG', wh.id), 'ingredients changed')) === null);
  const bomAfterEdit = await prisma.recipeItem.count({ where: { recipeId: batter!.id } });
  check('16f. Ingredient edit leaves the saved BOM untouched (POS/finance keep v2 values)', bomAfterEdit === 2);

  // 17. Legacy quantity-bearing path still works unchanged
  const legacy = await RecipeService.upsertRecipe({
    name: `Legacy Mix ${ts}`, yieldQty: 2, yieldUnit: 'KG', instructions: '',
    items: [{ inventoryItemId: rice.id, quantityRequired: 0.5, unit: 'KG' }],
  });
  const legacyForms = await prisma.recipeFormulation.findMany({ where: { recipeId: legacy!.id } });
  check('17a. Legacy recipe form still saves BOM + records a formulation version', legacy!.recipeItems.length === 1 && legacyForms.length === 1 && legacyForms[0].source === 'RECIPE_FORM');
  const legacyRun = await ProductionService.startProduction({ recipeId: legacy!.id, quantity: 2, warehouseId: wh.id, productionType: 'FINISHED_GOOD', expiryDate: '2027-12-31' });
  const legacyItems = await prisma.productionItem.findMany({ where: { productionId: legacyRun.id } });
  check('17b. Legacy start (quantity = runs) deducts exactly as before: 0.5 × 2 = 1 KG', legacyItems.length === 1 && near(legacyItems[0].usedQuantity, 1) && near(await InventoryService.computeWarehouseStock(rice.id, wh.id), 3));
  check('17c. Legacy run has no planning fields', legacyRun.formulationId === null && legacyRun.plannedYieldQty === null);

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
