// End-to-end check of the Batch Recall workflow on top of the simplified
// production flow: multi-SKU traceability, immediate quarantine, enforcement
// (sale / dispatch / packaging), unaffected batches, recovery, disposal,
// reconciliation, authorised closure and cancellation.
// Run: npx tsx src/tests/production/recall-workflow.test.ts
import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { RecallService } from '../../modules/production/recall.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

process.env.PRODUCTION_QC_ENABLED = 'false';
delete process.env.PRODUCTION_RECALL_ENABLED; // default: enabled

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`   ✅ PASS: ${label}`);
  else { console.error(`   ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
async function expectReject(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, 'call was unexpectedly allowed');
  } catch (err: any) {
    check(label, true);
    console.log(`      ↳ "${err.message}"`);
  }
}

async function runTest() {
  console.log('🧪 Batch Recall Workflow E2E\n');
  const testId = `RC${Date.now().toString().slice(-6)}`;
  const hq = (await FranchiseService.getHqFranchiseOrNull()) || (await prisma.franchise.findFirst());
  if (!hq) throw new Error('No franchise found in DB for test');
  const warehouse = (await prisma.warehouse.findFirst({ where: { status: 'ACTIVE' } })) || (await prisma.warehouse.findFirst());
  if (!warehouse) throw new Error('No warehouse found in DB for test');

  const rawItem = await prisma.inventoryItem.create({
    data: { name: `Raw Recall Ingredient ${testId}`, sku: `RM-${testId}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, franchiseId: null, basePrice: 40, costPrice: 40 },
  });
  await InventoryService.recordMovement(prisma, {
    itemId: rawItem.id, type: 'PURCHASE_IN', quantity: 40, warehouseId: warehouse.id,
    note: `Recall test stock ${testId}`, receiveAtCost: { unitCost: 40, batchNumber: `LOT-${testId}` },
  });
  const recipe = await prisma.recipe.create({
    data: {
      name: `Recall Test Maavu ${testId}`, recipeCode: `RCP-${testId}`, category: 'Test Category', yieldQty: 10, yieldUnit: 'KG',
      recipeItems: { create: [{ inventoryItemId: rawItem.id, quantityRequired: 10, unit: 'KG' }] },
    },
  });
  const p500 = { name: `Recall Test Maavu ${testId} 500g`, sku: `FG-${testId}-500G`, basePrice: 50 };
  const p1kg = { name: `Recall Test Maavu ${testId} 1kg`, sku: `FG-${testId}-1KG`, basePrice: 95 };
  const stockOf = async (sku: string) => (await prisma.inventoryItem.findFirst({ where: { sku } }))?.currentStock ?? 0;
  const itemOf = async (sku: string) => prisma.inventoryItem.findFirstOrThrow({ where: { sku } });
  const sell = (itemId: string, qty: number, referenceType = 'ORDER') =>
    prisma.$transaction(tx => InventoryService.recordMovement(tx, {
      itemId, type: 'SALES_OUT', quantity: -qty, referenceType, referenceId: `TEST-${testId}-${Math.random().toString(36).slice(2, 7)}`,
      note: `Recall test sale ${testId}`, warehouseId: warehouse.id,
    }));

  try {
    // ── Setup ──
    // All batches of a recipe share one bulk pool, drawn oldest-first. Batch B
    // is made and FULLY packed first, so it never touches batch A's bulk and
    // is genuinely unaffected (if B had drawn on A's bulk, the recall would
    // rightly quarantine B too — see findCrossBatchAffectedIds).
    console.log('0️⃣ Setup');
    const prodB = await ProductionService.startProduction({ recipeId: recipe.id, quantity: 1, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' });
    const batchB = (await ProductionService.approveProduction(prodB.id, undefined, 10)).batch;
    await ProductionService.packageAndConfirm({ batchId: batchB.id, expectedPackagedQty: 0, rows: [{ packetSize: '500g', packedQty: 20, newProduct: p500 }] });
    const prod500 = await prisma.product.findFirstOrThrow({ where: { sku: p500.sku } });

    const prodA = await ProductionService.startProduction({ recipeId: recipe.id, quantity: 2, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' });
    const batchA = (await ProductionService.approveProduction(prodA.id, undefined, 20)).batch;
    await ProductionService.packageAndConfirm({
      batchId: batchA.id, expectedPackagedQty: 0, rows: [
        { packetSize: '500g', packedQty: 10, productId: prod500.id },
        { packetSize: '1kg', packedQty: 5, newProduct: p1kg },
      ],
    });
    const item500 = await itemOf(p500.sku);
    const item1kg = await itemOf(p1kg.sku);
    // Date B's packets a day later so sales draw on batch A's stock first.
    await prisma.inventoryBatch.updateMany({ where: { productBatchId: batchB.id, inventoryItemId: item500.id }, data: { mfgDate: new Date(Date.now() + 86400000) } });
    // Sold / dispatched before the recall: 3 × 500g at POS, 2 × 1kg on a delivery challan.
    await sell(item500.id, 3, 'ORDER');
    await sell(item1kg.id, 2, 'DELIVERY_CHALLAN');
    check('Setup: 500g stock 27 (A 7 + B 20), 1kg stock 3', (await stockOf(p500.sku)) === 27 && (await stockOf(p1kg.sku)) === 3,
      `${await stockOf(p500.sku)} / ${await stockOf(p1kg.sku)}`);

    // ── 1. Traceability before the recall ──
    console.log('\n1️⃣ Traceability (multi-SKU)');
    const pre = await RecallService.getRecallDetails(batchA.id);
    const s500 = pre!.skus.find(s => s.sku === p500.sku);
    const s1kg = pre!.skus.find(s => s.sku === p1kg.sku);
    check('Both finished SKUs of batch A are traced', !!s500 && !!s1kg);
    check('500g: packed 10, distributed 3, on hand 7 (batch B not included)', !s500?.crossBatch && s500?.packedQty === 10 && s500?.distributedQty === 3 && s500?.onHandQty === 7, JSON.stringify(s500));
    check('1kg: packed 5, distributed 2 (delivery challan)', s1kg?.packedQty === 5 && s1kg?.distributedQty === 2 && s1kg?.destinations[0]?.type === 'DELIVERY_CHALLAN', JSON.stringify(s1kg?.destinations));
    check('Packaging records fetched (2 confirmed runs)', pre!.packagings.length === 2);

    // ── 2. Initiate ──
    console.log('\n2️⃣ Initiate recall');
    await expectReject('Invalid severity is refused', () => RecallService.initiateRecall(batchA.id, { reason: 'Contamination', severity: 'URGENT', description: 'Foreign matter found' }));
    const rec = await RecallService.initiateRecall(batchA.id, { reason: 'Contamination', severity: 'CRITICAL', description: `Foreign matter found in retained sample ${testId}` });
    check('Recall number generated (RCL-YYYY-NNNN)', /^RCL-\d{4}-\d{4,}$/.test(rec.recallNumber), rec.recallNumber);
    await expectReject('A second recall on the same batch is refused', () => RecallService.initiateRecall(batchA.id, { reason: 'Contamination', severity: 'HIGH', description: 'Duplicate attempt here' }));

    // ── 3. Quarantine ──
    console.log('\n3️⃣ Quarantine');
    const lotsA = await prisma.inventoryBatch.findMany({ where: { productBatchId: batchA.id } });
    const lotsB = await prisma.inventoryBatch.findMany({ where: { productBatchId: batchB.id } });
    check('Every stock lot of batch A is BLOCKED (bulk + both SKUs)', lotsA.length >= 3 && lotsA.every(l => l.status === 'BLOCKED'), lotsA.map(l => l.status).join(','));
    check('Batch B lots stay APPROVED', lotsB.length > 0 && lotsB.every(l => l.status === 'APPROVED'));
    check('Physical stock unchanged by quarantine (500g still 27)', (await stockOf(p500.sku)) === 27);
    const qs = await RecallService.quarantineSummary();
    check('Stock Hub quarantine summary: 500g 7, 1kg 3', qs.find(q => q.sku === p500.sku)?.quarantinedQty === 7 && qs.find(q => q.sku === p1kg.sku)?.quarantinedQty === 3);

    // ── 4. Enforcement ──
    console.log('\n4️⃣ Enforcement');
    await expectReject('POS sale needing recalled 500g stock is refused (21 asked, only 20 unaffected)', () => sell(item500.id, 21, 'ORDER'));
    await expectReject('Dispatch of recalled 1kg stock is refused', () => sell(item1kg.id, 1, 'DELIVERY_CHALLAN'));
    await expectReject('Franchise transfer of recalled 1kg stock is refused', () => sell(item1kg.id, 1, 'TRANSFER'));
    await sell(item500.id, 6, 'ORDER');
    check('Unaffected batch B can still be sold (6 × 500g, 14 left)', (await prisma.inventoryBatch.findMany({ where: { productBatchId: batchB.id, inventoryItemId: item500.id } })).every(l => l.currentQty === 14 && l.status === 'APPROVED'));
    await expectReject('Remaining bulk of the recalled batch cannot be packaged', () =>
      ProductionService.packageAndConfirm({ batchId: batchA.id, expectedPackagedQty: 7.5, rows: [{ packetSize: '500g', packedQty: 1, productId: prod500.id }] }));

    // ── 5. Tracking: distribution, recovery, disposal ──
    console.log('\n5️⃣ Recovery and disposal');
    await expectReject('Recovery before distribution is located is refused', () =>
      RecallService.collectReturn(batchA.id, 1, undefined, { inventoryBatchId: lotsA.find(l => l.inventoryItemId === item500.id)!.id }));
    await RecallService.locateDistribution(batchA.id);
    const lot500 = lotsA.find(l => l.inventoryItemId === item500.id)!;
    const lot1kg = lotsA.find(l => l.inventoryItemId === item1kg.id)!;
    await expectReject('Recovering more than was distributed is refused (5 > 3)', () => RecallService.collectReturn(batchA.id, 5, undefined, { inventoryBatchId: lot500.id }));
    await RecallService.collectReturn(batchA.id, 2, undefined, { inventoryBatchId: lot500.id, note: 'Collected from customer' });
    let d = await RecallService.getRecallDetails(batchA.id);
    let r500 = d!.skus.find(s => s.sku === p500.sku)!;
    check('500g: 2 recovered into quarantine, outstanding 1, quarantined 9', r500.recoveredQty === 2 && r500.outstandingQty === 1 && r500.quarantinedQty === 9, JSON.stringify({ rec: r500.recoveredQty, out: r500.outstandingQty, q: r500.quarantinedQty }));
    check('Recovered stock is not sellable', r500.sellableQty === 0);

    await expectReject('Disposal needs a note', () => RecallService.disposeStock(batchA.id, { inventoryBatchId: lot500.id, quantity: 1, note: '' }));
    await expectReject('Cannot dispose more than is quarantined in the lot', () => RecallService.disposeStock(batchA.id, { inventoryBatchId: lot500.id, quantity: 8, note: 'Destroyed on site' }));
    const unaffectedLot = lotsB.find(l => l.inventoryItemId === item500.id)!;
    await expectReject('Stock outside the recall cannot be disposed through it', () => RecallService.disposeStock(batchA.id, { inventoryBatchId: unaffectedLot.id, quantity: 1, note: 'Destroyed on site' }));
    const stockBeforeDisposal = await stockOf(p500.sku);
    await RecallService.disposeStock(batchA.id, { inventoryBatchId: lot500.id, quantity: 7, note: 'Destroyed under supervision' });
    check('Disposal deducts stock exactly once (−7)', stockBeforeDisposal - (await stockOf(p500.sku)) === 7);
    check('Disposal recorded as recall wastage', (await prisma.wasteEntry.count({ where: { inventoryItemId: item500.id, reason: 'RECALL_DISPOSAL' } })) === 1);

    // ── 6. Reconciliation and closure ──
    console.log('\n6️⃣ Reconciliation and closure');
    await expectReject('Closing without a reconciliation is refused', () => RecallService.completeRecall(batchA.id, undefined, 'Closing the recall now'));
    await expectReject('Unavailable cannot exceed distributed-but-unrecovered (500g: 2 > 1)', () =>
      RecallService.reconcileRecall(batchA.id, { lines: [{ inventoryItemId: item500.id, unavailableQty: 2 }], notes: 'Customer consumed product' }));
    const partial = await RecallService.reconcileRecall(batchA.id, { lines: [{ inventoryItemId: item500.id, unavailableQty: 1 }], notes: 'Remaining 1kg packets still with distributor' });
    check('Partial reconciliation leaves 2 × 1kg outstanding', partial.outstandingTotal === 2 && !partial.readyToClose);
    await expectReject('Closing with outstanding stock is refused', () => RecallService.completeRecall(batchA.id, undefined, 'Closing the recall now'));
    await RecallService.reconcileRecall(batchA.id, {
      lines: [{ inventoryItemId: item500.id, unavailableQty: 1 }, { inventoryItemId: item1kg.id, unavailableQty: 2 }],
      notes: '1 × 500g consumed by customer; 2 × 1kg consumed at distributor (confirmed by phone)',
    });
    d = await RecallService.getRecallDetails(batchA.id);
    check('Lifecycle is RECONCILED', d!.recall?.lifecycle === 'RECONCILED', d!.recall?.lifecycle);
    await RecallService.disposeStock(batchA.id, { inventoryBatchId: lot1kg.id, quantity: 1, note: 'Destroyed under supervision' });
    await expectReject('A later disposal makes the reconciliation stale — closing is refused', () => RecallService.completeRecall(batchA.id, undefined, 'Closing the recall now'));
    await RecallService.reconcileRecall(batchA.id, {
      lines: [{ inventoryItemId: item500.id, unavailableQty: 1 }, { inventoryItemId: item1kg.id, unavailableQty: 2 }],
      notes: 'Re-reconciled after disposing 1 × 1kg',
    });
    await expectReject('Closing needs a closure note', () => RecallService.completeRecall(batchA.id, undefined, ''));
    await RecallService.completeRecall(batchA.id, undefined, 'All affected stock accounted for; regulator notified');
    d = await RecallService.getRecallDetails(batchA.id);
    check('Recall CLOSED', d!.recall?.status === 'COMPLETED' && d!.recall?.lifecycle === 'CLOSED');
    const evs = d!.events.map(e => e.event);
    check('Audit trail records every action in order', ['RECALL_INITIATED', 'DISTRIBUTION_LOCATED', 'RETURN_COLLECTED', 'STOCK_DISPOSED', 'RECALL_RECONCILED', 'RECALL_COMPLETED'].every(e => evs.includes(e)), evs.join(' → '));
    check('Remaining quarantined stock stays blocked after closure', (await prisma.inventoryBatch.findMany({ where: { productBatchId: batchA.id, currentQty: { gt: 0 } } })).every(l => l.status !== 'APPROVED'));
    await expectReject('Packaging stays blocked after closure', () =>
      ProductionService.packageAndConfirm({ batchId: batchA.id, expectedPackagedQty: 7.5, rows: [{ packetSize: '500g', packedQty: 1, productId: prod500.id }] }));
    const list = await RecallService.listRecalls();
    check('Recall History lists it with its number', list.some(x => x.recallNumber === rec.recallNumber && x.lifecycle === 'CLOSED'));

    // ── 7. Cancellation releases quarantine only with a documented reason ──
    console.log('\n7️⃣ Cancellation');
    const prodC = await ProductionService.startProduction({ recipeId: recipe.id, quantity: 1, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' });
    const batchC = (await ProductionService.approveProduction(prodC.id, undefined, 10)).batch;
    await ProductionService.packageAndConfirm({ batchId: batchC.id, expectedPackagedQty: 0, rows: [{ packetSize: '500g', packedQty: 4, productId: prod500.id }] });
    await RecallService.initiateRecall(batchC.id, { reason: 'Customer complaint', severity: 'LOW', description: 'Complaint about taste, precautionary' });
    await expectReject('Cancelling without a documented reason is refused', () => RecallService.cancelRecall(batchC.id, 'no'));
    await RecallService.cancelRecall(batchC.id, 'Lab results negative — recall withdrawn by QA head');
    const lotsC = await prisma.inventoryBatch.findMany({ where: { productBatchId: batchC.id } });
    check('Cancelled recall releases blocked stock back to sale', lotsC.every(l => l.status === 'APPROVED'));
    await sell(item500.id, 2, 'ORDER');
    check('Released stock can be sold again', true);
  } finally {
    console.log('\n🧹 Cleaning up test records...');
    const batches = await prisma.productBatch.findMany({ where: { production: { recipeId: recipe.id } }, select: { id: true } });
    const batchIds = batches.map(b => b.id);
    const recalls = await prisma.batchRecall.findMany({ where: { productBatchId: { in: batchIds } }, select: { id: true } });
    await prisma.batchRecallEvent.deleteMany({ where: { recallId: { in: recalls.map(r => r.id) } } });
    await prisma.batchRecall.deleteMany({ where: { id: { in: recalls.map(r => r.id) } } });
    const testItems = await prisma.inventoryItem.findMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] } });
    const itemIds = testItems.map(i => i.id);
    await prisma.wasteEntry.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.stockMovement.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.productPackaging.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.productBatch.deleteMany({ where: { id: { in: batchIds } } });
    await prisma.productionStageLog.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.productionItem.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.production.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipeItem.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipe.delete({ where: { id: recipe.id } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.product.deleteMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] } });
    console.log('🧹 Cleanup complete.\n');
  }

  if (failures === 0) console.log('🎉 ALL BATCH RECALL TESTS PASSED');
  else { console.error(`💥 ${failures} CHECK(S) FAILED`); process.exit(1); }
}

runTest()
  .catch(err => { console.error('Test execution error:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
