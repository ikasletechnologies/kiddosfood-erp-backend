/**
 * Production completion with actual yield: planned vs actual kept separate,
 * variance computed, remarks threshold, packaging gets the actual quantity,
 * no extra raw-material deduction, no finished-goods stock, no double completion.
 *
 * Writes real rows (uniquely named per run). Run against a disposable DB:
 *   DATABASE_URL=<test db> npx tsx src/tests/production/actual-yield-completion.test.ts
 */
import prisma from '../../lib/prisma';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { FormulationService } from '../../modules/recipes/formulation.service';
import { ProductionService, YIELD_VARIANCE_REMARKS_SETTING } from '../../modules/production/production.service';
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

async function run() {
  console.log('=== ACTUAL YIELD ON COMPLETION ===\n');
  if (!(await prisma.franchise.findFirst({ where: { isHQ: true } }))) {
    await prisma.franchise.create({ data: { name: `HQ ${ts}`, isHQ: true, location: 'HQ', ownerName: 'HQ', contactNum: '0' } });
  }
  await prisma.systemSetting.deleteMany({ where: { key: YIELD_VARIANCE_REMARKS_SETTING } }); // default 20%
  const user = await prisma.user.findFirst();
  const userId = user?.id;

  const wh = await prisma.warehouse.create({ data: { name: `Kitchen ${ts}`, nameKey: `kitchen-y-${ts}`, status: 'ACTIVE' } });
  const rice = await prisma.inventoryItem.create({
    data: { name: `Rice ${ts}`, sku: `RM-RICE-Y-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 0, costPrice: 0 },
  });
  await prisma.$transaction((tx) => InventoryService.recordMovement(tx, { itemId: rice.id, type: 'PURCHASE_IN', quantity: 100, warehouseId: wh.id, receiveAtCost: { unitCost: 50 } }));
  const recipe = await RecipeService.saveSimplifiedRecipe({ name: `Rice Batter ${ts}`, category: 'Batters', ingredientIds: [rice.id] });
  const f = await FormulationService.saveVersion(recipe!.id, { yieldQty: 10, yieldUnit: 'KG', items: [{ inventoryItemId: rice.id, quantity: 4, unit: 'KG' }] });

  // Mirrors the Complete Production endpoint (variance-remarks rule on).
  const complete = (id: string, actual?: number, remarks?: string) =>
    ProductionService.approveProduction(id, userId, actual, remarks, undefined, undefined, { requireVarianceRemarks: true });

  const start = async (target: number) => {
    const planned = await FormulationService.buildPlannedStart({ recipeId: recipe!.id, formulationId: f.id, targetQty: target, targetUnit: 'KG' });
    return ProductionService.startProduction({ recipeId: recipe!.id, quantity: planned.quantity, warehouseId: wh.id, productionType: 'FINISHED_GOOD', expiryDate: '2027-12-31', planning: planned.planning });
  };

  // 1. Start: planned 10 KG consumes 4 KG rice @ ₹50 = ₹200
  const p1 = await start(10);
  const riceAfterStart = await InventoryService.computeWarehouseStock(rice.id, wh.id);
  const itemsAtStart = await prisma.productionItem.findMany({ where: { productionId: p1.id } });
  check('1. Planned 10 KG run started; 4 KG rice consumed (₹200)', near(p1.plannedYieldQty, 10) && near(riceAfterStart, 96) && near(p1.materialCost, 200));

  // Validation
  check('4a. Zero actual yield rejected', (await rejects(() => complete(p1.id, 0), 'greater than 0')) === null);
  check('4b. Negative actual yield rejected', (await rejects(() => complete(p1.id, -5), 'greater than 0')) === null);
  check('4c. NaN actual yield rejected', (await rejects(() => complete(p1.id, NaN), 'greater than 0')) === null);
  check('4d. +50% without remarks rejected (default threshold 20%)', (await rejects(() => complete(p1.id, 15), 'Add remarks')) === null);
  check('4e. Failed attempts left the run in progress', (await prisma.production.findUnique({ where: { id: p1.id } }))!.status === 'IN_PROGRESS');

  // 2–9. Complete with 15 KG (+5 KG, +50%)
  const res = await complete(p1.id, 15, 'Rice absorbed more water than usual');
  check('5. Variance returned: +5 KG, +50%', near(res.yield.difference, 5) && near(res.yield.variancePct, 50) && near(res.yield.planned, 10) && near(res.yield.actual, 15), res.yield);
  const done = await prisma.production.findUnique({ where: { id: p1.id }, include: { items: true } });
  check('7. Planned yield still 10 KG', near(done!.plannedYieldQty, 10) && done!.plannedYieldUnit === 'KG');
  check('8. Actual yield saved as 15 KG', near(done!.actualYield, 15));
  check('9. Run COMPLETED with completion time', done!.status === 'COMPLETED' && !!done!.endTime);
  const audit = await prisma.auditLog.findFirst({ where: { module: 'PRODUCTION', action: 'COMPLETE', recordId: p1.id } });
  check('9b. Completion user, plan, actual and variance recorded', !!audit && audit.performedBy === (userId || 'SYSTEM') &&
    (audit.newValue as any).plannedYield === 10 && (audit.newValue as any).actualYield === 15 && (audit.newValue as any).variancePct === 50, audit?.newValue);

  // Cost & consumption untouched; unit cost from actual yield
  check('8b. No extra raw material deducted (rice still 96 KG)', near(await InventoryService.computeWarehouseStock(rice.id, wh.id), riceAfterStart));
  check('8c. Recorded consumption unchanged', done!.items.length === itemsAtStart.length && near(done!.items[0].usedQuantity, itemsAtStart[0].usedQuantity) && near(done!.materialCost, 200));
  const batch = await prisma.productBatch.findUnique({ where: { productionId: p1.id } });
  check('8d. Unit cost = ₹200 / 15 KG actual', near(batch!.unitCost, Number((200 / 15).toFixed(4))), batch?.unitCost);

  // 10–11. Packaging gets 15 KG as bulk; no finished goods created
  check('10. Batch released for packaging with actual 15 KG', near(batch!.quantity, 15) && near(batch!.approvedQty, 15) && batch!.qcStatus === 'QC_NOT_REQUIRED');
  const bulkIn = await prisma.stockMovement.findMany({ where: { referenceId: p1.id, movementType: 'PRODUCTION_IN' }, include: { item: true } });
  check('10b. Exactly one bulk (semi-finished) credit of 15', bulkIn.length === 1 && near(bulkIn[0].quantity, 15) && bulkIn[0].item.category === 'SEMI_FINISHED', bulkIn.map(m => ({ q: m.quantity, c: m.item.category })));
  const fgIn = bulkIn.filter(m => m.item.category === 'FINISHED_GOOD');
  check('11. No finished-goods stock created at completion', fgIn.length === 0 && (await prisma.productPackaging.count({ where: { batchId: batch!.id } })) === 0);

  // 12. Duplicate completion
  check('12a. Second completion rejected', (await rejects(() => complete(p1.id, 15, 'again'), 'must be in progress')) === null);
  const p2 = await start(10);
  const race = await Promise.allSettled([1, 2, 3].map(() => complete(p2.id, 10)));
  const batches = await prisma.productBatch.count({ where: { productionId: p2.id } });
  const credits = await prisma.stockMovement.count({ where: { referenceId: p2.id, movementType: 'PRODUCTION_IN' } });
  check('12b. Three concurrent completions → exactly one', race.filter(r => r.status === 'fulfilled').length === 1 && batches === 1 && credits === 1);

  // 13. Equal and lower yields
  const eq = await prisma.production.findUnique({ where: { id: p2.id } });
  check('13a. Equal yield: 0 difference, 0%, no remarks needed', near(eq!.actualYield, 10) && near(eq!.plannedYieldQty, 10));
  const p3 = await start(10);
  const low = await complete(p3.id, 8); // −20% = threshold, not above
  check('13b. Lower yield 8 KG: −2 KG, −20%, allowed at the threshold', near(low.yield.difference, -2) && near(low.yield.variancePct, -20));
  const p4 = await start(10);
  check('13c. 7 KG (−30%) needs remarks', (await rejects(() => complete(p4.id, 7), 'Add remarks')) === null);
  await prisma.systemSetting.upsert({ where: { key: YIELD_VARIANCE_REMARKS_SETTING }, create: { key: YIELD_VARIANCE_REMARKS_SETTING, value: '40' }, update: { value: '40' } });
  const p4done = await complete(p4.id, 7);
  check('13d. Threshold is configurable (40%): −30% allowed without remarks', near(p4done.yield.variancePct, -30));
  await prisma.systemSetting.deleteMany({ where: { key: YIELD_VARIANCE_REMARKS_SETTING } });
  check('13e. Decimal precision kept (10.125 KG)', await (async () => {
    const p = await start(10);
    const r = await complete(p.id, 10.125);
    return near(r.production.actualYield, 10.125) && near(r.yield.difference, 0.125) && near(r.yield.variancePct, 1.25);
  })());

  // Legacy run (no stored plan): plan derived from runs × recipe yield, then frozen at completion
  const legacy = await ProductionService.startProduction({ recipeId: recipe!.id, quantity: 2, warehouseId: wh.id, productionType: 'FINISHED_GOOD', expiryDate: '2027-12-31' });
  check('L1. Legacy run has no stored plan', legacy.plannedYieldQty === null);
  const legacyRes = await ProductionService.approveProduction(legacy.id, userId, 19);
  const legacyDone = await prisma.production.findUnique({ where: { id: legacy.id } });
  check('L2. Legacy plan = 2 × 10 KG, frozen at completion; −5%', near(legacyRes.yield.planned, 20) && near(legacyDone!.plannedYieldQty, 20) && near(legacyRes.yield.variancePct, -5));

  // Direct service callers (no endpoint flag) keep the old behaviour: no remarks rule.
  const pDirect = await start(10);
  const direct = await ProductionService.approveProduction(pDirect.id, userId, 4);
  check('L4. Direct service call with −60% and no remarks still completes (unchanged behaviour)', near(direct.yield.variancePct, -60));

  // Internal callers that omit actualYield keep the old behaviour (planned yield).
  const p5 = await start(10);
  const implicit = await ProductionService.approveProduction(p5.id, userId);
  check('L3. Service without actualYield still completes at planned yield', near(implicit.production.actualYield, 10));

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
