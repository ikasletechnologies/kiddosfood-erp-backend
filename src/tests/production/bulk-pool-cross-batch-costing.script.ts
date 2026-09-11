import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { RecallService } from '../../modules/production/recall.service';

/**
 * Regression script for the bulk -> packaging costing fix.
 *
 * Two ProductBatches of the SAME recipe (so they share one bulk
 * InventoryItem pool) are approved at different effective costs. Batch A's
 * bulk lot (older, so FIFO-first) is deliberately smaller than the
 * packaging request made against Batch B, forcing FIFO to fully drain A's
 * lot and then spill into B's own lot within the same packaging ticket.
 * This asserts:
 *   1. confirmPackaging() costs the run from the actual blended FIFO
 *      consumption (ProductPackaging.bulkBreakdown), not just the
 *      on-screen ProductBatch's own unitCost.
 *   2. A recall on the OLDER batch (A) also blocks/traces the retail stock
 *      that was nominally packaged under the NEWER batch (B), via
 *      RecallService's cross-batch lookup.
 */
async function run() {
  console.log('================================================================');
  console.log('🔍 BULK POOL CROSS-BATCH COSTING & RECALL TRACEABILITY REGRESSION');
  console.log('================================================================\n');

  const scriptId = `BULKPOOL_${Date.now()}`;
  let failures = 0;

  let franchiseId: string | null = null;
  let warehouseId: string | null = null;
  let rawItemId: string | null = null;
  let recipeId: string | null = null;
  let prodAId: string | null = null;
  let prodBId: string | null = null;
  let pkgId: string | null = null;
  let bulkItemId: string | null = null;
  let retailItemId: string | null = null;

  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) {
      console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
    } else {
      console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`);
      failures++;
    }
  };

  try {
    console.log('1️⃣ Setup: franchise, warehouse, raw item, one shared recipe...');
    const franchise = await prisma.franchise.create({
      data: { name: `BulkPool Franchise ${scriptId}`, location: 'Tamil Nadu', ownerName: 'Admin', contactNum: '9000000000', isHQ: true },
    });
    franchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: { name: `BulkPool Warehouse ${scriptId}`, nameKey: `bulkpool_wh_${scriptId}`.toLowerCase(), status: 'ACTIVE' },
    });
    warehouseId = warehouse.id;

    const rawItem = await prisma.inventoryItem.create({
      data: { name: `BulkPool Raw ${scriptId}`, sku: `BPR-${scriptId}`, category: 'RAW_MATERIAL', unit: 'KG', costPrice: 0, currentStock: 0, franchiseId },
    });
    rawItemId = rawItem.id;

    // Single recipe reused for BOTH production runs so they land in the
    // same bulk SKU (resolveBulkIdentity derives it from recipeCode).
    const recipe = await prisma.recipe.create({
      data: {
        recipeCode: `BPRCP-${scriptId}`,
        name: `BulkPool Recipe ${scriptId}`,
        yieldQty: 10,
        yieldUnit: 'KG',
        recipeItems: { create: [{ inventoryItemId: rawItemId, quantityRequired: 2, unit: 'KG' }] },
      },
    });
    recipeId = recipe.id;

    console.log('\n2️⃣ Production A: consumes Lot A (2kg @ ₹50/kg = ₹100), yields 10kg, 0 rejected...');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId, type: 'PURCHASE_IN', quantity: 2, warehouseId,
      note: 'Lot A', receiveAtCost: { unitCost: 50, batchNumber: `LOT-A-${scriptId}` },
    });
    let prodA = await ProductionService.startProduction({ recipeId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodAId = prodA.id;
    prodA = await prisma.production.findUniqueOrThrow({ where: { id: prodA.id } });
    check('Production A material cost = ₹100', prodA.materialCost === 100, `got ₹${prodA.materialCost}`);

    // Small yield (4kg) so its bulk lot is fully exhausted partway through
    // Batch B's packaging run below, forcing FIFO to spill over into Batch
    // B's own lot within the SAME packaging ticket — the blended case.
    const completedA = await ProductionService.approveProduction(prodA.id, undefined, 4);
    const batchA = completedA.batch;
    const qcA = await ProductionService.inspectBatch({ batchId: batchA.id, rejectionQty: 0 });
    check('Batch A effective cost = ₹25/kg (₹100 / 4kg)', Math.abs((qcA.unitCost ?? 0) - 25) < 0.0001, `got ₹${qcA.unitCost}`);

    console.log('\n3️⃣ Production B (same recipe): consumes Lot B (2kg @ ₹80/kg = ₹160), yields 10kg, 0 rejected...');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId, type: 'PURCHASE_IN', quantity: 2, warehouseId,
      note: 'Lot B', receiveAtCost: { unitCost: 80, batchNumber: `LOT-B-${scriptId}` },
    });
    let prodB = await ProductionService.startProduction({ recipeId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodBId = prodB.id;
    prodB = await prisma.production.findUniqueOrThrow({ where: { id: prodB.id } });
    check('Production B material cost = ₹160', prodB.materialCost === 160, `got ₹${prodB.materialCost}`);

    const completedB = await ProductionService.approveProduction(prodB.id, undefined, 10);
    const batchB = completedB.batch;
    const qcB = await ProductionService.inspectBatch({ batchId: batchB.id, rejectionQty: 0 });
    check('Batch B effective cost = ₹16/kg', Math.abs((qcB.unitCost ?? 0) - 16) < 0.0001, `got ₹${qcB.unitCost}`);

    // Bulk items are created via FranchiseService.toInventoryScopeId, which
    // maps an HQ franchise to franchiseId: null (see pos.service.ts comment
    // on the null-means-HQ convention) — don't scope this lookup by our
    // franchise.id, it won't match.
    const bulkItem = await prisma.inventoryItem.findFirst({ where: { sku: { contains: `BPRCP-${scriptId}` } } });
    if (!bulkItem) throw new Error('Bulk item not found — resolveBulkIdentity naming assumption may be wrong');
    bulkItemId = bulkItem.id;
    console.log(`   - Shared bulk item: ${bulkItem.name} (${bulkItem.sku}), stock: ${bulkItem.currentStock}kg (Exp: 14kg = 4 from A + 10 from B)`);
    check('Bulk pool holds both batches\' output (14kg)', bulkItem.currentStock === 14, `got ${bulkItem.currentStock}`);

    console.log('\n4️⃣ Package 8kg AGAINST BATCH B (within its own 10kg cap) — FIFO should still fully drain Batch A\'s older, cheaper 4kg lot first, then spill into Batch B\'s own lot for the remaining 4kg...');
    const startPkg = await ProductionService.startPackaging({ batchId: batchB.id, packetSize: '1 KG', quantityPackets: 8 });
    pkgId = startPkg.packaging.id;

    const pkgTicket = await prisma.productPackaging.findUniqueOrThrow({ where: { id: pkgId } });
    const breakdown: any[] = Array.isArray(pkgTicket.bulkBreakdown) ? pkgTicket.bulkBreakdown : [];
    console.log('   - bulkBreakdown recorded at startPackaging:');
    breakdown.forEach((b, i) => console.log(`     Line ${i + 1}: productBatch=${b.productBatchId === batchA.id ? 'A' : b.productBatchId === batchB.id ? 'B' : b.productBatchId} qty=${b.qty}kg @ ₹${b.unitCost}/kg = ₹${b.totalCost}`));
    check(
      'FIFO spilled across both batches (2 breakdown lines)',
      breakdown.length === 2 && breakdown[0].productBatchId === batchA.id && breakdown[1].productBatchId === batchB.id,
    );
    check('Breakdown total cost = ₹164 (4kg@₹25 + 4kg@₹16)', Math.abs(breakdown.reduce((s, b) => s + b.totalCost, 0) - 164) < 0.0001);

    const confirmPkg = await ProductionService.confirmPackaging({ packagingId: pkgId, goodQty: 8, damagedQty: 0, spoiledQty: 0 });
    const retailItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg.retailItem.id } });
    retailItemId = retailItem.id;
    const retailBatch = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: retailItem.id, productBatchId: batchB.id } });
    const retailUnitCost = retailBatch?.unitCost ?? 0;
    console.log(`   - Retail lot unit cost: ₹${retailUnitCost.toFixed(4)}/packet (Exp: ₹20.5000 = ₹164 / 8 packets)`);
    console.log(`   - (Old buggy formula would have given ₹16.00 = 8 x Batch B's own unitCost, ignoring Batch A's cheaper... in this case pricier-blended-in lot FIFO actually consumed)`);
    check('Retail unit cost reflects ACTUAL blended FIFO cost, not batch.unitCost', Math.abs(retailUnitCost - 20.5) < 0.0001, `got ₹${retailUnitCost}`);

    console.log('\n5️⃣ POS sale of 1 packet — COGS should be ₹20.50, not ₹16.00...');
    const sale = await InventoryService.recordMovement(prisma, { itemId: retailItem.id, type: 'SALES_OUT', quantity: -1, referenceType: 'SALE', note: 'Test sale' });
    check('POS COGS for 1 packet = ₹20.50', Math.abs((sale.fifo?.totalCost ?? 0) - 20.5) < 0.0001, `got ₹${sale.fifo?.totalCost}`);

    console.log('\n6️⃣ Recall traceability: recalling Batch A (the OLDER batch) must also catch Batch B\'s retail lot...');
    await RecallService.initiateRecall(batchA.id, { reason: 'Contamination' });
    const retailBatchAfterRecall = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: retailBatch!.id } });
    check(
      'Retail lot nominally tagged Batch B got BLOCKED by a recall on Batch A (cross-batch)',
      retailBatchAfterRecall.status === 'BLOCKED',
      `status=${retailBatchAfterRecall.status}`,
    );

    const distribution = await RecallService.locateDistribution(batchA.id);
    console.log(`   - Direct distributedQty for Batch A: ${distribution.distributedQty} (Exp: 0 — Batch A was never itself packaged)`);
    console.log(`   - Cross-batch distributedQty (via Batch B's packaging): ${distribution.crossDistributedQty} (Exp: 1 packet already sold)`);
    check('Direct distribution for Batch A is 0 (it was never packaged itself)', distribution.distributedQty === 0);
    check('Cross-batch distribution correctly finds the 1 packet already sold via Batch B', distribution.crossDistributedQty === 1, `got ${distribution.crossDistributedQty}`);

  } catch (err: any) {
    console.error('❌ Exception during bulk pool cross-batch regression script:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up...');
    try {
      if (pkgId) {
        await prisma.wasteEntry.deleteMany({ where: { productPackagingId: pkgId } });
        await prisma.productPackaging.deleteMany({ where: { id: pkgId } });
      }
      if (retailItemId) {
        await prisma.stockMovement.deleteMany({ where: { itemId: retailItemId } });
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: retailItemId } });
      }
      if (bulkItemId) {
        await prisma.stockMovement.deleteMany({ where: { itemId: bulkItemId } });
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: bulkItemId } });
      }
      if (rawItemId) {
        await prisma.stockMovement.deleteMany({ where: { itemId: rawItemId } });
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: rawItemId } });
      }
      for (const prodId of [prodAId, prodBId]) {
        if (!prodId) continue;
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
      if (retailItemId) await prisma.inventoryItem.deleteMany({ where: { id: retailItemId } });
      if (bulkItemId) await prisma.inventoryItem.deleteMany({ where: { id: bulkItemId } });
      if (rawItemId) await prisma.inventoryItem.deleteMany({ where: { id: rawItemId } });
      if (warehouseId) await prisma.warehouse.delete({ where: { id: warehouseId } });
      if (franchiseId) await prisma.franchise.delete({ where: { id: franchiseId } });
      console.log('   ✅ Cleanup complete.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 BULK POOL CROSS-BATCH REGRESSION PASSED 100%! 🎉');
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
