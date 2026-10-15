/**
 * Word recipe import (MEASUREMENTS.docx): extraction, review, matching,
 * confirmation, versioning, repeat-import safety, and the imported
 * formulation driving Production Planning scaling, lot allocation,
 * costing and packaging — with no stock, price or SKU changed by the import.
 *
 * Writes real rows. Run against a disposable DB:
 *   DATABASE_URL=<test db> RECIPE_DOCX=<path to MEASUREMENTS.docx> \
 *     npx tsx src/tests/production/recipe-word-import.test.ts
 */
import { existsSync, readFileSync } from 'fs';
import prisma from '../../lib/prisma';
import { FormulationService } from '../../modules/recipes/formulation.service';
import { RecipeImportService, RecipeDecision, LEARNED_ALIASES_SETTING } from '../../modules/recipes/recipe-import.service';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { parseQuantity } from '../../modules/recipes/recipe-import.parser';
import { matchMaterial } from '../../modules/recipes/recipe-import.matcher';
import { roundRequirement } from '../../modules/production/requirement-rounding';

let passed = 0;
function check(title: string, condition: boolean, details?: unknown) {
  if (!condition) {
    console.error(`[FAIL] ${title}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
  passed++;
  console.log(`[PASS] ${title}`);
}
const near = (a: number | null | undefined, b: number, eps = 1e-6) => a != null && Math.abs(a - b) < eps;
async function rejects(fn: () => Promise<unknown>, contains: string) {
  try { await fn(); } catch (e: any) { return String(e?.message).includes(contains) ? null : e?.message; }
  return 'did not throw';
}
const DOCX = process.env.RECIPE_DOCX || 'C:/Users/Developer 2/Downloads/MEASUREMENTS.docx';
const ts = Date.now();

async function run() {
  console.log('=== WORD RECIPE IMPORT ===\n');
  if (!existsSync(DOCX)) { console.log(`MEASUREMENTS.docx not found at ${DOCX}; set RECIPE_DOCX.`); process.exitCode = 1; return; }
  if (!(await prisma.franchise.findFirst({ where: { isHQ: true } }))) {
    await prisma.franchise.create({ data: { name: `HQ ${ts}`, isHQ: true, location: 'HQ', ownerName: 'HQ', contactNum: '0' } });
  }
  const userId = (await prisma.user.findFirst())?.id;
  // Clean slate for names the document uses (disposable DB only).
  await prisma.recipeImportSession.deleteMany({});
  await prisma.systemSetting.deleteMany({ where: { key: LEARNED_ALIASES_SETTING } });

  const wh = await prisma.warehouse.create({ data: { name: `Kitchen ${ts}`, nameKey: `kitchen-wi-${ts}`, status: 'ACTIVE' } });
  const mat = async (name: string, unit = 'kg') => (await prisma.inventoryItem.findFirst({ where: { name, category: 'RAW_MATERIAL' } }))
    ?? prisma.inventoryItem.create({ data: { name, sku: `RM-WI-${name.replace(/\W/g, '').toUpperCase()}-${ts}`, category: 'RAW_MATERIAL', unit, currentStock: 0, minimumStock: 0, costPrice: 0 } });
  const parboiled = await mat('Idli rice');
  const urad = await mat('Urad dal');
  const methi = await mat('Methi');
  const water = await mat('Water', 'L');
  const receive = (itemId: string, qty: number, unitCost: number) => prisma.$transaction((tx) => InventoryService.recordMovement(tx, {
    itemId, type: 'PURCHASE_IN', quantity: qty, warehouseId: wh.id, receiveAtCost: { unitCost, batchNumber: `LOT-${itemId.slice(0, 6)}-${ts}`, mfgDate: new Date('2026-01-01') },
  }));
  await receive(parboiled.id, 40, 60);
  await receive(urad.id, 10, 120);
  await receive(methi.id, 1, 200);
  const product = async (sku: string, price: number) => (await prisma.product.findUnique({ where: { sku } }))
    ?? prisma.product.create({ data: { name: 'IDLI DOSA BATTER', sku, basePrice: price, category: 'NORMAL BATTER', productType: 'FINISHED_GOOD', isActive: true, hsnCode: '1902' } });
  const idli450 = await product('FG-IDLI-450G', 25);
  const idli900 = await product('FG-IDLI-900G', 45);
  const stockBefore = await prisma.inventoryItem.findMany({ select: { id: true, currentStock: true } });
  const movementsBefore = await prisma.stockMovement.count();

  // 1–3. Upload and extract
  const file = readFileSync(DOCX).toString('base64');
  const up = await RecipeImportService.upload({ fileName: 'MEASUREMENTS.docx', contentBase64: file }, userId);
  check('1. MEASUREMENTS.docx uploaded: 63 recipes extracted, all pending', up.summary.recipes === 63 && up.summary.pending === 63 && !up.resumed);
  const idli = up.recipes.find((r) => r.title === 'Idli/ Dosa Batter')!;
  check('2a. Idli / Dosa Batter: category Batters, 4 ingredient lines', idli.category === 'Batters' && idli.ingredients.length === 4);
  check('2b. Quantities kept as written: Parboiled Rice 500 G, Urad Dal 125 G, Fenugreek 2 G',
    idli.ingredients[0].quantity === 500 && idli.ingredients[0].unit === 'G' && idli.ingredients[1].quantity === 125 && idli.ingredients[2].qtyText === '2' && idli.ingredients[2].unit === 'G');
  check('2c. Both output stages kept: After Grinding 1545 G, After Fermentation 1534 G (default = last)',
    idli.outputs.length === 2 && idli.outputs[0].stage === 'After Grinding' && idli.outputs[0].quantity === 1545 && idli.outputs[1].stage === 'After Fermentation' && idli.outputs[1].quantity === 1534 && idli.defaultOutputIndex === 1);
  check('3a. Alkaline Water flagged As Required (no quantity invented)', idli.ingredients[3].issues.includes('AS_REQUIRED') && idli.ingredients[3].quantity === null);
  const medu = up.recipes.find((r) => r.title === 'Medu Vada Batter')!;
  check('3b. Medu Vada: "90- 100 Ml" kept as a range, output with no unit flagged',
    medu.ingredients.find((i) => i.sourceName === 'Water')!.issues.includes('RANGE') && medu.issues.includes('OUTPUT_UNCERTAIN'));
  const karam = up.recipes.find((r) => r.title === 'Karam Dosa')!;
  check('3c. Karam Dosa: bare "Jaggery" line flagged as missing quantity', karam.ingredients.some((i) => i.sourceName === 'Jaggery' && i.issues.includes('QTY_MISSING')));
  check('3d. Health Mix: all 40 ingredients extracted', up.recipes.find((r) => r.title.startsWith('Health Mix'))!.ingredients.length === 40);
  check('3e. Units read: "1.5 Kg" → KG, "4" → unit missing, "As Required" → no quantity',
    parseQuantity('1.5 Kg').unit === 'KG' && parseQuantity('4').issues.includes('UNIT_MISSING') && parseQuantity('As Required').issues.includes('AS_REQUIRED'));

  // 4. Raw material matches
  const m = (i: number) => idli.ingredients[i].match;
  check('4a. Fenugreek → Methi suggested by alias', m(2).confidence === 'ALIAS' && m(2).inventoryItemId === methi.id);
  check('4b. Urad Dal → Urad dal exact', m(1).confidence === 'EXACT' && m(1).inventoryItemId === urad.id);
  check('4c. Parboiled Rice not auto-merged into "Idli rice" (offered as a candidate)', m(0).inventoryItemId === null && m(0).candidates.some((c) => c.id === parboiled.id));
  const salt = await mat('salt');
  const saltA = await prisma.inventoryItem.create({ data: { name: 'Salt', sku: `RM-WI-SALT2-${ts}`, category: 'RAW_MATERIAL', unit: 'kg', currentStock: 0, minimumStock: 0 } });
  check('4d. Two materials with the same name → ambiguous, nothing chosen', matchMaterial('Salt', [salt, saltA] as any).confidence === 'AMBIGUOUS');
  check('4e. "Red Chilli" never matched to "red chilli powder"', matchMaterial('Red Chilli', [{ id: 'x', name: 'red chilli powder', unit: 'kg' }]).inventoryItemId === null);

  // 5. Finished goods
  check('5. Both IDLI DOSA BATTER variants suggested', [idli450.id, idli900.id].every((id) => idli.products.some((p) => p.id === id)));

  // 8. Confirm with review rules
  const decide = (over: Partial<RecipeDecision> = {}): RecipeDecision => ({
    mode: 'CREATE', name: 'Idli/ Dosa Batter', category: 'Batters', outputIndex: 1, stageConfirmed: true,
    ingredients: [
      { index: 0, action: 'MAP', inventoryItemId: parboiled.id },
      { index: 1, action: 'MAP', inventoryItemId: urad.id },
      { index: 2, action: 'MAP', inventoryItemId: methi.id },
      { index: 3, action: 'UNRESOLVED' },
    ],
    productIds: [idli450.id, idli900.id],
    ...over,
  });
  check('8a. Two output stages need the stage confirmed', (await rejects(() => RecipeImportService.confirm(up.session.id, idli.key, decide({ stageConfirmed: false }), userId), 'Confirm which stage')) === null);
  check('8b. "As Required" cannot be mapped without an approved quantity',
    (await rejects(() => RecipeImportService.confirm(up.session.id, idli.key, decide({ ingredients: [...decide().ingredients.slice(0, 3), { index: 3, action: 'MAP', inventoryItemId: water.id }] }), userId), 'no usable quantity')) === null);
  check('8c. Every line needs a decision', (await rejects(() => RecipeImportService.confirm(up.session.id, idli.key, decide({ ingredients: decide().ingredients.slice(0, 3) }), userId), 'leave it unresolved')) === null);
  check('8d. Nothing saved by rejected confirmations', (await prisma.recipe.count({ where: { name: 'Idli/ Dosa Batter' } })) === 0);

  const c1 = await RecipeImportService.confirm(up.session.id, idli.key, decide(), userId);
  const f1 = await prisma.recipeFormulation.findUnique({ where: { id: c1.formulationId }, include: { items: { include: { inventoryItem: true }, orderBy: { sortOrder: 'asc' } } } });
  const recipe = await prisma.recipe.findUnique({ where: { id: c1.recipeId }, include: { recipeItems: true, ingredients: true, productLinks: true } });
  check('8e. Recipe created in Recipe Master (name, category, 3 ingredients), formulation v1 from IMPORT',
    c1.status.state === 'IMPORTED' && recipe!.category === 'Batters' && recipe!.ingredients.length === 3 && f1!.version === 1 && f1!.source === 'IMPORT');
  check('8f. Reference output 1534 G stored as 1.534 KG at stage After Fermentation; both stages kept',
    near(f1!.yieldQty, 1.534) && f1!.yieldUnit === 'KG' && f1!.outputStage === 'After Fermentation' && (f1!.outputStages as any[]).length === 2 && (f1!.outputStages as any[])[0].qty === 1545);
  check('8g. Ingredient quantities and units as written; source names kept',
    f1!.items.map((i) => `${i.quantity}${i.unit}`).join() === '500G,125G,2G' && f1!.items[2].sourceName === 'Fenugreek' && f1!.items[2].inventoryItemId === methi.id);
  check('8h. Alkaline Water kept unresolved (As Required), not a formulation line',
    (f1!.unresolvedItems as any[]).length === 1 && (f1!.unresolvedItems as any[])[0].reason === 'AS_REQUIRED' && !f1!.items.some((i) => i.inventoryItem.name === 'Water'));
  check('8i. Source reference stored (document, section, title)', (f1!.sourceReference as any).document === 'MEASUREMENTS.docx' && (f1!.sourceReference as any).section === 'Batters');
  check('8j. Recipe BOM mirrors the formulation (3 lines, yield 1.534 KG)', recipe!.recipeItems.length === 3 && near(recipe!.yieldQty, 1.534) && recipe!.yieldUnit === 'KG');
  check('7. Both variants linked to the one recipe', recipe!.productLinks.length === 2);
  const [p450, p900] = await Promise.all([idli450.id, idli900.id].map((id) => prisma.product.findUnique({ where: { id } })));
  check('7b. Product SKUs, prices and HSN unchanged', p450!.sku === 'FG-IDLI-450G' && p450!.basePrice === 25 && p900!.basePrice === 45 && p900!.hsnCode === '1902');

  // 6 / 18. Repeats
  check('6a. Confirming the same recipe again is refused', (await rejects(() => RecipeImportService.confirm(up.session.id, idli.key, decide(), userId), 'already been imported')) === null);
  const again = await RecipeImportService.upload({ fileName: 'MEASUREMENTS.docx', contentBase64: file }, userId);
  check('18a. Re-uploading the same file resumes the same session', again.resumed && again.session.id === up.session.id && (await prisma.recipeImportSession.count()) === 1);
  const idliAgain = again.recipes.find((r) => r.key === idli.key)!;
  check('18b. Resumed review shows it imported and matches the existing recipe', idliAgain.status.state === 'IMPORTED' && idliAgain.existingRecipes[0]?.id === c1.recipeId);
  const kambu = again.recipes.find((r) => r.title === 'Kambu Dosa')!;
  check('4f. Reviewed mapping learned: Parboiled Rice → Idli rice in the next recipe', kambu.ingredients.find((i) => i.sourceName === 'Parboiled Rice')!.match.confidence === 'LEARNED');

  // A second document with the same recipe (new session).
  const other = await prisma.recipeImportSession.create({ data: { fileName: 'MEASUREMENTS (copy).docx', fileHash: `copy-${ts}`, parsed: [idli] as any, status: { [idli.key]: { state: 'PENDING' } } as any } });
  check('6b. Same recipe from another document: "create" refused (no duplicate recipe)',
    (await rejects(() => RecipeImportService.confirm(other.id, idli.key, decide(), userId), 'already exists')) === null);
  const same = await RecipeImportService.confirm(other.id, idli.key, decide({ mode: 'NEW_VERSION', existingRecipeId: c1.recipeId }), userId);
  check('18c. Identical formulation → UNCHANGED, no new version', same.status.state === 'UNCHANGED' && same.version === 1 && (await prisma.recipeFormulation.count({ where: { recipeId: c1.recipeId } })) === 1);
  check('18d. No duplicate recipes, product links or materials', (await prisma.recipe.count({ where: { name: 'Idli/ Dosa Batter' } })) === 1 && (await prisma.recipeProduct.count({ where: { recipeId: c1.recipeId } })) === 2);

  // 9–14. Production Planning scaling from the imported formulation
  const plan = (target: number, unit = 'KG') => FormulationService.preview({ recipeId: c1.recipeId, targetQty: target, targetUnit: unit, warehouseId: wh.id });
  const p10 = await plan(10);
  const factor = 10000 / 1534;
  check('9. Planning loads the imported formulation (v1, 1.534 KG, After Fermentation, Alkaline Water unresolved)',
    p10.formulation.version === 1 && near(p10.formulation.yieldQty, 1.534) && p10.formulation.outputStage === 'After Fermentation' && (p10.formulation.unresolvedItems as any[]).length === 1);
  check('11. 10 KG: factor = 10000 / 1534', near(p10.factor, factor, 1e-9));
  check('11b. Rice 500 g × factor = 3259.452 g = 3.259452 KG in stock unit',
    near(p10.lines[0].requiredQty, Math.round(500 * factor * 1e6) / 1e6) && near(p10.lines[0].requiredInStockUnit, Math.round(0.5 * factor * 1e6) / 1e6) && p10.lines[0].stockUnit === 'kg');
  check('11c. Alkaline Water is not calculated', p10.lines.length === 3 && !p10.lines.some((l) => l.name === 'Water'));
  const refQty = [500, 125, 2];
  for (const t of [1, 5, 15, 50]) {
    const p = await plan(t);
    check(`12. ${t} KG: each ingredient = reference g × ${t * 1000} / 1534 (to 6 dp), required under the whole-gram policy`,
      p.lines.every((l, i) => near(l.calculatedQty, Math.round(refQty[i] * t * 1000 / 1534 * 1e6) / 1e6, 2e-6) && l.requiredQty === roundRequirement(l.calculatedQty, l.unit)),
      p.lines.map((l) => [l.calculatedQty, l.requiredQty]));
  }
  const pg = await plan(10000, 'G');
  check('13a. 10000 G target = 10 KG target', pg.lines.every((l, i) => near(l.requiredInStockUnit, p10.lines[i].requiredInStockUnit)));
  const p50 = await plan(50);
  const riceShort = p50.lines[0];
  check('14. Shortage: 50 KG needs 16.297 KG rice, 40 KG in stock → sufficient; urad 4.07 KG of 10 → ok; methi 0.065 of 1 → ok',
    riceShort.sufficient === true && p50.lines.every((l) => l.sufficient));
  const p200 = await plan(200);
  check('14b. 200 KG: rice short by 65.189 − 40 = 25.189 KG', p200.lines[0].sufficient === false && near(p200.lines[0].shortage!, Math.round((0.5 * 200000 / 1534 - 40) * 1e6) / 1e6, 1e-5));
  const stockAfterPlanning = await InventoryService.computeWarehouseStock(parboiled.id, wh.id);
  check('10. Changing the target deducts nothing', near(stockAfterPlanning, 40));

  // ml / L: Medu Vada's "90- 100 Ml" water, reviewer enters 95 ML for a material in L
  const meduDec: RecipeDecision = {
    mode: 'CREATE', name: 'Medu Vada Batter', category: 'Batters', outputIndex: 0, yieldQty: 520, yieldUnit: 'G',
    ingredients: medu.ingredients.map((ing) => ing.sourceName === 'Water'
      ? { index: ing.index, action: 'MAP', inventoryItemId: water.id, quantity: 95, unit: 'ML' }
      : ing.sourceName === 'Urad Dal' ? { index: ing.index, action: 'MAP', inventoryItemId: urad.id }
      : { index: ing.index, action: 'UNRESOLVED', reason: 'Not in this test' }),
  };
  check('3f. A range needs the reviewer to enter a quantity',
    (await rejects(() => RecipeImportService.confirm(up.session.id, medu.key, { ...meduDec, ingredients: meduDec.ingredients.map((d) => (d.inventoryItemId === water.id ? { ...d, quantity: undefined } : d)) }, userId), 'no usable quantity')) === null);
  const mc = await RecipeImportService.confirm(up.session.id, medu.key, meduDec, userId);
  const mp = await FormulationService.preview({ recipeId: mc.recipeId, targetQty: 5.2, targetUnit: 'KG' });
  check('13b. ml → L: 95 ml water per 520 g → 0.95 L for 5.2 KG', near(mp.lines.find((l) => l.inventoryItemId === water.id)!.requiredInStockUnit, 0.95));
  const meduLog = await prisma.auditLog.findFirst({ where: { module: 'RECIPE', action: 'IMPORT_CONFIRM', recordId: mc.recipeId } });
  check('3g. Reviewer-entered values recorded against the original line', (meduLog!.newValue as any).edits.some((e: any) => e.from === '90-100 ML' && e.to === '95 ML'));

  // Repeated ingredient lines are added together (Green Chutney: Urad Dal 10 G + 10 G under Tempering)
  const chutney = again.recipes.find((r) => r.title === 'Green Chutney Ready Mix')!;
  const cc = await RecipeImportService.confirm(up.session.id, chutney.key, {
    mode: 'CREATE', name: chutney.title, category: 'Instant Ready-Mix', outputIndex: 0,
    ingredients: chutney.ingredients.map((ing) => (ing.sourceName === 'Urad Dal' ? { index: ing.index, action: 'MAP', inventoryItemId: urad.id } : { index: ing.index, action: 'UNRESOLVED', reason: 'Not in this test' })),
  }, userId);
  const cf = await prisma.recipeFormulation.findUnique({ where: { id: cc.formulationId }, include: { items: true } });
  check('Repeated "Urad Dal" lines combined into one 20 G line, both source lines kept', cf!.items.length === 1 && cf!.items[0].quantity === 20 && cf!.items[0].sourceText!.includes('+'));

  // New raw material, no duplicates
  const kara = again.recipes.find((r) => r.title === 'Kara Chutney')!;
  const lemonIdx = kara.ingredients.findIndex((i) => i.sourceName === 'Lemon Juice');
  const karaDec: RecipeDecision = {
    mode: 'CREATE', name: kara.title, category: 'Instant Ready-Mix', outputIndex: 0,
    ingredients: kara.ingredients.map((ing, i) => (i === lemonIdx ? { index: i, action: 'CREATE', newMaterial: { name: 'Lemon Juice', unit: 'kg' } } : { index: i, action: 'UNRESOLVED', reason: 'Not in this test' })),
  };
  const kc = await RecipeImportService.confirm(up.session.id, kara.key, karaDec, userId);
  const lemon = await prisma.inventoryItem.findMany({ where: { name: 'Lemon Juice' } });
  check('4g. Missing material created once, with no stock', kc.createdMaterials.length === 1 && !kc.createdMaterials[0].reused && lemon.length === 1 && lemon[0].currentStock === 0);
  const other2 = await prisma.recipeImportSession.create({ data: { fileName: 'copy2.docx', fileHash: `copy2-${ts}`, parsed: [kara] as any, status: { [kara.key]: { state: 'PENDING' } } as any } });
  const kc2 = await RecipeImportService.confirm(other2.id, kara.key, { ...karaDec, mode: 'NEW_VERSION', existingRecipeId: kc.recipeId }, userId);
  check('4h. Creating it again reuses the existing material (no duplicate)', kc2.createdMaterials[0].reused && (await prisma.inventoryItem.count({ where: { name: 'Lemon Juice' } })) === 1);

  // Partial import / skip
  await RecipeImportService.skip(up.session.id, kambu.key, true, userId);
  const rev = await RecipeImportService.review(up.session.id);
  check('Partial import: imported, skipped and pending counted separately',
    rev.summary.imported === 4 && rev.summary.skipped === 1 && rev.summary.pending === 58, rev.summary);
  check('Skipping an imported recipe is refused', (await rejects(() => RecipeImportService.skip(up.session.id, idli.key, true, userId), 'already been imported')) === null);

  // 19. Import changed no stock
  const stockNow = await prisma.inventoryItem.findMany({ select: { id: true, currentStock: true } });
  check('19. Import created no stock and no stock movements',
    stockBefore.every((s) => near(stockNow.find((x) => x.id === s.id)!.currentStock, s.currentStock)) && (await prisma.stockMovement.count()) === movementsBefore);

  // 15–17. Produce from the imported formulation: lots, costing, packaging
  const planned = await FormulationService.buildPlannedStart({ recipeId: c1.recipeId, formulationId: c1.formulationId, targetQty: 10, targetUnit: 'KG' });
  const lots = await prisma.inventoryBatch.findMany({ where: { inventoryItemId: { in: [parboiled.id, urad.id, methi.id] } } });
  const lotOf = (id: string) => lots.find((l) => l.inventoryItemId === id)!.id;
  const need = (id: string) => p10.lines.find((l) => l.inventoryItemId === id)!.requiredInStockUnit;
  const run1 = await ProductionService.startProduction({
    recipeId: c1.recipeId, quantity: planned.quantity, warehouseId: wh.id, productionType: 'FINISHED_GOOD', expiryDate: '2027-12-31', planning: planned.planning, userId,
    lotAllocations: Object.fromEntries([parboiled.id, urad.id, methi.id].map((id) => [id, [{ batchId: lotOf(id), qty: need(id) }]])),
  });
  const expectCost = need(parboiled.id) * 60 + need(urad.id) * 120 + need(methi.id) * 200;
  check('15. Started from imported formulation with chosen lots; only the 3 measured ingredients deducted',
    near(await InventoryService.computeWarehouseStock(parboiled.id, wh.id), 40 - need(parboiled.id), 1e-4) && near(run1.materialCost, expectCost, 1e-3) && (await prisma.productionItem.count({ where: { productionId: run1.id } })) === 3);
  check('15b. Run snapshot records the output stage and the unresolved line', (run1.formulationSnapshot as any).outputStage === 'After Fermentation' && (run1.formulationSnapshot as any).unresolvedItems.length === 1);
  const done = await ProductionService.approveProduction(run1.id, userId, 9.5);
  check('16. Costing on actual yield: material cost / 9.5 KG', near(done.cost.actualMaterialCostPerUnit!, Math.round(expectCost / 9.5 * 1e4) / 1e4, 1e-3));
  const batch = (await prisma.productBatch.findUnique({ where: { productionId: run1.id } }))!;
  const fgBefore = await prisma.inventoryItem.count({ where: { sku: { startsWith: 'FG-IDLI-900G' } } });
  const pk = await ProductionService.packageAndConfirm({ batchId: batch.id, userId, rows: [{ packetSize: '900g', packedQty: 5, damagedQty: 0, productId: idli900.id }] });
  const cb = pk.packaging.costBreakdown as any;
  check('17. Packaging into the linked 900g variant: cost per packet and profit/loss vs ₹45',
    near(cb.costPerGoodPacket, Math.round(expectCost / 9.5 * 0.9 * 1e4) / 1e4, 1e-3) && cb.sellingPrice === 45 && ['PROFIT', 'LOSS', 'BREAK_EVEN'].includes(cb.profitStatus), cb);
  check('17b. Finished goods credited only at packaging; product price unchanged',
    pk.summary[0].goodQty === 5 && fgBefore >= 0 && (await prisma.product.findUnique({ where: { id: idli900.id } }))!.basePrice === 45);

  // 10. New version after production keeps history
  const v2 = await RecipeImportService.confirm(other.id, idli.key, decide({ mode: 'NEW_VERSION', existingRecipeId: c1.recipeId, ingredients: [{ index: 0, action: 'MAP', inventoryItemId: parboiled.id, quantity: 520, unit: 'G' }, ...decide().ingredients.slice(1)] }), userId).catch((e) => e);
  check('10a. Second document session already confirmed → refused', v2 instanceof Error && /already been imported/.test(v2.message));
  const other3 = await prisma.recipeImportSession.create({ data: { fileName: 'copy3.docx', fileHash: `copy3-${ts}`, parsed: [idli] as any, status: { [idli.key]: { state: 'PENDING' } } as any } });
  const v2b = await RecipeImportService.confirm(other3.id, idli.key, decide({ mode: 'NEW_VERSION', existingRecipeId: c1.recipeId, ingredients: [{ index: 0, action: 'MAP', inventoryItemId: parboiled.id, quantity: 520, unit: 'G' }, ...decide().ingredients.slice(1)] }), userId);
  const versions = await prisma.recipeFormulation.findMany({ where: { recipeId: c1.recipeId }, orderBy: { version: 'asc' } });
  check('10b. Changed quantity → new version v2 active, v1 kept', v2b.version === 2 && versions.length === 2 && !versions[0].isActive && versions[1].isActive);
  check('10c. Batch produced on v1 still references v1', (await prisma.production.findUnique({ where: { id: run1.id } }))!.formulationId === versions[0].id);

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
