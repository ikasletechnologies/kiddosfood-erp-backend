/**
 * Additional Expenses configured in Recipe Master: saved and versioned per
 * recipe, frozen on each run at start, manufacturing expenses charged once at
 * completion on actual output, packaging expenses charged per pack size at
 * packaging, nothing entered manually at packaging, older runs unchanged.
 *
 * Writes real rows (uniquely named per run). Run against a disposable DB:
 *   DATABASE_URL=<test db> npx tsx src/tests/production/recipe-additional-expenses.test.ts
 */
import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { FormulationService } from '../../modules/recipes/formulation.service';
import { ProductionService } from '../../modules/production/production.service';
import { ProductionCostingService } from '../../modules/production/production-costing.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { snapshotPackagingLines, packSizeKey } from '../../modules/production/production-costing';

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
async function rejects(fn: () => Promise<unknown>, contains: string) {
  try { await fn(); } catch (e: any) { return String(e?.message).includes(contains) ? null : e?.message; }
  return 'did not throw';
}
const ts = Date.now();

async function run() {
  console.log('=== RECIPE ADDITIONAL EXPENSES ===\n');
  if (!(await prisma.franchise.findFirst({ where: { isHQ: true } }))) {
    await prisma.franchise.create({ data: { name: `HQ ${ts}`, isHQ: true, location: 'HQ', ownerName: 'HQ', contactNum: '0' } });
  }
  const userId = (await prisma.user.findFirst())?.id;
  const wh = await prisma.warehouse.create({ data: { name: `Kitchen ${ts}`, nameKey: `kitchen-rx-${ts}`, status: 'ACTIVE' } });
  const rice = await prisma.inventoryItem.create({
    data: { name: `Rice ${ts}`, sku: `RM-RICE-RX-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 0, costPrice: 0 },
  });
  await prisma.$transaction((tx) => InventoryService.recordMovement(tx, {
    itemId: rice.id, type: 'PURCHASE_IN', quantity: 100, warehouseId: wh.id, receiveAtCost: { unitCost: 150, batchNumber: `LOT-RX-${ts}`, mfgDate: new Date('2026-01-01') },
  }));
  const riceStock = () => InventoryService.computeWarehouseStock(rice.id, wh.id);

  const allFour = [
    { category: 'MANPOWER', enabled: true, basis: 'PER_BATCH', rate: 15 },
    { category: 'ELECTRICITY', enabled: true, basis: 'PER_BATCH', rate: '15' },
    { category: 'OTHER', enabled: true, basis: 'PER_BATCH', rate: 15 },
    {
      category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', rate: null,
      sizeRates: [{ packetSize: '250g', rate: 2 }, { packetSize: '500 g', rate: 3 }, { packetSize: '1kg', rate: 5 }],
    },
  ];
  const newRecipe = async (name: string, additionalExpenses?: unknown) => {
    const r = await RecipeService.saveSimplifiedRecipe({ name: `${name} ${ts}`, category: 'Batters', ingredientIds: [rice.id], additionalExpenses }, userId);
    const f = await FormulationService.saveVersion(r!.id, { yieldQty: 10, yieldUnit: 'KG', items: [{ inventoryItemId: rice.id, quantity: 10, unit: 'KG' }] });
    return { recipe: r!, f };
  };
  const start = async (recipeId: string, formulationId: string, target = 10) => {
    const planned = await FormulationService.buildPlannedStart({ recipeId, formulationId, targetQty: target, targetUnit: 'KG' });
    return ProductionService.startProduction({
      recipeId, quantity: planned.quantity, warehouseId: wh.id, productionType: 'FINISHED_GOOD', expiryDate: '2027-12-31', planning: planned.planning, userId,
    });
  };
  const edit = (recipe: any, additionalExpenses: unknown) => RecipeService.saveSimplifiedRecipe({
    id: recipe.id, name: recipe.name, category: recipe.category, ingredientIds: [rice.id], additionalExpenses,
  }, userId);

  // 1. Recipe with no additional expenses
  const { recipe: plain, f: plainF } = await newRecipe('Plain Batter');
  const plainRead = await RecipeService.getRecipeById(plain.id);
  check('1. No expenses: four categories, all disabled at ₹0, version 0',
    plainRead!.additionalExpenses.length === 4 && plainRead!.additionalExpenses.every((e) => !e.enabled) &&
    plainRead!.additionalExpenses.filter((e) => e.category !== 'PACKAGING_MATERIAL').every((e) => e.rate === 0) &&
    plainRead!.expenseConfigVersion === 0 && plainRead!.expenseConfig === null, plainRead!.additionalExpenses);

  // 2–3. All four expenses, saved and reloaded
  const { recipe: full, f: fullF } = await newRecipe('Rice Batter', allFour);
  const fullRead = await RecipeService.getRecipeById(full.id);
  const get = (list: any[], code: string) => list.find((e) => e.category === code);
  check('2. All four expenses saved', fullRead!.additionalExpenses.every((e) => e.enabled) && fullRead!.expenseConfigVersion === 1);
  check('3a. Reloaded: Manpower/Electricity/Other ₹15 Per Batch ("15" text parsed)',
    ['MANPOWER', 'ELECTRICITY', 'OTHER'].every((c) => get(fullRead!.additionalExpenses, c).basis === 'PER_BATCH' && get(fullRead!.additionalExpenses, c).rate === 15));
  const pm = get(fullRead!.additionalExpenses, 'PACKAGING_MATERIAL');
  check('3b. Reloaded: Packaging Materials per packet, size rates only (no common rate)',
    pm.basis === 'PER_PACKET' && pm.rate === null && pm.sizeRates.length === 3 && pm.sizeRates[1].packetSize === '500 g' && pm.sizeRates[1].rate === 3, pm);
  check('3c. Recipe list returns the same configuration',
    JSON.stringify((await RecipeService.getRecipes()).find((r) => r.id === full.id)!.additionalExpenses) === JSON.stringify(fullRead!.additionalExpenses));
  const auditV1 = await prisma.auditLog.findFirst({ where: { module: 'RECIPE', action: 'EXPENSE_CONFIG_UPDATE', recordId: full.id } });
  check('3d. Configuration change audited (version 0 → 1, by user)', !!auditV1 && (auditV1.newValue as any).version === 1 && auditV1.performedBy === (userId || 'SYSTEM'));
  await edit(fullRead, fullRead!.additionalExpenses);
  check('3e. Re-saving unchanged expenses does not create a new version', (await prisma.recipe.findUnique({ where: { id: full.id } }))!.expenseConfigVersion === 1);
  await edit(fullRead, undefined);
  check('3f. Saving without the expenses field keeps them', (await RecipeService.getRecipeById(full.id))!.additionalExpenses.every((e) => e.enabled));

  // Validation
  const bad = async (exp: unknown, msg: string) => rejects(() => edit(fullRead, exp), msg);
  check('V1. Negative amount rejected', (await bad([{ category: 'MANPOWER', enabled: true, basis: 'PER_BATCH', rate: -1 }], 'cannot be negative')) === null);
  check('V2. Non-numeric amount rejected', (await bad([{ category: 'ELECTRICITY', enabled: true, basis: 'PER_KG', rate: 'abc' }], 'valid amount')) === null);
  check('V3. Infinite amount rejected', (await bad([{ category: 'OTHER', enabled: true, basis: 'PER_KG', rate: Infinity }], 'valid amount')) === null);
  check('V4. Unknown basis rejected', (await bad([{ category: 'OTHER', enabled: true, basis: 'PER_HOUR', rate: 1 }], 'calculation basis')) === null);
  check('V5. Unknown category rejected', (await bad([{ category: 'RENT', enabled: true, rate: 1 }], 'Unknown expense')) === null);
  check('V6. Size rates on a manufacturing expense rejected', (await bad([{ category: 'MANPOWER', enabled: true, basis: 'PER_PACKET', rate: 1, sizeRates: [{ packetSize: '1kg', rate: 2 }] }], 'Packaging Materials only')) === null);
  check('V7. Invalid pack size rejected', (await bad([{ category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', sizeRates: [{ packetSize: 'big', rate: 2 }] }], 'must be a number with a unit')) === null);
  check('V8. Duplicate pack size (1kg / 1000g) rejected', (await bad([{ category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', sizeRates: [{ packetSize: '1kg', rate: 2 }, { packetSize: '1000g', rate: 3 }] }], 'more than once')) === null);
  check('V9. Rejected edits left version 1 untouched', (await prisma.recipe.findUnique({ where: { id: full.id } }))!.expenseConfigVersion === 1);
  const { recipe: blank } = await newRecipe('Blank Amounts', [{ category: 'MANPOWER', enabled: true, basis: 'PER_KG', rate: '' }]);
  check('V10. Omitted amount defaults to ₹0', get((await RecipeService.getRecipeById(blank.id))!.additionalExpenses, 'MANPOWER').rate === 0);

  // 5–6. Production Planning: expenses load automatically, nothing deducted
  const stockBefore = await riceStock();
  const plan = await FormulationService.preview({ recipeId: full.id, targetQty: 10, targetUnit: 'KG', warehouseId: wh.id });
  check('5. Planning estimate: raw ₹1,500 + ₹45 expenses = ₹1,545 (₹154.50/KG planned)',
    near(plan.costEstimate.materialCost, 1500) && near(plan.costEstimate.manufacturingExpenseTotal, 45) &&
    near(plan.costEstimate.estimatedProductionCost, 1545) && near(plan.costEstimate.estimatedCostPerUnit!, 154.5), plan.costEstimate);
  check('6a. Planning lists Manpower, Electricity, Other; Packaging Materials left for packaging',
    plan.costEstimate.manufacturingExpenses.map((l) => l.category).join() === 'MANPOWER,ELECTRICITY,OTHER' &&
    plan.costEstimate.packagingExpenses.length === 1 && plan.costEstimate.configVersion === 1);
  check('6b. Viewing the plan deducted nothing and posted no expenses',
    near(await riceStock(), stockBefore) && (await prisma.productionExpense.count({ where: { productBatch: { production: { recipeId: full.id } } } })) === 0);
  const plainPlan = await FormulationService.preview({ recipeId: plain.id, targetQty: 10, targetUnit: 'KG', warehouseId: wh.id });
  check('6c. Recipe without expenses: estimate is raw material only', near(plainPlan.costEstimate.manufacturingExpenseTotal, 0) && near(plainPlan.costEstimate.estimatedProductionCost, 1500));

  // 7–8. Start: snapshot of the recipe's expenses
  const p1 = await start(full.id, fullF.id);
  const snap = p1.expenseSnapshot as any;
  check('7. Start consumed 10 KG rice (₹1,500), planned yield 10 KG', near(p1.materialCost, 1500) && near(p1.plannedYieldQty, 10) && near(await riceStock(), stockBefore - 10));
  check('8. Snapshot saved: version 1, four enabled expenses with rates and bases',
    snap?.source === 'RECIPE' && snap.configVersion === 1 && snap.expenses.length === 4 &&
    snap.expenses.find((e: any) => e.category === 'MANPOWER').rate === 15 && snap.expenses.find((e: any) => e.category === 'PACKAGING_MATERIAL').sizeRates.length === 3, snap);

  // 16 (part 1). Edit the recipe after start: the started batch is unaffected
  await edit(fullRead, [
    { category: 'MANPOWER', enabled: true, basis: 'PER_BATCH', rate: 100 },
    { category: 'ELECTRICITY', enabled: true, basis: 'PER_KG', rate: 10 },
    { category: 'OTHER', enabled: false, basis: 'PER_BATCH', rate: 15 },
    { category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', rate: 9 },
  ]);
  check('4. Recipe expense rates edited → version 2', (await prisma.recipe.findUnique({ where: { id: full.id } }))!.expenseConfigVersion === 2);
  check('16a. Started run keeps its version-1 snapshot', JSON.stringify((await prisma.production.findUnique({ where: { id: p1.id } }))!.expenseSnapshot) === JSON.stringify(snap));

  // 9–10. Complete with a different actual yield (10 planned → 15 actual)
  const done = await ProductionService.approveProduction(p1.id, userId, 15, 'More water absorbed', undefined, undefined, { requireVarianceRemarks: true });
  check('9. Planned 10 KG kept; actual 15 KG', near(done.yield.planned, 10) && near(done.yield.actual, 15));
  check('10a. ₹1,500 raw + ₹15 + ₹15 + ₹15 = ₹1,545 total manufacturing cost',
    near(done.cost.materialCost, 1500) && near(done.cost.manufacturingExpenseTotal, 45) && near(done.cost.totalManufacturingCost, 1545), done.cost);
  check('10b. Manufacturing cost per KG = ₹1,545 / 15 = ₹103', near(done.cost.manufacturingCostPerUnit!, 103));
  const batch1 = (await prisma.productBatch.findUnique({ where: { productionId: p1.id } }))!;
  check('10c. Bulk released to packaging at ₹103/KG', near(batch1.unitCost, 103) && near(batch1.totalCost, 1545) && near(batch1.approvedQty, 15));
  const run1 = (await prisma.production.findUnique({ where: { id: p1.id } }))!;
  check('10d. Production row: materials ₹1,500, labour ₹15, overhead ₹30, total ₹1,545',
    near(run1.materialCost, 1500) && near(run1.laborCost, 15) && near(run1.overheadCost, 30) && near(run1.totalCost, 1545));
  const mfgRows = await prisma.productionExpense.findMany({ where: { productBatchId: batch1.id, stage: 'MANUFACTURING' } });
  check('10e. Three manufacturing expense records, ₹45 in total', mfgRows.length === 3 && near(mfgRows.reduce((s, r) => s + r.amount, 0), 45));
  const bulkLot = await prisma.inventoryBatch.findFirst({ where: { productBatchId: batch1.id, inventoryItem: { category: 'SEMI_FINISHED' } } });
  check('10f. Bulk stock lot valued at ₹103/KG', near(bulkLot?.unitCost, 103), bulkLot);
  check('10g. Repeated completion rejected; expenses not recognised twice',
    (await rejects(() => ProductionService.approveProduction(p1.id, userId, 15, 'again'), 'must be in progress')) === null &&
    (await prisma.productionExpense.count({ where: { productBatchId: batch1.id } })) === 3);

  // 11–12. Packaging: read-only breakdown from the snapshot
  const summary = await ProductionCostingService.getBatchCostSummary(batch1.id);
  check('12a. Cost summary: raw ₹1,500, Manpower/Electricity/Other ₹15 each, total ₹1,545, ₹103/KG',
    summary.expenseSource === 'RECIPE_SNAPSHOT' && near(summary.materialCost, 1500) && summary.manufacturingExpenses.length === 3 &&
    summary.manufacturingExpenses.every((e) => near(e.amount, 15)) && near(summary.totalManufacturingCost, 1545) && near(summary.manufacturingCostPerUnit!, 103), summary);
  check('12b. Packaging Materials shown from the snapshot (version 1 size rates), not the edited recipe',
    summary.expenseSnapshot!.configVersion === 1 && summary.packagingExpenses.length === 1 && summary.packagingExpenses[0].sizeRates.length === 3 && summary.packagingExpenses[0].rate === null);
  const mk = (size: string, price: number) => prisma.product.create({
    data: { name: `Rice Batter ${size} ${ts}`, sku: `FG-RX${ts}-${size.toUpperCase()}`, basePrice: price, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', isActive: true },
  });
  const p250 = await mk('250g', 30);
  const p500 = await mk('500g', 50);
  const p1kg = await mk('1kg', 120);
  const preview = (batchId: string, rows: any[], expenses?: any[]) => ProductionCostingService.previewPackagingCost(
    batchId, { rows, expenses },
    (s, u) => ProductionService.parseWeight(s, u),
    (tx, b, fr) => ProductionService.resolveBulkItem(tx, b, fr),
  );
  check('12c. Manual expenses at packaging are refused for this batch',
    (await rejects(() => ProductionService.packageAndConfirm({
      batchId: batch1.id, rows: [{ packetSize: '1kg', packedQty: 1, damagedQty: 0, productId: p1kg.id }],
      expenses: [{ category: 'MANPOWER', basis: 'PER_PACKET', rate: 1 }], userId,
    }), 'come from its recipe')) === null);

  // 13–14. 250g / 500g / 1kg automatic cost and profit/loss
  const pv = await preview(batch1.id, [
    { packetSize: '250g', packedQty: 8, damagedQty: 0, productId: p250.id },
    { packetSize: '500g', packedQty: 4, damagedQty: 0, productId: p500.id },
    { packetSize: '1kg', packedQty: 2, damagedQty: 0, productId: p1kg.id },
  ], [{ category: 'MANPOWER', basis: 'PER_PACKET', rate: 99 }]);
  const [r250, r500, r1kg] = pv.rows;
  check('13a. 250g = ₹25.75 + ₹2 packaging = ₹27.75', near(r250.rawMaterialPerPacket, 25.75) && near(r250.costPerGoodPacket!, 27.75), r250);
  check('13b. 500g = ₹51.50 + ₹3 packaging = ₹54.50', near(r500.costPerGoodPacket!, 54.5), r500);
  check('13c. 1kg = ₹103 + ₹5 packaging = ₹108', near(r1kg.costPerGoodPacket!, 108), r1kg);
  check('13d. Preview ignores expenses sent from the screen (₹99 manpower not applied)', !pv.rows.some((r) => r.expenses.some((e) => e.category === 'MANPOWER')));
  check('14a. 250g @ ₹30 → profit ₹2.25/pkt, ₹18 total', r250.profitStatus === 'PROFIT' && near(r250.marginPerPacket!, 2.25) && near(r250.marginTotal!, 18));
  check('14b. 500g @ ₹50 → loss ₹4.50/pkt, ₹18 total', r500.profitStatus === 'LOSS' && near(r500.marginPerPacket!, -4.5) && near(r500.marginTotal!, -18));
  check('14c. 1kg @ ₹120 → profit ₹12/pkt', r1kg.profitStatus === 'PROFIT' && near(r1kg.marginPerPacket!, 12));

  // 15. Partial packaging across sessions, with damage
  const s1 = await ProductionService.packageAndConfirm({
    batchId: batch1.id, expectedPackagedQty: 0, userId,
    rows: [
      { packetSize: '250g', packedQty: 8, damagedQty: 0, productId: p250.id },
      { packetSize: '500g', packedQty: 4, damagedQty: 0, productId: p500.id },
      { packetSize: '1kg', packedQty: 2, damagedQty: 0, productId: p1kg.id },
    ],
  });
  check('15a. Session 1 posted at the previewed cost (₹27.75 / ₹54.50 / ₹108)',
    near(s1.summary[0].unitCost, 27.75) && near(s1.summary[1].unitCost, 54.5) && near(s1.summary[2].unitCost, 108), s1.summary);
  const s2 = await ProductionService.packageAndConfirm({
    batchId: batch1.id, expectedPackagedQty: 6, userId,
    rows: [{ packetSize: '1kg', packedQty: 3, damagedQty: 1, productId: p1kg.id }],
  });
  const s2cb = s2.packaging.costBreakdown as any;
  check('15b. Session 2: 3 good + 1 damaged 1kg; ₹103×4 + ₹5×4 = ₹432 carried by 3 good = ₹144',
    near(s2cb.totalCost, 432) && near(s2cb.costPerGoodPacket, 144) && near(s2cb.damageAbsorbed, 108) && s2cb.expenseSource === 'RECIPE_SNAPSHOT', s2cb);
  const pkgCharged = await prisma.productionExpense.aggregate({ where: { productBatchId: batch1.id, stage: 'PACKAGING' }, _sum: { amount: true } });
  check('15c. Packaging Materials charged only to packets packed: 8×₹2 + 4×₹3 + 2×₹5 + 4×₹5 = ₹58', near(pkgCharged._sum.amount, 58), pkgCharged._sum);
  check('15d. Manufacturing expenses still recorded once (3 rows, ₹45)',
    (await prisma.productionExpense.count({ where: { productBatchId: batch1.id, stage: 'MANUFACTURING' } })) === 3);
  const after = await ProductionCostingService.getBatchCostSummary(batch1.id);
  check('15e. Remaining bulk 5 KG still valued at ₹103/KG (₹515)', near(after.remainingQty, 5) && near(after.bulkUnitCost!, 103) && after.sessions.length === 4);
  check('15f. Earlier session snapshots unchanged', JSON.stringify(after.sessions[0].cost) === JSON.stringify(s1.rows[0].packaging.costBreakdown));
  check('15g. Duplicate submission (stale packed qty) rejected',
    (await rejects(() => ProductionService.packageAndConfirm({ batchId: batch1.id, expectedPackagedQty: 6, userId, rows: [{ packetSize: '1kg', packedQty: 1, damagedQty: 0, productId: p1kg.id }] }), 'just updated')) === null);

  // Per KG, deferred Per Packet manufacturing, and Per Batch packaging
  const { recipe: mixed, f: mixedF } = await newRecipe('Mixed Basis', [
    { category: 'MANPOWER', enabled: true, basis: 'PER_BATCH', rate: 30 },
    { category: 'ELECTRICITY', enabled: true, basis: 'PER_KG', rate: 2 },
    { category: 'OTHER', enabled: true, basis: 'PER_PACKET', rate: 1 },
    { category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_BATCH', rate: 60 },
  ]);
  const pm1 = await start(mixed.id, mixedF.id);
  const mDone = await ProductionService.approveProduction(pm1.id, userId, 12);
  check('M1. Per KG on actual output: ₹2 × 12 KG = ₹24; Per Batch ₹30 once → ₹54',
    near(mDone.cost.manufacturingExpenseTotal, 54) && mDone.cost.manufacturingExpenses.find((l) => l.category === 'ELECTRICITY')!.baseQty === 12, mDone.cost);
  check('M2. Per Packet "Other" deferred to packaging (no packet count invented)',
    mDone.cost.deferredToPackaging.length === 1 && mDone.cost.deferredToPackaging[0].category === 'OTHER' && !mDone.cost.manufacturingExpenses.some((l) => l.category === 'OTHER'));
  const mBatch = (await prisma.productBatch.findUnique({ where: { productionId: pm1.id } }))!;
  check('M3. Bulk at (₹1,500 + ₹54) / 12 = ₹129.50/KG', near(mBatch.unitCost, 129.5));
  const pMx = await mk('1kg-mx', 200);
  const m1 = await ProductionService.packageAndConfirm({ batchId: mBatch.id, userId, rows: [{ packetSize: '1kg', packedQty: 4, damagedQty: 0, productId: pMx.id }] });
  const m1cb = m1.packaging.costBreakdown as any;
  check('M4. Session 1 (4 of 12 KG): ₹1/pkt Other + ₹20 share of ₹60 packaging → ₹129.50 + ₹1 + ₹5 = ₹135.50',
    near(m1cb.costPerGoodPacket, 135.5) && m1cb.expenses.some((e: any) => e.category === 'OTHER' && near(e.amount, 4)) &&
    m1cb.expenses.some((e: any) => e.category === 'PACKAGING_MATERIAL' && e.basis === 'PER_BATCH' && near(e.amount, 20)), m1cb);
  await ProductionService.packageAndConfirm({ batchId: mBatch.id, userId, rows: [{ packetSize: '500g', packedQty: 4, damagedQty: 0, newProduct: { name: `Mixed 500g ${ts}`, sku: `FG-MX${ts}-500G`, basePrice: 90 } }] });
  await ProductionService.packageAndConfirm({ batchId: mBatch.id, userId, rows: [{ packetSize: '1kg', packedQty: 6, damagedQty: 0, productId: pMx.id }] });
  const perBatchCharged = await prisma.productionExpense.aggregate({
    where: { productBatchId: mBatch.id, stage: 'PACKAGING', basis: 'PER_BATCH', productPackagingId: { not: null } }, _sum: { amount: true },
  });
  check('M5. ₹60 per-batch Packaging Materials charged exactly once across 3 sessions', near(perBatchCharged._sum.amount, 60), perBatchCharged._sum);
  check('M6. Batch fully packed', (await prisma.productBatch.findUnique({ where: { id: mBatch.id } }))!.packagingStatus === 'PACKAGED');

  // 16 (part 2). A run started after the edit uses version 2
  const p2 = await start(full.id, fullF.id);
  check('16b. New run snapshots version 2 (Manpower ₹100, Electricity ₹10/KG, Other disabled)',
    (p2.expenseSnapshot as any).configVersion === 2 && (p2.expenseSnapshot as any).expenses.length === 3);
  const d2 = await ProductionService.approveProduction(p2.id, userId, 10);
  check('16c. Version 2 costs: ₹100 + ₹10 × 10 KG = ₹200', near(d2.cost.manufacturingExpenseTotal, 200));
  check('16d. Batch 1 cost unchanged by the edit (₹103/KG)',
    near((await prisma.productBatch.findUnique({ where: { id: batch1.id } }))!.unitCost, 103));

  // Recipe without expenses: raw material only
  const pp = await start(plain.id, plainF.id);
  const ppDone = await ProductionService.approveProduction(pp.id, userId, 15);
  check('1b. Recipe without expenses costs raw material only (₹100/KG), no expense rows',
    near(ppDone.cost.manufacturingCostPerUnit!, 100) && (await prisma.productionExpense.count({ where: { productBatch: { productionId: pp.id } } })) === 0);

  // 10. Runs started before this change (no snapshot) behave exactly as before
  const legacy = await start(plain.id, plainF.id);
  await prisma.production.update({ where: { id: legacy.id }, data: { expenseSnapshot: Prisma.DbNull } });
  const lDone = await ProductionService.approveProduction(legacy.id, userId, 10);
  const lBatch = (await prisma.productBatch.findUnique({ where: { productionId: legacy.id } }))!;
  check('L1. Older run: no manufacturing expenses added at completion', near(lDone.cost.manufacturingExpenseTotal, 0) && near(lBatch.unitCost, 150));
  check('L2. Older run cost summary reports the legacy source', (await ProductionCostingService.getBatchCostSummary(lBatch.id)).expenseSource === 'LEGACY');
  // Bulk of plain-recipe batches is pooled: the earlier ₹100/KG batch (pp) is drawn first.
  const pPlain = await prisma.product.create({ data: { name: `Plain 1kg ${ts}`, sku: `FG-PL${ts}-1KG`, basePrice: 200, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', isActive: true } });
  const l1 = await ProductionService.packageAndConfirm({
    batchId: lBatch.id, userId, rows: [{ packetSize: '1kg', packedQty: 2, damagedQty: 0, productId: pPlain.id }],
    expenses: [{ category: 'MANPOWER', basis: 'PER_PACKET', rate: 4 }],
  });
  check('L3. Older run still accepts packaging-entered expenses (₹100 + ₹4)',
    near((l1.packaging.costBreakdown as any).costPerGoodPacket, 104) && (l1.packaging.costBreakdown as any).expenseSource === 'PACKAGING_ENTRY', l1.packaging.costBreakdown);

  // Pure helpers
  check('P1. Pack size keys: 1kg = 1000g, 0.5 kg = 500g, 1L = 1000ml',
    packSizeKey('1kg') === packSizeKey('1000g') && packSizeKey('0.5 kg') === packSizeKey('500g') && packSizeKey('1L') === packSizeKey('1000ml') && packSizeKey('2 bags') === null);
  const common = snapshotPackagingLines([{ category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', rate: 4, sizeRates: [{ packetSize: '1kg', rate: 6 }] }], [{ packetSize: '250g' }, { packetSize: '1000g' }]);
  check('P2. Common rate for sizes without their own; size rate wins (1000g = 1kg)',
    common.length === 2 && common[0].rate === 4 && common[0].row === 0 && common[1].rate === 6 && common[1].row === 1);
  const sizeOnly = snapshotPackagingLines([{ category: 'PACKAGING_MATERIAL', enabled: true, basis: 'PER_PACKET', rate: null, sizeRates: [{ packetSize: '1kg', rate: 6 }] }], [{ packetSize: '250g' }]);
  check('P3. No common rate: an unconfigured size is not charged', sizeOnly.length === 0);

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
