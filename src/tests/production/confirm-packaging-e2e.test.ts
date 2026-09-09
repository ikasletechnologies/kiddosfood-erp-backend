import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

async function runTest() {
  console.log('🧪 Starting Confirm Packaging E2E Test Suite...\n');
  const testId = Date.now().toString().slice(-6);
  let failures = 0;

  let hqFranchise = await FranchiseService.getHqFranchiseOrNull();
  if (!hqFranchise) {
    hqFranchise = await prisma.franchise.findFirst();
  }
  if (!hqFranchise) {
    throw new Error('No franchise found in DB for test');
  }

  let warehouse = await prisma.warehouse.findFirst({
    where: { status: 'ACTIVE' }
  });
  if (!warehouse) {
    warehouse = await prisma.warehouse.findFirst();
  }

  // Create raw material item
  const rawItem = await prisma.inventoryItem.create({
    data: {
      name: `Raw Test Ingredient ${testId}`,
      sku: `RM-ING-${testId}`,
      category: 'RAW_MATERIAL',
      unit: 'KG',
      currentStock: 0,
      franchiseId: null,
      basePrice: 50,
      costPrice: 50,
    }
  });

  // Seed raw material stock
  await InventoryService.recordMovement(prisma, {
    itemId: rawItem.id,
    type: 'PURCHASE_IN',
    quantity: 100,
    warehouseId: warehouse?.id || undefined,
    note: `Initial Test Stock @ ₹50/kg`,
    receiveAtCost: { unitCost: 50, batchNumber: `LOT-${testId}` }
  });

  // Create Recipe
  const recipe = await prisma.recipe.create({
    data: {
      name: `Test Batter Recipe ${testId}`,
      recipeCode: `RCP-TST-${testId}`,
      category: 'Test Category',
      yieldQty: 10,
      yieldUnit: 'KG',
      recipeItems: {
        create: [
          {
            inventoryItemId: rawItem.id,
            quantityRequired: 10,
            unit: 'KG',
          }
        ]
      }
    }
  });

  // Create explicit Sellable Finished Good Product
  const fgProduct = await prisma.product.create({
    data: {
      name: `Test Packaged Batter ${testId} (500g)`,
      sku: `FG-BAT-${testId}-500G`,
      category: 'FINISHED_GOOD',
      productType: 'FINISHED_GOOD',
      basePrice: 120,
      taxPercent: 5,
      isActive: true,
    }
  });

  try {
    // ── Test 1: Production Run -> Bulk Semi-Finished -> QC Approve ──
    console.log('1️⃣ Test 1: Producing and approving 10 KG bulk batch...');
    const prod = await ProductionService.startProduction({
      recipeId: recipe.id,
      quantity: 1,
      franchiseId: hqFranchise.id,
      warehouseId: warehouse?.id,
      productionType: 'FINISHED_GOOD',
    });

    const approvedProd = await ProductionService.approveProduction(prod.id, undefined, 10);
    const batchId = approvedProd.batch.id;

    // QC Approve: 10 KG approved, 0 rejected
    const qc = await ProductionService.inspectBatch({
      batchId,
      rejectionQty: 0,
      qcRemarks: '100% Passed',
    });

    if (qc.approvedQty === 10 && qc.qcStatus === 'APPROVED') {
      console.log('   ✅ PASS: Batch approved with 10 KG bulk.');
    } else {
      console.error(`   ❌ FAIL: Unexpected QC state: ${qc.qcStatus}, approvedQty: ${qc.approvedQty}`);
      failures++;
    }

    // ── Test 2: Start Packaging & Confirm with Selected Product (4 KG = 8 packs x 500g) ──
    console.log('\n2️⃣ Test 2: Packaging 8 x 500g (4 KG) with explicit Product Selection...');
    const startPkg1 = await ProductionService.startPackaging({
      batchId,
      packetSize: '500g',
      quantityPackets: 8,
      productId: fgProduct.id,
    });

    const confirmPkg1 = await ProductionService.confirmPackaging({
      packagingId: startPkg1.packaging.id,
      goodQty: 8,
      damagedQty: 0,
      spoiledQty: 0,
      productId: fgProduct.id,
    });

    const updatedBatch1 = await prisma.productBatch.findUniqueOrThrow({ where: { id: batchId } });
    console.log(`   - Batch Packaged Qty: ${updatedBatch1.packagedQty} KG, Status: ${updatedBatch1.packagingStatus}`);
    if (updatedBatch1.packagedQty === 4 && updatedBatch1.packagingStatus === 'PARTIALLY_PACKED') {
      console.log('   ✅ PASS: Partially packed 4 KG, 6 KG remaining.');
    } else {
      console.error(`   ❌ FAIL: Expected packagedQty 4, got ${updatedBatch1.packagedQty}`);
      failures++;
    }

    // ── Test 3: In-flight capacity guard — trying to start 14 x 500g (7 KG) when only 6 KG left ──
    console.log('\n3️⃣ Test 3: Verifying over-capacity start is prevented (7 KG requested, 6 KG left)...');
    let overCapacityFailed = false;
    try {
      await ProductionService.startPackaging({
        batchId,
        packetSize: '500g',
        quantityPackets: 14,
      });
    } catch (err: any) {
      overCapacityFailed = true;
      console.log(`   - Correctly rejected with message: "${err.message}"`);
    }

    if (overCapacityFailed) {
      console.log('   ✅ PASS: Over-capacity packaging correctly rejected!');
    } else {
      console.error('   ❌ FAIL: Over-capacity packaging was unexpectedly allowed!');
      failures++;
    }

    // ── Test 4: Start Packaging & Cancellation (releases reserved stock) ──
    console.log('\n4️⃣ Test 4: Starting a 2 KG run and cancelling it (verifying reservation refund)...');
    const cancelRun = await ProductionService.startPackaging({
      batchId,
      packetSize: '500g',
      quantityPackets: 4, // 2 KG
    });

    const cancelResult = await ProductionService.cancelPackaging({
      packagingId: cancelRun.packaging.id,
      reason: 'Operator cancellation test',
    });

    if (cancelResult.packaging.status === 'CANCELLED') {
      console.log('   ✅ PASS: Run successfully cancelled and bulk stock released.');
    } else {
      console.error(`   ❌ FAIL: Expected status CANCELLED, got ${cancelResult.packaging.status}`);
      failures++;
    }

    // ── Test 5: Confirm Packaging without pre-existing Product (Unlinked Recipe Auto-Catalog) ──
    console.log('\n5️⃣ Test 5: Confirming remaining 6 KG (12 x 500g) without product ID (Auto-derivation)...');
    const startPkg2 = await ProductionService.startPackaging({
      batchId,
      packetSize: '500g',
      quantityPackets: 12, // 6 KG
    });

    const confirmPkg2 = await ProductionService.confirmPackaging({
      packagingId: startPkg2.packaging.id,
      goodQty: 12,
      damagedQty: 0,
      spoiledQty: 0,
    });

    const updatedBatch2 = await prisma.productBatch.findUniqueOrThrow({ where: { id: batchId } });
    console.log(`   - Final Batch Packaged Qty: ${updatedBatch2.packagedQty} KG, Status: ${updatedBatch2.packagingStatus}`);
    if (updatedBatch2.packagedQty === 10 && updatedBatch2.packagingStatus === 'PACKAGED') {
      console.log('   ✅ PASS: Full 10 KG packaged across runs without error!');
    } else {
      console.error(`   ❌ FAIL: Expected 10 KG PACKAGED, got ${updatedBatch2.packagedQty} KG ${updatedBatch2.packagingStatus}`);
      failures++;
    }

    // ── Test 6: Double-confirmation guard ──
    console.log('\n6️⃣ Test 6: Verifying double confirmation attempt is blocked...');
    let doubleConfirmBlocked = false;
    try {
      await ProductionService.confirmPackaging({
        packagingId: startPkg2.packaging.id,
        goodQty: 12,
        damagedQty: 0,
        spoiledQty: 0,
      });
    } catch (err: any) {
      doubleConfirmBlocked = true;
      console.log(`   - Correctly blocked with message: "${err.message}"`);
    }

    if (doubleConfirmBlocked) {
      console.log('   ✅ PASS: Double confirmation blocked!');
    } else {
      console.error('   ❌ FAIL: Double confirmation was not blocked!');
      failures++;
    }

  } finally {
    // Clean up test data
    console.log('\n🧹 Cleaning up test records...');
    await prisma.stockMovement.deleteMany({ where: { note: { contains: testId } } });
    await prisma.productPackaging.deleteMany({ where: { batch: { production: { recipeId: recipe.id } } } });
    await prisma.productBatch.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.productionStageLog.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.productionItem.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.production.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipeItem.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipe.delete({ where: { id: recipe.id } });
    const testItems = await prisma.inventoryItem.findMany({ where: { sku: { contains: testId } } });
    const itemIds = testItems.map(i => i.id);
    await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.product.deleteMany({ where: { sku: { contains: testId } } });
    console.log('🧹 Cleanup complete.\n');
  }

  if (failures === 0) {
    console.log('🎉 ALL CONFIRM PACKAGING TESTS PASSED SUCCESSFULLY!');
  } else {
    console.error(`💥 ${failures} TEST(S) FAILED!`);
    process.exit(1);
  }
}

runTest()
  .catch(err => {
    console.error('Test execution error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
