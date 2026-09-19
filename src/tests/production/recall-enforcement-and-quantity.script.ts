import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { RecallService } from '../../modules/production/recall.service';

/**
 * Regression script for two recall fixes:
 *
 * 1. Root cause of the "96 KG available against a 48 KG approved batch"
 *    display bug: getBatchQuantities() used to sum InventoryBatch.currentQty
 *    across every lot tagged with a batch's productBatchId. Because the bulk
 *    pool is shared and FIFO in startPackaging() is unscoped, a batch's own
 *    bulk lot can survive completely untouched (an older/cheaper lot from a
 *    DIFFERENT batch gets consumed instead) while a brand new retail lot
 *    (different unit — packets, not KG) also gets created and tagged with
 *    the same productBatchId — summing both double-counted the same
 *    approved output. Reproduced here exactly: Batch X is packaged first
 *    (irrelevant filler), then Batch A's entire 48kg packaging request is
 *    deliberately fulfilled by draining an older, already-existing bulk lot
 *    instead of Batch A's own, leaving Batch A's own 48kg bulk lot at full
 *    currentQty while a 48-packet retail lot is also created for it.
 *
 * 2. Root cause of "recalled stock is still sellable": InventoryService's
 *    shared recordMovement()/depleteBatchesFIFO() engine skips BLOCKED/
 *    RETURNED lots, but nothing enforced that a shortfall caused by that
 *    skip should fail the transaction — POS checkout, stock-transfer
 *    dispatch, and franchise-order dispatch all call recordMovement()
 *    without strictFIFO, so the sale/dispatch silently "succeeded" against
 *    the item's aggregate currentStock even with zero non-recalled stock
 *    left. Reproduced here at the exact POS code path (SALES_OUT /
 *    referenceType 'ORDER', no strictFIFO) before and after a recall.
 */
async function run() {
  console.log('================================================================');
  console.log('🔍 RECALL AVAILABLE-QTY & POS/DISPATCH ENFORCEMENT REGRESSION');
  console.log('================================================================\n');

  const scriptId = `RECALLFIX_${Date.now()}`;
  let failures = 0;

  let franchiseId: string | null = null;
  let warehouseId: string | null = null;
  let rawItemId: string | null = null;
  let recipeId: string | null = null;
  let prodXId: string | null = null;
  let prodAId: string | null = null;
  let pkgXId: string | null = null;
  let pkgAId: string | null = null;
  let bulkItemId: string | null = null;
  let retailItemId: string | null = null;

  // Independent, unrelated batch/product used only to prove the recall
  // block is scoped to the affected item, not global.
  let recipeZId: string | null = null;
  let prodZId: string | null = null;
  let pkgZId: string | null = null;
  let bulkItemZId: string | null = null;
  let retailItemZId: string | null = null;

  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) {
      console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
    } else {
      console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`);
      failures++;
    }
  };

  try {
    console.log('1️⃣ Setup: franchise, warehouse, raw item, one shared recipe (A + filler batch X)...');
    const franchise = await prisma.franchise.create({
      data: { name: `RecallFix Franchise ${scriptId}`, location: 'Tamil Nadu', ownerName: 'Admin', contactNum: '9000000001', isHQ: true },
    });
    franchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: { name: `RecallFix Warehouse ${scriptId}`, nameKey: `recallfix_wh_${scriptId}`.toLowerCase(), status: 'ACTIVE' },
    });
    warehouseId = warehouse.id;

    const rawItem = await prisma.inventoryItem.create({
      data: { name: `RecallFix Raw ${scriptId}`, sku: `RFR-${scriptId}`, category: 'RAW_MATERIAL', unit: 'KG', costPrice: 0, currentStock: 0, franchiseId },
    });
    rawItemId = rawItem.id;

    const recipe = await prisma.recipe.create({
      data: {
        recipeCode: `RFRCP-${scriptId}`,
        name: `RecallFix Recipe ${scriptId}`,
        yieldQty: 48,
        yieldUnit: 'KG',
        recipeItems: { create: [{ inventoryItemId: rawItemId, quantityRequired: 1, unit: 'KG' }] },
      },
    });
    recipeId = recipe.id;

    console.log('\n2️⃣ Batch X (produced FIRST, so its bulk lot is FIFO-oldest): 48 KG approved...');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId, type: 'PURCHASE_IN', quantity: 1, warehouseId,
      note: 'Lot X', receiveAtCost: { unitCost: 40, batchNumber: `LOT-X-${scriptId}` },
    });
    let prodX = await ProductionService.startProduction({ recipeId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodXId = prodX.id;
    const completedX = await ProductionService.approveProduction(prodX.id, undefined, 48);
    const batchX = completedX.batch;
    await ProductionService.inspectBatch({ batchId: batchX.id, rejectionQty: 0 });

    console.log('\n3️⃣ Batch A (produced SECOND, own bulk lot is FIFO-newer): 48 KG approved...');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId, type: 'PURCHASE_IN', quantity: 1, warehouseId,
      note: 'Lot A', receiveAtCost: { unitCost: 60, batchNumber: `LOT-A-${scriptId}` },
    });
    let prodA = await ProductionService.startProduction({ recipeId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodAId = prodA.id;
    const completedA = await ProductionService.approveProduction(prodA.id, undefined, 48);
    const batchA = completedA.batch;
    await ProductionService.inspectBatch({ batchId: batchA.id, rejectionQty: 0 });
    check('Batch A approvedQty = 48', completedA.batch && true, `will re-check via fresh read below`);

    const bulkItem = await prisma.inventoryItem.findFirst({ where: { sku: { contains: `RFRCP-${scriptId}` } } });
    if (!bulkItem) throw new Error('Bulk item not found');
    bulkItemId = bulkItem.id;
    check('Shared bulk pool holds both batches (96 KG total)', bulkItem.currentStock === 96, `got ${bulkItem.currentStock}`);

    console.log("\n4️⃣ Package Batch A's 48 KG WITHOUT ever packaging Batch X — Batch X's older 48 KG lot is still sitting in the pool untouched, so FIFO (oldest-first, unscoped by productBatchId) draws A's ENTIRE 48 KG request from X's lot instead of A's own...");
    const startPkgA = await ProductionService.startPackaging({ batchId: batchA.id, packetSize: '1 KG', quantityPackets: 48 });
    pkgAId = startPkgA.packaging.id;
    const confirmA = await ProductionService.confirmPackaging({ packagingId: pkgAId, goodQty: 48, damagedQty: 0, spoiledQty: 0 });
    retailItemId = confirmA.retailItem.id;

    const batchAAfterPackaging = await prisma.productBatch.findUniqueOrThrow({ where: { id: batchA.id } });
    const bulkLotA = await prisma.inventoryBatch.findFirst({ where: { productBatchId: batchA.id, inventoryItemId: bulkItemId } });
    const retailLotA = await prisma.inventoryBatch.findFirst({ where: { productBatchId: batchA.id, inventoryItemId: retailItemId } });
    console.log(`   - Batch A's own bulk lot currentQty: ${bulkLotA?.currentQty} KG (Exp: 48 — UNTOUCHED, because FIFO drew entirely from Batch X's older lot instead)`);
    console.log(`   - Batch A's retail lot currentQty: ${retailLotA?.currentQty} packets (Exp: 48)`);
    check("Batch A's own bulk lot is untouched (48 KG) — the cross-batch substitution actually happened", bulkLotA?.currentQty === 48, `got ${bulkLotA?.currentQty}`);
    console.log('   - Old buggy formula would report availableQty = 48 (untouched bulk) + 48 (new retail) = 96, exceeding the 48 KG this batch ever approved.');

    const qtyBeforeRecall = await RecallService.getBatchQuantities(batchA.id);
    console.log(`   - getBatchQuantities(A).availableQty = ${qtyBeforeRecall?.availableQty} (Exp: 48 — NOT 96, the old buggy sum of both lots)`);
    check('availableQty equals approvedQty (48), not double-counted to 96', qtyBeforeRecall?.availableQty === 48, `got ${qtyBeforeRecall?.availableQty}`);
    check('approvedQty is 48', batchAAfterPackaging.approvedQty === 48, `got ${batchAAfterPackaging.approvedQty}`);

    console.log('\n5️⃣ Normal sale BEFORE recall must still succeed (no regression) — sell 1 packet of Batch A...');
    const saleBefore = await InventoryService.recordMovement(prisma, {
      itemId: retailItemId, type: 'SALES_OUT', quantity: -1, referenceType: 'ORDER', note: 'Pre-recall POS sale (should succeed)',
    });
    check('Pre-recall sale succeeded', (saleBefore.fifo?.consumedFromBatches ?? 0) === 1, `consumed ${saleBefore.fifo?.consumedFromBatches}`);

    const qtyAfterOneSale = await RecallService.getBatchQuantities(batchA.id);
    console.log(`   - getBatchQuantities(A).availableQty after 1 sale = ${qtyAfterOneSale?.availableQty} (Exp: 47 = 48 approved - 1 distributed)`);
    check('availableQty correctly drops to 47 after the sale', qtyAfterOneSale?.availableQty === 47, `got ${qtyAfterOneSale?.availableQty}`);

    console.log('\n6️⃣ Initiate recall on Batch A...');
    await RecallService.initiateRecall(batchA.id, { reason: 'Contamination' });
    const retailLotAfterRecall = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: retailLotA!.id } });
    check('Retail lot is BLOCKED after recall', retailLotAfterRecall.status === 'BLOCKED', `status=${retailLotAfterRecall.status}`);

    console.log("\n7️⃣ Attempt a POS sale of 1 more packet AFTER recall — must be REJECTED (this is the exact bypass: SALES_OUT, referenceType 'ORDER', no strictFIFO, same as pos.service.ts), wrapped in prisma.$transaction exactly as every real caller (POS/logistics/franchise-order) does it, to prove the rollback is real and not just this script's own convenience of calling recordMovement outside a transaction...");
    let blockedCorrectly = false;
    let itemAfterAttempt = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    const stockBeforeAttempt = itemAfterAttempt.currentStock;
    try {
      await prisma.$transaction(async (tx) => {
        await InventoryService.recordMovement(tx, {
          itemId: retailItemId!, type: 'SALES_OUT', quantity: -1, referenceType: 'ORDER', note: 'Post-recall POS sale attempt (must fail)',
        });
      });
    } catch (e: any) {
      blockedCorrectly = /recalled|blocked/i.test(e.message);
      console.log(`   - Rejected with: "${e.message}"`);
    }
    check('Post-recall sale was rejected', blockedCorrectly);
    itemAfterAttempt = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    check('currentStock unchanged by the rejected attempt (whole $transaction rolled back, exactly like real POS checkout)', itemAfterAttempt.currentStock === stockBeforeAttempt, `before=${stockBeforeAttempt}, after=${itemAfterAttempt.currentStock}`);

    console.log('\n8️⃣ Scoping control: an UNRELATED product (different recipe, never recalled) must remain fully sellable...');
    const rawItemZ = rawItemId; // reuse the same raw material item
    const recipeZ = await prisma.recipe.create({
      data: {
        recipeCode: `RFRCPZ-${scriptId}`,
        name: `RecallFix Recipe Z ${scriptId}`,
        yieldQty: 5,
        yieldUnit: 'KG',
        recipeItems: { create: [{ inventoryItemId: rawItemZ!, quantityRequired: 1, unit: 'KG' }] },
      },
    });
    recipeZId = recipeZ.id;
    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId!, type: 'PURCHASE_IN', quantity: 1, warehouseId,
      note: 'Lot Z', receiveAtCost: { unitCost: 30, batchNumber: `LOT-Z-${scriptId}` },
    });
    const prodZ = await ProductionService.startProduction({ recipeId: recipeZId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodZId = prodZ.id;
    const completedZ = await ProductionService.approveProduction(prodZ.id, undefined, 5);
    const batchZ = completedZ.batch;
    await ProductionService.inspectBatch({ batchId: batchZ.id, rejectionQty: 0 });
    const bulkItemZ = await prisma.inventoryItem.findFirst({ where: { sku: { contains: `RFRCPZ-${scriptId}` } } });
    bulkItemZId = bulkItemZ!.id;
    const startPkgZ = await ProductionService.startPackaging({ batchId: batchZ.id, packetSize: '1 KG', quantityPackets: 5 });
    pkgZId = startPkgZ.packaging.id;
    const confirmZ = await ProductionService.confirmPackaging({ packagingId: pkgZId, goodQty: 5, damagedQty: 0, spoiledQty: 0 });
    retailItemZId = confirmZ.retailItem.id;

    const saleZ = await InventoryService.recordMovement(prisma, {
      itemId: retailItemZId, type: 'SALES_OUT', quantity: -1, referenceType: 'ORDER', note: 'Unrelated product sale after A was recalled (should succeed)',
    });
    check('Unrelated (non-recalled) product sale still succeeds', (saleZ.fifo?.consumedFromBatches ?? 0) === 1, `consumed ${saleZ.fifo?.consumedFromBatches}`);

  } catch (err: any) {
    console.error('❌ Exception during recall enforcement regression script:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up...');
    try {
      for (const pkgId of [pkgXId, pkgAId, pkgZId]) {
        if (!pkgId) continue;
        await prisma.wasteEntry.deleteMany({ where: { productPackagingId: pkgId } });
        await prisma.productPackaging.deleteMany({ where: { id: pkgId } });
      }
      for (const itemId of [retailItemId, retailItemZId, bulkItemId, bulkItemZId, rawItemId]) {
        if (!itemId) continue;
        await prisma.stockMovement.deleteMany({ where: { itemId } });
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: itemId } });
      }
      for (const prodId of [prodXId, prodAId, prodZId]) {
        if (!prodId) continue;
        await prisma.batchRecallEvent.deleteMany({ where: { recall: { productBatch: { productionId: prodId } } } });
        await prisma.batchRecall.deleteMany({ where: { productBatch: { productionId: prodId } } });
        await prisma.productionStageLog.deleteMany({ where: { productionId: prodId } });
        await prisma.productBatch.deleteMany({ where: { productionId: prodId } });
        await prisma.productionItem.deleteMany({ where: { productionId: prodId } });
        await prisma.production.delete({ where: { id: prodId } });
      }
      for (const rId of [recipeId, recipeZId]) {
        if (!rId) continue;
        await prisma.recipeItem.deleteMany({ where: { recipeId: rId } });
        await prisma.recipe.delete({ where: { id: rId } });
      }
      for (const itemId of [retailItemId, retailItemZId, bulkItemId, bulkItemZId, rawItemId]) {
        if (!itemId) continue;
        await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
      }
      if (warehouseId) await prisma.warehouse.delete({ where: { id: warehouseId } });
      if (franchiseId) await prisma.franchise.delete({ where: { id: franchiseId } });
      console.log('   ✅ Cleanup complete.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 RECALL AVAILABLE-QTY & ENFORCEMENT REGRESSION PASSED 100%! 🎉');
  } else {
    console.error(`💥 ${failures} CHECK(S) FAILED.`);
    process.exit(1);
  }
}

run()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
