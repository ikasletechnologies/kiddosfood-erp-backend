/**
 * Purchase lot-wise production costing & packaging unit cost (spec Phase 9).
 *
 * Writes real rows (uniquely named per run). Run against a disposable DB:
 *   DATABASE_URL=<test db> npx tsx src/tests/production/lot-wise-production-costing.test.ts
 */
import prisma from '../../lib/prisma';
import { cleanupTestRun } from '../fixture-cleanup';
import { Prisma } from '@prisma/client';
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
async function rejects(fn: () => Promise<unknown>, contains: string) {
  try { await fn(); } catch (e: any) { return String(e?.message).includes(contains) ? null : e?.message; }
  return 'did not throw';
}
const ts = Date.now();

async function run() {
  console.log('=== LOT-WISE PRODUCTION COSTING ===\n');
  if (!(await prisma.franchise.findFirst({ where: { isHQ: true } }))) {
    await prisma.franchise.create({ data: { name: `HQ ${ts}`, isHQ: true, location: 'HQ', ownerName: 'HQ', contactNum: '0' } });
  }
  const userId = (await prisma.user.findFirst())?.id;
  const wh = await prisma.warehouse.create({ data: { name: `Kitchen ${ts}`, nameKey: `kitchen-lc-${ts}`, status: 'ACTIVE' } });
  const wh2 = await prisma.warehouse.create({ data: { name: `Store ${ts}`, nameKey: `store-lc-${ts}`, status: 'ACTIVE' } });
  const rice = await prisma.inventoryItem.create({
    data: { name: `Rice ${ts}`, sku: `RM-RICE-LC-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 0, costPrice: 0 },
  });
  const receive = (qty: number, unitCost: number, batchNumber: string, mfgDate: Date, warehouseId = wh.id) =>
    prisma.$transaction((tx) => InventoryService.recordMovement(tx, {
      itemId: rice.id, type: 'PURCHASE_IN', quantity: qty, warehouseId, receiveAtCost: { unitCost, batchNumber, mfgDate },
    }));

  // 1–2. Lot A 10 KG @ ₹100, Lot B 10 KG @ ₹200
  await receive(10, 100, `LOT-A-${ts}`, new Date('2026-01-01'));
  await receive(10, 200, `LOT-B-${ts}`, new Date('2026-02-01'));
  const lotA = (await prisma.inventoryBatch.findFirst({ where: { batchNumber: `LOT-A-${ts}` } }))!;
  const lotB = (await prisma.inventoryBatch.findFirst({ where: { batchNumber: `LOT-B-${ts}` } }))!;

  const recipe = await RecipeService.saveSimplifiedRecipe({ name: `Rice Batter ${ts}`, category: 'Batters', ingredientIds: [rice.id] });
  const f = await FormulationService.saveVersion(recipe!.id, { yieldQty: 10, yieldUnit: 'KG', items: [{ inventoryItemId: rice.id, quantity: 10, unit: 'KG' }] });
  // Runs here use packaging-entered expenses, i.e. runs started before
  // expenses moved to Recipe Master (no expense snapshot). Recipe-snapshot
  // costing is covered by recipe-additional-expenses.test.ts.
  const start = async (lotAllocations?: Record<string, Array<{ batchId: string | null; qty: number }>>, target = 10) => {
    const planned = await FormulationService.buildPlannedStart({ recipeId: recipe!.id, formulationId: f.id, targetQty: target, targetUnit: 'KG' });
    const run = await ProductionService.startProduction({
      recipeId: recipe!.id, quantity: planned.quantity, warehouseId: wh.id, productionType: 'FINISHED_GOOD',
      expiryDate: '2027-12-31', planning: planned.planning, lotAllocations, userId,
    });
    return prisma.production.update({ where: { id: run.id }, data: { expenseSnapshot: Prisma.DbNull } });
  };
  const qtyOf = async (id: string) => (await prisma.inventoryBatch.findUnique({ where: { id } }))!.currentQty;

  // Lot options: both lots, oldest first, with supplier/cost/availability
  const [opt] = await ProductionCostingService.getLotOptions([rice.id], wh.id);
  check('L. Lot options list both lots oldest-first with cost and availability',
    opt.lots.length === 2 && opt.lots[0].id === lotA.id && near(opt.lots[0].unitCost, 100) && near(opt.lots[1].unitCost, 200) && near(opt.lots[1].availableQty, 10) && near(opt.untrackedQty, 0), opt);

  // Allocation validation (nothing deducted on failure)
  check('V1. Allocation not matching the requirement is rejected',
    (await rejects(() => start({ [rice.id]: [{ batchId: lotA.id, qty: 4 }, { batchId: lotB.id, qty: 5 }] }), 'must equal the requirement')) === null);
  check('V2. Allocation above a lot\'s stock is rejected',
    (await rejects(() => start({ [rice.id]: [{ batchId: lotA.id, qty: 12 }] }, 12), 'only has 10')) === null);
  const blocked = await prisma.inventoryBatch.create({ data: { inventoryItemId: rice.id, batchNumber: `LOT-X-${ts}`, initialQty: 10, currentQty: 10, unitCost: 50, warehouseId: wh.id, status: 'BLOCKED' } });
  const expired = await prisma.inventoryBatch.create({ data: { inventoryItemId: rice.id, batchNumber: `LOT-E-${ts}`, initialQty: 10, currentQty: 10, unitCost: 50, warehouseId: wh.id, status: 'APPROVED', expDate: new Date('2025-01-01') } });
  const otherWh = await prisma.inventoryBatch.create({ data: { inventoryItemId: rice.id, batchNumber: `LOT-W-${ts}`, initialQty: 10, currentQty: 10, unitCost: 50, warehouseId: wh2.id, status: 'APPROVED' } });
  check('V3. Blocked (recalled/quarantined) lot is rejected', (await rejects(() => start({ [rice.id]: [{ batchId: blocked.id, qty: 10 }] }), 'blocked')) === null);
  check('V4. Expired lot is rejected', (await rejects(() => start({ [rice.id]: [{ batchId: expired.id, qty: 10 }] }), 'expired')) === null);
  check('V5. Lot in another warehouse is rejected', (await rejects(() => start({ [rice.id]: [{ batchId: otherWh.id, qty: 10 }] }), 'different warehouse')) === null);
  check('V6. Failed starts deducted nothing', near(await qtyOf(lotA.id), 10) && near(await qtyOf(lotB.id), 10) && (await prisma.production.count({ where: { recipeId: recipe!.id } })) === 0);
  const [opt2] = await ProductionCostingService.getLotOptions([rice.id], wh.id);
  check('V7. Blocked, expired and other-warehouse lots are not offered', opt2.lots.length === 2);

  // 3–6. Start with 5 KG from each lot → ₹1,500
  const p1 = await start({ [rice.id]: [{ batchId: lotA.id, qty: 5 }, { batchId: lotB.id, qty: 5 }] });
  check('5. Material cost = 5×100 + 5×200 = ₹1,500', near(p1.materialCost, 1500), p1.materialCost);
  check('6. Each lot deducted by exactly 5 KG', near(await qtyOf(lotA.id), 5) && near(await qtyOf(lotB.id), 5));
  const item1 = (await prisma.productionItem.findFirst({ where: { productionId: p1.id } }))!;
  const bd = item1.batchBreakdown as any[];
  check('6b. Consumption keeps both lot IDs and their own unit costs', bd.length === 2 &&
    bd.some((b) => b.batchId === lotA.id && near(b.qty, 5) && near(b.unitCost, 100) && b.selectedBy === 'OPERATOR') &&
    bd.some((b) => b.batchId === lotB.id && near(b.qty, 5) && near(b.unitCost, 200)), bd);
  const outMv = await prisma.stockMovement.findMany({ where: { referenceId: p1.id, movementType: 'PRODUCTION_OUT' } });
  check('6c. One stock movement for 10 KG with the per-lot breakdown', outMv.length === 1 && near(outMv[0].baseQty, -10) && (outMv[0].consumptionBreakdown as any[])?.length === 2);

  // 7–9. Planned 10 → actual 15: ₹150/KG planned, ₹100/KG actual
  const done = await ProductionService.approveProduction(p1.id, userId, 15, 'More water absorbed', undefined, undefined, { requireVarianceRemarks: true });
  check('7. Planned yield stays 10 KG; actual 15 KG', near(done.yield.planned, 10) && near(done.yield.actual, 15));
  check('9. Actual material cost/KG = ₹100; planned = ₹150', near(done.cost.actualMaterialCostPerUnit, 100) && near(done.cost.plannedMaterialCostPerUnit, 150), done.cost);
  check('9b. No extra raw material deducted at completion', near(await qtyOf(lotA.id), 5) && near(await qtyOf(lotB.id), 5));
  const batch1 = (await prisma.productBatch.findUnique({ where: { productionId: p1.id } }))!;
  check('9c. Bulk released at ₹100/KG', near(batch1.unitCost, 100) && near(batch1.approvedQty, 15));

  // Finished products (selling prices)
  const mk = (size: string, price: number) => prisma.product.create({
    data: { name: `Rice Batter ${size} ${ts}`, sku: `FG-RB${ts}-${size.toUpperCase()}`, basePrice: price, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', isActive: true },
  });
  const p500 = await mk('500g', 80);
  const p250 = await mk('250g', 45);
  const p1kg = await mk('1kg', 150);
  const perPacket5 = [
    { category: 'MANPOWER', basis: 'PER_PACKET', rate: 1 },
    { category: 'ELECTRICITY', basis: 'PER_PACKET', rate: 1 },
    { category: 'OTHER', basis: 'PER_PACKET', rate: 1 },
    { category: 'PACKAGING_MATERIAL', basis: 'PER_PACKET', rate: 2 },
  ];
  const preview = (batchId: string, rows: any[], expenses: any[]) => ProductionCostingService.previewPackagingCost(
    batchId, { rows, expenses },
    (s, u) => ProductionService.parseWeight(s, u),
    (tx, b, fr) => ProductionService.resolveBulkItem(tx, b, fr),
  );

  // 10–13. 500g with ₹5/packet of expenses → ₹55
  const pv = await preview(batch1.id, [{ packetSize: '500g', packedQty: 10, productId: p500.id }], perPacket5);
  check('13. Preview: raw ₹50 + ₹5 expenses = ₹55 per 500g packet; margin ₹25',
    near(pv.rows[0].rawMaterialPerPacket, 50) && near(pv.rows[0].costPerPacket, 55) && near(pv.rows[0].marginPerPacket, 25) && near(pv.rows[0].marginPct!, 31.25), pv.rows[0]);
  const c1 = await ProductionService.packageAndConfirm({
    batchId: batch1.id, rows: [{ packetSize: '500g', packedQty: 10, damagedQty: 0, productId: p500.id }], expenses: perPacket5, userId,
  });
  const fg500 = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: c1.retailItem.id, productBatchId: batch1.id } });
  check('13b. Confirmed: 10 × 500g credited to stock at ₹55 each', near(fg500!.currentQty, 10) && near(fg500!.unitCost, 55), fg500);
  const cb = (await prisma.productPackaging.findUnique({ where: { id: c1.packaging.id } }))!.costBreakdown as any;
  check('13c. Cost breakdown saved on the packaging run (₹500 material + ₹50 expenses)', near(cb.rawMaterialCost, 500) && near(cb.expenseTotal, 50) && near(cb.stockUnitCost, 55), cb);
  check('13d. Four expense lines recorded for the run', (await prisma.productionExpense.count({ where: { productPackagingId: c1.packaging.id } })) === 4);
  const p500Preview = pv.rows[0].costPerPacket;
  check('13e. Preview matched the posted cost', near(p500Preview, fg500!.unitCost!));

  // 14–15. 250g and 1kg in one confirmation, each costed separately
  const c2 = await ProductionService.packageAndConfirm({
    batchId: batch1.id, expectedPackagedQty: 5, expenses: perPacket5, userId,
    rows: [
      { packetSize: '250g', packedQty: 4, damagedQty: 0, productId: p250.id },
      { packetSize: '1kg', packedQty: 2, damagedQty: 0, productId: p1kg.id },
    ],
  });
  const fgOf = async (r: any) => (await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: r.retailItem.id, productBatchId: batch1.id } }))!;
  check('14. 250g = ₹25 + ₹5 = ₹30; 1kg = ₹100 + ₹5 = ₹105', near((await fgOf(c2.rows[0])).unitCost, 30) && near((await fgOf(c2.rows[1])).unitCost, 105));

  // Damaged packets: carried by the good packets of the same row (explicit policy)
  const c3 = await ProductionService.packageAndConfirm({
    batchId: batch1.id, expenses: perPacket5, userId,
    rows: [{ packetSize: '500g', packedQty: 8, damagedQty: 2, productId: p500.id }],
  });
  const cb3 = c3.packaging.costBreakdown as any;
  check('D. 8 good + 2 damaged: ₹550 / 8 = ₹68.75 per good packet; ₹110 damage absorbed shown',
    near(cb3.costPerPacket, 55) && near(cb3.costPerGoodPacket, 68.75) && near(cb3.damageAbsorbed, 110) && near(cb3.stockUnitCost, 68.75), cb3);
  const dmgWaste = await prisma.wasteEntry.findMany({ where: { productPackagingId: c3.packaging.id } });
  check('D2. Damaged packets recorded separately as waste', dmgWaste.length === 1 && near(dmgWaste[0].quantity, 2));

  // 16–17. Partial packaging over sessions with a shared per-batch expense
  await receive(30, 120, `LOT-C-${ts}`, new Date('2026-03-01'));
  const lotC = (await prisma.inventoryBatch.findFirst({ where: { batchNumber: `LOT-C-${ts}` } }))!;
  const p2 = await start({ [rice.id]: [{ batchId: lotC.id, qty: 10 }] });
  check('16a. Second run from Lot C only: ₹1,200', near(p2.materialCost, 1200) && near(await qtyOf(lotC.id), 20) && near(await qtyOf(lotA.id), 5));
  // Batch 1 has 2 KG of bulk left; finish it first so batch 2 draws its own bulk.
  await ProductionService.packageAndConfirm({ batchId: batch1.id, rows: [{ packetSize: '1kg', packedQty: 2, damagedQty: 0, productId: p1kg.id }], userId });
  check('16b. Batch 1 fully packed', (await prisma.productBatch.findUnique({ where: { id: batch1.id } }))!.packagingStatus === 'PACKAGED');
  await ProductionService.approveProduction(p2.id, userId, 12);
  const batch2 = (await prisma.productBatch.findUnique({ where: { productionId: p2.id } }))!;
  const manpower = [{ category: 'MANPOWER', basis: 'PER_BATCH', rate: 240 }];
  const s1 = await ProductionService.packageAndConfirm({ batchId: batch2.id, rows: [{ packetSize: '1kg', packedQty: 4, damagedQty: 0, productId: p1kg.id }], expenses: manpower, userId });
  const s1cb = s1.packaging.costBreakdown as any;
  check('16c. Session 1 (4 of 12 KG) carries ₹80 of the ₹240 batch manpower; packet = ₹100 + ₹20',
    near(s1cb.expenseTotal, 80) && near(s1cb.costPerGoodPacket, 120), s1cb);
  const s2 = await ProductionService.packageAndConfirm({ batchId: batch2.id, rows: [{ packetSize: '500g', packedQty: 6, damagedQty: 0, productId: p500.id }], userId });
  check('16d. Session 2 without re-entering it still carries its share (3 KG → ₹60)', near((s2.packaging.costBreakdown as any).expenseTotal, 60));
  check('17a. Lowering the batch expense below what is already charged is rejected',
    (await rejects(() => ProductionService.packageAndConfirm({ batchId: batch2.id, rows: [{ packetSize: '1kg', packedQty: 1, damagedQty: 0, productId: p1kg.id }], expenses: [{ category: 'MANPOWER', basis: 'PER_BATCH', rate: 100 }], userId }), 'already been charged')) === null);
  const s3 = await ProductionService.packageAndConfirm({ batchId: batch2.id, rows: [{ packetSize: '250g', packedQty: 20, damagedQty: 0, productId: p250.id }], userId });
  check('16e. Final session (5 KG) takes the remaining ₹100', near((s3.packaging.costBreakdown as any).expenseTotal, 100));
  const charged = await prisma.productionExpense.aggregate({ where: { productBatchId: batch2.id, productPackagingId: { not: null }, category: 'MANPOWER' }, _sum: { amount: true } });
  check('17. ₹240 batch expense charged exactly once in total across 3 sessions', near(charged._sum.amount, 240), charged._sum.amount);
  const summary = await ProductionCostingService.getBatchCostSummary(batch2.id);
  check('17b. Cost summary: planned/actual yield, ₹100/KG actual, nothing left unallocated',
    near(summary.plannedYield, 10) && near(summary.actualYield, 12) && near(summary.actualMaterialCostPerUnit, 100) &&
    near(summary.sharedExpenses[0].remaining, 0) && summary.sessions.length === 3, summary);
  check('16f. Duplicate submission (stale packed qty) rejected',
    (await rejects(() => ProductionService.packageAndConfirm({ batchId: batch1.id, expectedPackagedQty: 5, rows: [{ packetSize: '1kg', packedQty: 1, damagedQty: 0, productId: p1kg.id }], userId }), 'just updated')) === null);

  // 18. Finished goods quantities & costs in stock
  const fgStock = async (productSku: string) => {
    const item = await prisma.inventoryItem.findFirst({ where: { sku: productSku, category: 'FINISHED_GOOD' } });
    return item ? prisma.inventoryBatch.findMany({ where: { inventoryItemId: item.id } }) : [];
  };
  const lots500 = await fgStock(p500.sku!);
  check('18. 500g stock: 10 @ ₹55 and 8 @ ₹68.75 (batch 1), 6 @ ₹60 (batch 2: ₹50 + ₹10 manpower share)',
    lots500.length === 3 && near(lots500.reduce((s, l) => s + l.currentQty, 0), 24) &&
    lots500.some((l) => near(l.currentQty, 10) && near(l.unitCost, 55)) && lots500.some((l) => near(l.currentQty, 8) && near(l.unitCost, 68.75)) &&
    lots500.some((l) => near(l.currentQty, 6) && near(l.unitCost, 60)), lots500.map((l) => [l.currentQty, l.unitCost]));

  // Additional material at completion (lot-specific and untracked stock)
  const salt = await prisma.inventoryItem.create({ data: { name: `Salt ${ts}`, sku: `RM-SALT-LC-${ts}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, minimumStock: 0, costPrice: 10 } });
  await prisma.$transaction((tx) => InventoryService.recordMovement(tx, { itemId: salt.id, type: 'ADJUSTMENT', quantity: 3, warehouseId: wh.id }));
  const p3 = await start({ [rice.id]: [{ batchId: lotC.id, qty: 10 }] });
  check('A1. Untracked stock above what exists is rejected',
    (await rejects(() => ProductionService.approveProduction(p3.id, userId, 10, undefined, undefined, undefined, { additionalMaterials: [{ inventoryItemId: salt.id, quantity: 5, lots: [{ batchId: null, qty: 5 }] }] }), 'Insufficient stock')) === null);
  const p3done = await ProductionService.approveProduction(p3.id, userId, 11, undefined, undefined, undefined, {
    requireVarianceRemarks: true,
    additionalMaterials: [
      { inventoryItemId: rice.id, quantity: 1, lots: [{ batchId: lotC.id, qty: 1 }], note: 'Extra to correct consistency' },
      { inventoryItemId: salt.id, quantity: 1, lots: [{ batchId: null, qty: 1 }] },
    ],
  });
  check('A2. Extra 1 KG rice (₹120) + 1 KG salt (₹10) added: ₹1,330 material, ₹120.91/KG actual',
    near(p3done.cost.materialCost, 1330) && near(p3done.cost.additionalMaterialCost, 130) && near(p3done.cost.actualMaterialCostPerUnit!, 120.9091), p3done.cost);
  check('A3. Lot C deducted by 11 KG total; salt by 1 KG', near(await qtyOf(lotC.id), 9) && near(await InventoryService.computeWarehouseStock(salt.id, wh.id), 2));
  const extras = await prisma.productionItem.findMany({ where: { productionId: p3.id, isAdditional: true } });
  check('A4. Additional materials recorded separately with lot breakdown', extras.length === 2 && extras.some((e) => (e.batchBreakdown as any[])[0].batchId === lotC.id));
  check('A5. Batch unit cost uses the extra material (₹1,330 / 11)', near((await prisma.productBatch.findUnique({ where: { productionId: p3.id } }))!.unitCost, 120.9091));

  // Untracked stock can't be claimed when every unit sits in a lot
  check('A6. "No lot" allocation rejected when all stock is in lots',
    (await rejects(() => start({ [rice.id]: [{ batchId: lotC.id, qty: 9 }, { batchId: null, qty: 1 }] }), 'outside purchase lots')) === null);

  // Concurrent starts on the same lot: only one can take its 9 KG
  const race = await Promise.allSettled([1, 2].map(() => start({ [rice.id]: [{ batchId: lotC.id, qty: 9 }] }, 9)));
  check('C. Two simultaneous starts on one lot → exactly one succeeds, lot never negative',
    race.filter((r) => r.status === 'fulfilled').length === 1 && near(await qtyOf(lotC.id), 0), race.map((r) => r.status === 'rejected' ? String((r as any).reason?.message) : 'ok'));

  // Backward compatibility: no allocation → oldest-first as before
  const p4 = await start(undefined, 5);
  check('B. Start without lot allocation still consumes oldest-first (Lot A ₹100)', near(p4.materialCost, 500) && near(await qtyOf(lotA.id), 0));

  // 19. Purchase lot records untouched
  const [a2, b2, c2lot] = await Promise.all([lotA.id, lotB.id, lotC.id].map((id) => prisma.inventoryBatch.findUnique({ where: { id } })));
  check('19. Purchase lot prices and received quantities unchanged',
    near(a2!.unitCost, 100) && near(b2!.unitCost, 200) && near(c2lot!.unitCost, 120) && near(a2!.initialQty, 10) && near(b2!.initialQty, 10) && near(c2lot!.initialQty, 30));

  console.log(`\nAll ${passed} checks passed.`);
}

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await cleanupTestRun(ts); await prisma.$disconnect(); });
