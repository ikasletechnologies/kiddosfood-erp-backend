/**
 * Default Additional Expenses (₹1 Manpower + ₹1 Electricity + ₹1 Other +
 * ₹2 Packaging Materials, per packet): given to every new recipe, frozen on
 * each run, and charged at packaging on actual packets — once.
 *
 * Writes real rows (uniquely named per run, removed afterwards):
 *   npx tsx src/tests/production/recipe-default-expenses.test.ts
 */
import prisma from '../../lib/prisma';
import { cleanupTestRun } from '../fixture-cleanup';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { FormulationService } from '../../modules/recipes/formulation.service';
import { ProductionService } from '../../modules/production/production.service';
import { ProductionCostingService } from '../../modules/production/production-costing.service';
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
const near = (a: number | null | undefined, b: number, eps = 1e-4) => a != null && Math.abs(a - b) < eps;
const ts = Date.now();

async function run() {
  console.log('=== DEFAULT RECIPE EXPENSES ===\n');
  const userId = (await prisma.user.findFirst())?.id;
  const wh = await prisma.warehouse.create({ data: { name: `Kitchen ${ts}`, nameKey: `kitchen-de-${ts}`, status: 'ACTIVE' } });
  const rice = await prisma.inventoryItem.create({
    data: { name: `Rice ${ts}`, sku: `RM-RICE-DE-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 0, costPrice: 0 },
  });
  // ₹10/KG: a 10 KG batch is ₹100 of raw material.
  await prisma.$transaction((tx) => InventoryService.recordMovement(tx, {
    itemId: rice.id, type: 'PURCHASE_IN', quantity: 100, warehouseId: wh.id, receiveAtCost: { unitCost: 10, batchNumber: `LOT-DE-${ts}`, mfgDate: new Date('2026-01-01') },
  }));

  // 1. Defaults come from the central setting (or the built-in fallback).
  const defaults = await ProductionCostingService.getDefaultRecipeExpenses();
  check('1. Defaults: Manpower ₹1, Electricity ₹1, Other ₹1, Packaging ₹2 — all per packet',
    defaults.every((d) => d.enabled && d.basis === 'PER_PACKET') &&
    defaults.map((d) => `${d.category}:${d.rate}`).join(',') === 'MANPOWER:1,ELECTRICITY:1,OTHER:1,PACKAGING_MATERIAL:2', defaults);

  // 2. A new recipe saved without expenses gets them, persisted.
  const r = await RecipeService.saveSimplifiedRecipe({ name: `Idli Batter ${ts}`, category: 'Batters', ingredientIds: [rice.id] }, userId);
  const f = await FormulationService.saveVersion(r!.id, { yieldQty: 10, yieldUnit: 'KG', items: [{ inventoryItemId: rice.id, quantity: 10, unit: 'KG' }] });
  const saved = await prisma.recipe.findUniqueOrThrow({ where: { id: r!.id } });
  check('2. Saved on the recipe (version 1, audited)', saved.expenseConfigVersion === 1 && Array.isArray(saved.expenseConfig) &&
    (await prisma.auditLog.count({ where: { module: 'RECIPE', action: 'EXPENSE_CONFIG_UPDATE', recordId: r!.id } })) === 1);

  const mk = (size: string) => prisma.product.create({
    data: { name: `Idli Batter ${size} ${ts}`, sku: `FG-DE${ts}-${size.toUpperCase()}`, basePrice: 50, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', isActive: true },
  });
  const p500 = await mk('500g');
  const p1kg = await mk('1kg');
  const produce = async () => {
    const planned = await FormulationService.buildPlannedStart({ recipeId: r!.id, formulationId: f.id, targetQty: 10, targetUnit: 'KG' });
    const run = await ProductionService.startProduction({ recipeId: r!.id, quantity: planned.quantity, warehouseId: wh.id, productionType: 'FINISHED_GOOD', expiryDate: '2027-12-31', planning: planned.planning, userId });
    const done = await ProductionService.approveProduction(run.id, userId, 10);
    return { run, done, batch: (await prisma.productBatch.findUniqueOrThrow({ where: { productionId: run.id } })) };
  };

  // 3. Snapshot at start; per-packet expenses are not multiplied by KG.
  const a = await produce();
  const snap = (await prisma.production.findUniqueOrThrow({ where: { id: a.run.id } })).expenseSnapshot as any;
  check('3a. Run froze the 4 per-packet expenses (version 1)', snap?.source === 'RECIPE' && snap.configVersion === 1 && snap.expenses.length === 4 && snap.expenses.every((e: any) => e.basis === 'PER_PACKET'));
  check('3b. Completion: ₹100 raw material, no expense charged on KG (₹10/KG bulk)',
    near(a.done.cost.materialCost, 100) && near(a.done.cost.manufacturingExpenseTotal, 0) && near(a.batch.unitCost, 10), a.done.cost);

  // 4. 20 good 500g packets: ₹100 material + 20 × ₹5 = ₹200 → ₹10/packet.
  const s = await ProductionService.packageAndConfirm({ batchId: a.batch.id, expectedPackagedQty: 0, userId, rows: [{ packetSize: '500g', packedQty: 20, damagedQty: 0, productId: p500.id }] });
  const cb = s.packaging.costBreakdown as any;
  check('4a. 20 packets → additional expenses ₹100, total ₹200, ₹10 per packet', near(cb.totalCost, 200) && near(cb.costPerGoodPacket, 10) && cb.expenseSource === 'RECIPE_SNAPSHOT', cb);
  check('4b. Finished-goods lot costed at ₹10/packet', near((await prisma.inventoryBatch.findUniqueOrThrow({ where: { productPackagingId: s.packaging.id } })).unitCost, 10));

  // 5. Multiple pack sizes over two partial sessions, with a damaged packet.
  const b = await produce();
  const s1 = await ProductionService.packageAndConfirm({
    batchId: b.batch.id, expectedPackagedQty: 0, userId,
    rows: [{ packetSize: '500g', packedQty: 4, damagedQty: 0, productId: p500.id }, { packetSize: '1kg', packedQty: 2, damagedQty: 0, productId: p1kg.id }],
  });
  check('5a. Session 1: 500g = ₹5 + ₹5 = ₹10; 1kg = ₹10 + ₹5 = ₹15', near(s1.summary[0].unitCost, 10) && near(s1.summary[1].unitCost, 15), s1.summary);
  const s2 = await ProductionService.packageAndConfirm({
    batchId: b.batch.id, expectedPackagedQty: 4, userId,
    rows: [{ packetSize: '500g', packedQty: 6, damagedQty: 0, productId: p500.id }, { packetSize: '1kg', packedQty: 2, damagedQty: 1, productId: p1kg.id }],
  });
  check('5b. Session 2: damaged 1kg packet carried by the 2 good ones (3 × ₹15 / 2 = ₹22.50)', near(s2.summary[1].unitCost, 22.5), s2.summary);
  const totalExpenses = await prisma.productionExpense.aggregate({ where: { productBatchId: b.batch.id }, _sum: { amount: true } });
  check('5c. 15 packets in all → ₹75 expenses, nothing charged twice', near(totalExpenses._sum.amount, 75), totalExpenses._sum);
  const summary = await ProductionCostingService.getBatchCostSummary(b.batch.id);
  check('5d. Bulk fully packed, nothing left to charge', near(summary.remainingQty, 0));

  // 6. Edits apply to future runs only.
  await RecipeService.saveSimplifiedRecipe({ id: r!.id, name: `Idli Batter ${ts}`, category: 'Batters', ingredientIds: [rice.id], additionalExpenses: [
    { category: 'MANPOWER', enabled: true, basis: 'PER_PACKET', rate: 3 },
    { category: 'ELECTRICITY', enabled: true, basis: 'PER_KG', rate: 0 },
    { category: 'OTHER', enabled: false, basis: 'PER_PACKET', rate: 1 },
    { category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', rate: 2 },
  ] }, userId);
  const re = await RecipeService.getRecipeById(r!.id);
  check('6a. Edited amounts, ₹0 and switched-off expenses saved (version 2)', re!.expenseConfigVersion === 2 &&
    re!.additionalExpenses.find((e) => e.category === 'ELECTRICITY')?.rate === 0 && re!.additionalExpenses.find((e) => e.category === 'OTHER')?.enabled === false);
  check('6b. Earlier runs keep their version-1 snapshot', JSON.stringify((await prisma.production.findUniqueOrThrow({ where: { id: b.run.id } })).expenseSnapshot) !== null &&
    ((await prisma.production.findUniqueOrThrow({ where: { id: b.run.id } })).expenseSnapshot as any).configVersion === 1);

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanupTestRun(ts); await prisma.$disconnect(); });
