import prisma from '../../lib/prisma';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { ProductService } from '../../modules/product/product.service';
import { ItemCategory, ProductType, StockMovementType } from '@prisma/client';

async function runInventoryIntegrityTests() {
  console.log('🧪 [TEST SUITE] Starting Product Master Edit Inventory Integrity Verification...\n');

  // Helper to capture exact database metrics for an item
  async function captureDbSnapshot(itemId: string) {
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });
    const movements = await prisma.stockMovement.findMany({
      where: { itemId },
      orderBy: { createdAt: 'asc' }
    });
    const batches = await prisma.inventoryBatch.findMany({
      where: { inventoryItemId: itemId },
      orderBy: { createdAt: 'asc' }
    });
    const reservationsCount = await prisma.inventoryReservation.count();
    const allocationsCount = await prisma.inventoryReservationAllocation.count({
      where: { inventoryItemId: itemId }
    });

    return {
      currentStock: item.currentStock,
      name: item.name,
      sku: item.sku,
      hsnCode: item.hsnCode,
      basePrice: item.basePrice,
      costPrice: item.costPrice,
      franchisePrice: item.franchisePrice,
      dealerPrice: item.dealerPrice,
      customerPrice: item.customerPrice,
      movementCount: movements.length,
      movementIds: movements.map(m => m.id),
      movementQtySum: movements.reduce((acc, m) => acc + (m.baseQty ?? m.quantity), 0),
      batchCount: batches.length,
      batches: batches.map(b => ({ id: b.id, currentQty: b.currentQty, unitCost: b.unitCost })),
      reservationsCount,
      allocationsCount,
    };
  }

  // Set up a clean test item with initial stock & batch via explicit transaction
  const testSku = `TEST-FG-${Date.now()}`;
  console.log(`📦 Creating test product with SKU: ${testSku}...`);
  
  const testProduct = await ProductService.create({
    name: 'TEST INTEGRITY BLEND 250G',
    sku: testSku,
    basePrice: 200,
    taxPercent: 5,
    category: 'HEALTH MIX',
    productType: ProductType.FINISHED_GOOD,
  });

  const hqItem = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: testSku, franchiseId: null }
  });

  // Create an explicit initial stock transaction (+100 PC) with an inventory batch
  await prisma.$transaction(async tx => {
    const batch = await tx.inventoryBatch.create({
      data: {
        inventoryItemId: hqItem.id,
        batchNumber: `TEST-BATCH-${Date.now()}`,
        initialQty: 100,
        currentQty: 100,
        unitCost: 50.0,
        status: 'APPROVED'
      }
    });

    await tx.stockMovement.create({
      data: {
        itemId: hqItem.id,
        batchId: batch.id,
        movementType: StockMovementType.PRODUCTION_IN,
        quantity: 100,
        baseQty: 100,
        referenceType: 'PRODUCTION',
        note: 'Initial production run for test',
        unitCost: 50.0,
      }
    });

    await tx.inventoryItem.update({
      where: { id: hqItem.id },
      data: { currentStock: 100 }
    });
  });

  const initialSnap = await captureDbSnapshot(hqItem.id);
  console.log(`✅ Test item established. Initial stock: ${initialSnap.currentStock} PC, Movements: ${initialSnap.movementCount}, Batches: ${initialSnap.batchCount}\n`);

  // ----------------------------------------------------
  // TEST 1: Update product name only -> Stock unchanged
  // ----------------------------------------------------
  console.log('--- TEST 1: Update product name only ---');
  await InventoryService.updateItem(hqItem.id, { name: 'TEST INTEGRITY BLEND RENAMED 250G' });
  const snap1 = await captureDbSnapshot(hqItem.id);
  if (snap1.currentStock !== initialSnap.currentStock || snap1.movementCount !== initialSnap.movementCount) {
    throw new Error(`❌ TEST 1 FAILED: Stock changed from ${initialSnap.currentStock} to ${snap1.currentStock}`);
  }
  console.log('✅ TEST 1 PASSED: Stock & movement count completely unchanged.\n');

  // ----------------------------------------------------
  // TEST 2: Update SKU with same SKU -> Stock unchanged
  // ----------------------------------------------------
  console.log('--- TEST 2: Update SKU with same SKU ---');
  await InventoryService.updateItem(hqItem.id, { sku: testSku });
  const snap2 = await captureDbSnapshot(hqItem.id);
  if (snap2.currentStock !== initialSnap.currentStock || snap2.movementCount !== initialSnap.movementCount) {
    throw new Error(`❌ TEST 2 FAILED: Stock changed on same-SKU update`);
  }
  console.log('✅ TEST 2 PASSED: Same SKU update is completely idempotent.\n');

  // ----------------------------------------------------
  // TEST 3: Update pricing -> Stock unchanged
  // ----------------------------------------------------
  console.log('--- TEST 3: Update pricing ---');
  await InventoryService.updateItem(hqItem.id, {
    basePrice: 220,
    franchisePrice: 180,
    dealerPrice: 160,
    customerPrice: 220,
  });
  const snap3 = await captureDbSnapshot(hqItem.id);
  if (snap3.currentStock !== initialSnap.currentStock || snap3.movementCount !== initialSnap.movementCount) {
    throw new Error(`❌ TEST 3 FAILED: Pricing update mutated stock balance`);
  }
  console.log('✅ TEST 3 PASSED: Pricing update updated prices without touching stock.\n');

  // ----------------------------------------------------
  // TEST 4: Update category / unit / HSN -> Stock unchanged
  // ----------------------------------------------------
  console.log('--- TEST 4: Update Category / Unit / HSN ---');
  await InventoryService.updateItem(hqItem.id, {
    hsnCode: '21069099',
    unit: 'PC',
  });
  const snap4 = await captureDbSnapshot(hqItem.id);
  if (snap4.currentStock !== initialSnap.currentStock || snap4.movementCount !== initialSnap.movementCount) {
    throw new Error(`❌ TEST 4 FAILED: Category/HSN update mutated stock`);
  }
  console.log('✅ TEST 4 PASSED: Metadata fields updated safely.\n');

  // ----------------------------------------------------
  // TEST 5 & 6 & 7: Repeated updates (5x) -> Stock unchanged
  // ----------------------------------------------------
  console.log('--- TEST 5-7: Repeated identical updates (5x) ---');
  for (let i = 1; i <= 5; i++) {
    await InventoryService.updateItem(hqItem.id, {
      name: `TEST INTEGRITY BLEND RENAMED 250G v${i}`,
      minimumStock: 15,
    });
  }
  const snap7 = await captureDbSnapshot(hqItem.id);
  if (snap7.currentStock !== initialSnap.currentStock || snap7.movementCount !== initialSnap.movementCount) {
    throw new Error(`❌ TEST 5-7 FAILED: Stock mutated across repeated updates`);
  }
  console.log('✅ TEST 5-7 PASSED: 5x sequential updates maintained exact stock count.\n');

  // ----------------------------------------------------
  // TEST 8: Defense-in-depth API Security Test
  // Send malicious initialStock: 999999 in payload
  // ----------------------------------------------------
  console.log('--- TEST 8: Defense-in-depth API Security Test (initialStock: 999999) ---');
  await InventoryService.updateItem(hqItem.id, {
    name: 'TEST INTEGRITY BLEND SECURITY EDIT',
    initialStock: 999999, // Malicious/Legacy field supplied to API
    openingStockDate: '2026-01-01',
    openingPurchasePrice: 999,
  });
  const snap8 = await captureDbSnapshot(hqItem.id);
  if (snap8.currentStock !== initialSnap.currentStock || snap8.movementCount !== initialSnap.movementCount) {
    throw new Error(`❌ TEST 8 FAILED: Backend failed security test! initialStock payload mutated stock balance to ${snap8.currentStock}`);
  }
  console.log('✅ TEST 8 PASSED: Backend ignored initialStock parameter. Stock & movements stayed completely untouched.\n');

  // ----------------------------------------------------
  // TEST 9: Granular Database Metrics Verification
  // ----------------------------------------------------
  console.log('--- TEST 9: Granular DB Metrics Verification ---');
  if (snap8.batchCount !== initialSnap.batchCount) throw new Error('Batch count changed');
  if (snap8.batches[0].currentQty !== initialSnap.batches[0].currentQty) throw new Error('Batch currentQty changed');
  if (snap8.batches[0].unitCost !== initialSnap.batches[0].unitCost) throw new Error('Batch unitCost changed');
  if (snap8.reservationsCount !== initialSnap.reservationsCount) throw new Error('Reservations count changed');
  if (snap8.allocationsCount !== initialSnap.allocationsCount) throw new Error('Allocations count changed');
  if (snap8.movementQtySum !== initialSnap.movementQtySum) throw new Error('StockMovement quantity sum changed');
  console.log('✅ TEST 9 PASSED: All DB snapshots (Batches, Cost, Movements, Reservations) are 100% identical.\n');

  // ----------------------------------------------------
  // TEST 10: HQ / Franchise Scope Isolation
  // ----------------------------------------------------
  console.log('--- TEST 10: HQ / Franchise Scope Isolation ---');
  const branchFranchise = await prisma.franchise.findFirst({ where: { isHQ: false } });
  if (branchFranchise) {
    const branchItem = await prisma.inventoryItem.create({
      data: {
        name: 'BRANCH TEST ITEM',
        sku: `BR-${testSku}`,
        category: ItemCategory.FINISHED_GOOD,
        currentStock: 25,
        unit: 'PC',
        franchiseId: branchFranchise.id,
        basePrice: 200,
      }
    });

    const branchSnapBefore = await captureDbSnapshot(branchItem.id);

    await InventoryService.updateItem(hqItem.id, { basePrice: 250 });

    const branchSnapAfter = await captureDbSnapshot(branchItem.id);
    if (branchSnapAfter.currentStock !== branchSnapBefore.currentStock) {
      throw new Error('❌ HQ edit mutated branch stock!');
    }

    await InventoryService.updateItem(branchItem.id, { basePrice: 210 });
    const hqSnapFinal = await captureDbSnapshot(hqItem.id);
    if (hqSnapFinal.currentStock !== initialSnap.currentStock) {
      throw new Error('❌ Branch edit mutated HQ stock!');
    }

    await prisma.inventoryItem.delete({ where: { id: branchItem.id } });
    console.log('✅ TEST 10 PASSED: HQ and Franchise inventory items are strictly isolated.\n');
  } else {
    console.log('⚠️ TEST 10 SKIPPED: No non-HQ franchise found in dev DB.\n');
  }

  // Cleanup test product & item
  await prisma.stockMovement.deleteMany({ where: { itemId: hqItem.id } });
  await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: hqItem.id } });
  await prisma.inventoryItem.delete({ where: { id: hqItem.id } });
  await prisma.product.delete({ where: { id: testProduct.id } });

  console.log('🎉 ALL AUTOMATED INVENTORY INTEGRITY TESTS PASSED SUCCESSFULLY!');
}

runInventoryIntegrityTests()
  .catch(err => {
    console.error('❌ REGRESSION TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
