import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { RecallService } from '../../modules/production/recall.service';

/**
 * Regression script for transactional safety between a concurrent POS sale
 * and a recall initiation racing for the SAME InventoryBatch row.
 *
 * Before this fix, depleteBatchesFIFO() read candidate batches with a plain
 * (lock-free) findMany, then later issued a per-batch `update` keyed only by
 * id — not re-conditioned on status. That meant: a sale could read a batch
 * as APPROVED, a concurrent initiateRecall() could commit BLOCKED on that
 * exact row a moment later, and the sale's later `update` would still apply
 * — decrementing currentQty on a row that had already been recalled,
 * because nothing forced the two transactions to serialize against each
 * other. depleteBatchesFIFO now selects with `FOR UPDATE`, so the two
 * transactions must serialize: whichever acquires the row lock first
 * commits, and Postgres re-checks depleteBatchesFIFO's WHERE clause
 * (status = 'APPROVED') against the row's latest committed state before
 * ever returning it — so a row that lost the race is correctly excluded,
 * not silently consumed.
 *
 * This is a genuine race — which side wins depends on real DB timing, not
 * something a test can force deterministically. So instead of asserting a
 * specific winner, this asserts the invariant that must hold regardless of
 * who wins: the sold quantity plus the recall-blocked quantity must always
 * exactly equal the total stock that existed — never more (double-counted /
 * sold-then-also-blocked-as-if-still-there), never less (silently lost).
 * Corruption from the old bug would show up as this invariant being
 * violated (e.g. blockedQty still reporting the full amount even though the
 * sale actually consumed it, or currentStock ending up negative).
 */
async function run() {
  console.log('================================================================');
  console.log('🔍 CONCURRENT SALE vs RECALL TRANSACTIONAL SAFETY REGRESSION');
  console.log('================================================================\n');

  let failures = 0;
  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) {
      console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
    } else {
      console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`);
      failures++;
    }
  };

  const TRIALS = 3;
  for (let trial = 1; trial <= TRIALS; trial++) {
    console.log(`\n──────── Trial ${trial}/${TRIALS} ────────`);
    const scriptId = `RACEFIX_${Date.now()}_${trial}`;

    let franchiseId: string | null = null;
    let warehouseId: string | null = null;
    let rawItemId: string | null = null;
    let recipeId: string | null = null;
    let prodId: string | null = null;
    let pkgId: string | null = null;
    let bulkItemId: string | null = null;
    let retailItemId: string | null = null;

    try {
      const franchise = await prisma.franchise.create({
        data: { name: `RaceFix Franchise ${scriptId}`, location: 'Tamil Nadu', ownerName: 'Admin', contactNum: '9000000003', isHQ: true },
      });
      franchiseId = franchise.id;
      const warehouse = await prisma.warehouse.create({
        data: { name: `RaceFix Warehouse ${scriptId}`, nameKey: `racefix_wh_${scriptId}`.toLowerCase(), status: 'ACTIVE' },
      });
      warehouseId = warehouse.id;
      const rawItem = await prisma.inventoryItem.create({
        data: { name: `RaceFix Raw ${scriptId}`, sku: `RCFR-${scriptId}`, category: 'RAW_MATERIAL', unit: 'KG', costPrice: 0, currentStock: 0, franchiseId },
      });
      rawItemId = rawItem.id;
      const recipe = await prisma.recipe.create({
        data: {
          recipeCode: `RCFRCP-${scriptId}`,
          name: `RaceFix Recipe ${scriptId}`,
          yieldQty: 20,
          yieldUnit: 'KG',
          recipeItems: { create: [{ inventoryItemId: rawItemId, quantityRequired: 1, unit: 'KG' }] },
        },
      });
      recipeId = recipe.id;
      await InventoryService.recordMovement(prisma, {
        itemId: rawItemId, type: 'PURCHASE_IN', quantity: 1, warehouseId,
        note: 'Lot', receiveAtCost: { unitCost: 40, batchNumber: `LOT-${scriptId}` },
      });
      const prod = await ProductionService.startProduction({ recipeId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
      prodId = prod.id;
      const completed = await ProductionService.approveProduction(prod.id, undefined, 20);
      const batch = completed.batch;
      await ProductionService.inspectBatch({ batchId: batch.id, rejectionQty: 0 });
      const bulkItem = await prisma.inventoryItem.findFirst({ where: { sku: { contains: `RCFRCP-${scriptId}` } } });
      bulkItemId = bulkItem!.id;
      const startPkg = await ProductionService.startPackaging({ batchId: batch.id, packetSize: '1 KG', quantityPackets: 20 });
      pkgId = startPkg.packaging.id;
      const confirmPkg = await ProductionService.confirmPackaging({ packagingId: pkgId, goodQty: 20, damagedQty: 0, spoiledQty: 0 });
      retailItemId = confirmPkg.retailItem.id;

      console.log(`   Setup complete: Batch ${batch.batchCode}, 20 retail packets, APPROVED. Firing sale + recall concurrently...`);

      const salePromise = prisma.$transaction(async (tx) => {
        return InventoryService.recordMovement(tx, {
          itemId: retailItemId!, type: 'SALES_OUT', quantity: -20, referenceType: 'ORDER', referenceId: `${scriptId}-concurrent-sale`, note: 'Concurrent sale attempt',
        });
      });
      const recallPromise = RecallService.initiateRecall(batch.id, { reason: 'Contamination' });

      const [saleResult, recallResult] = await Promise.allSettled([salePromise, recallPromise]);

      const saleSucceeded = saleResult.status === 'fulfilled';
      console.log(`   Sale: ${saleSucceeded ? 'SUCCEEDED' : `REJECTED (${(saleResult as PromiseRejectedResult).reason?.message})`}`);
      console.log(`   Recall: ${recallResult.status === 'fulfilled' ? 'SUCCEEDED' : `FAILED (${(recallResult as PromiseRejectedResult).reason?.message})`}`);
      check('Recall initiation itself always succeeds regardless of the race', recallResult.status === 'fulfilled');

      const recallEvent = await prisma.batchRecallEvent.findFirst({ where: { recall: { productBatchId: batch.id }, event: 'RECALL_INITIATED' } });
      const blockedQty = recallEvent?.affectedQty ?? 0;
      const saleConsumedQty = saleSucceeded ? 20 : 0;

      console.log(`   Sale consumed: ${saleConsumedQty}, Recall blocked: ${blockedQty}`);
      check('Sold + blocked quantity exactly accounts for all 20 units (no double-count, none lost)', saleConsumedQty + blockedQty === 20, `${saleConsumedQty} + ${blockedQty} = ${saleConsumedQty + blockedQty}`);

      const finalItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId! } });
      check('currentStock matches the race outcome exactly (0 if sold, 20 if blocked)', finalItem.currentStock === (saleSucceeded ? 0 : 20), `got ${finalItem.currentStock}`);
      check('currentStock never went negative', finalItem.currentStock >= 0, `got ${finalItem.currentStock}`);

      const finalBatchRow = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: retailItemId!, productBatchId: batch.id } });
      check('The retail lot ends up BLOCKED regardless of race outcome (recall always claims any still-APPROVED lot)', finalBatchRow?.status === 'BLOCKED', `status=${finalBatchRow?.status}`);
      check('The retail lot currentQty matches the race outcome exactly', finalBatchRow?.currentQty === (saleSucceeded ? 0 : 20), `got ${finalBatchRow?.currentQty}`);

    } catch (err: any) {
      console.error(`   ❌ Exception during trial ${trial}:`, err);
      failures++;
    } finally {
      try {
        if (pkgId) {
          await prisma.wasteEntry.deleteMany({ where: { productPackagingId: pkgId } });
          await prisma.productPackaging.deleteMany({ where: { id: pkgId } });
        }
        for (const itemId of [retailItemId, bulkItemId, rawItemId]) {
          if (!itemId) continue;
          await prisma.stockMovement.deleteMany({ where: { itemId } });
          await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: itemId } });
        }
        if (prodId) {
          await prisma.batchRecallEvent.deleteMany({ where: { recall: { productBatch: { productionId: prodId } } } });
          await prisma.batchRecall.deleteMany({ where: { productBatch: { productionId: prodId } } });
          await prisma.productionStageLog.deleteMany({ where: { productionId: prodId } });
          await prisma.productBatch.deleteMany({ where: { productionId: prodId } });
          await prisma.productionItem.deleteMany({ where: { productionId: prodId } });
          await prisma.production.delete({ where: { id: prodId } });
        }
        if (recipeId) {
          await prisma.recipeItem.deleteMany({ where: { recipeId } });
          await prisma.recipe.delete({ where: { id: recipeId } });
        }
        for (const itemId of [retailItemId, bulkItemId, rawItemId]) {
          if (!itemId) continue;
          const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { sku: true } });
          if (item?.sku) await prisma.product.deleteMany({ where: { sku: item.sku } });
          await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
        }
        if (warehouseId) await prisma.warehouse.delete({ where: { id: warehouseId } });
        if (franchiseId) await prisma.franchise.delete({ where: { id: franchiseId } });
      } catch (cleanErr: any) {
        console.warn('   ⚠️ Cleanup note:', cleanErr.message);
      }
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 CONCURRENT SALE vs RECALL REGRESSION PASSED 100%! 🎉');
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
