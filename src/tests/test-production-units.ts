/**
 * test-production-units.ts
 *
 * End-to-end regression suite for Phase 5: Production & Recipe unit handling.
 *
 * Proves:
 *   1. Inventory: 8 KG → 8,000 G stored
 *   2. Recipe: 500 G requirement
 *   3. After production: 7,500 G remaining → 7.5 KG display
 *   4. Target yield: 2 KG → ProductBatch.quantity = 2 (in recipe.yieldUnit = KG)
 *   5. Incompatible units (G vs ML) are rejected
 *   6. Scaling: Recipe 500 G @ 1x → 1000 G @ 2x scalar
 */

import prisma from '../lib/prisma';
import { InventoryService } from '../modules/inventory/inventory.service';
import { ProductionService } from '../modules/production/production.service';
import { StockMovementType } from '@prisma/client';

async function runTests() {
  console.log('\n=== Phase 5 Production Unit Tests ===\n');

  // ─── Setup ─────────────────────────────────────────────────────────────────
  // Franchise (required FK on Production)
  let franchise = await prisma.franchise.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!franchise) {
    franchise = await prisma.franchise.create({
      data: { name: 'Test Franchise', location: 'N/A', ownerName: 'N/A', contactNum: 'N/A', status: 'ACTIVE' },
    });
  }

  // Inventory items (canonical unit = g)
  const flour = await prisma.inventoryItem.create({
    data: {
      name: 'Test Flour PRD',
      sku: 'PRDFLOUR',
      category: 'RAW_MATERIAL',
      unit: 'g',          // canonical
      currentStock: 0,
      costPrice: 0.01,
      isActive: true,
      minimumStock: 100,
      franchiseId: franchise.id,
    },
  });

  const milk = await prisma.inventoryItem.create({
    data: {
      name: 'Test Milk PRD',
      sku: 'PRDMLK',
      category: 'RAW_MATERIAL',
      unit: 'ml',         // canonical (volume)
      currentStock: 0,
      costPrice: 0.05,
      isActive: true,
      minimumStock: 100,
      franchiseId: franchise.id,
    },
  });

  // Seed stock: 8 KG of flour → should normalize to 8,000 g
  await InventoryService.stockIn({
    itemId: flour.id,
    quantity: 8,
    unit: 'KG',
    type: StockMovementType.PURCHASE_IN,
    note: 'Test seed 8 KG',
  });

  // Seed stock: 5 L of milk → should normalize to 5,000 ml
  await InventoryService.stockIn({
    itemId: milk.id,
    quantity: 5,
    unit: 'L',
    type: StockMovementType.PURCHASE_IN,
    note: 'Test seed 5 L',
  });

  let flourItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } });
  let milkItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: milk.id } });
  console.log(`Flour stock after seed: ${flourItem.currentStock} ${flourItem.unit} (expected 8000 g)`);
  console.log(`Milk stock after seed: ${milkItem.currentStock} ${milkItem.unit} (expected 5000 ml)`);

  if (flourItem.currentStock !== 8000) throw new Error(`FAIL seeding flour: expected 8000, got ${flourItem.currentStock}`);
  if (milkItem.currentStock !== 5000) throw new Error(`FAIL seeding milk: expected 5000, got ${milkItem.currentStock}`);

  // Recipe: yields 2 KG; uses 500 g flour + 500 ml milk per run
  const recipe = await prisma.recipe.create({
    data: {
      name: 'Test Bread PRD',
      recipeCode: 'TBRPRD',
      yieldQty: 2,
      yieldUnit: 'KG',
      recipeItems: {
        create: [
          { inventoryItemId: flour.id, quantityRequired: 500, unit: 'g' },
          { inventoryItemId: milk.id, quantityRequired: 500, unit: 'ml' },
        ],
      },
    },
  });
  console.log(`\nRecipe created: ${recipe.name} (yield ${recipe.yieldQty} ${recipe.yieldUnit})`);

  // ─── Test 1: Availability check + production (scalar=1) ────────────────────
  console.log('\n--- Test 1: Start production (1 batch run) ---');
  console.log('Expected: consumes 500 g flour + 500 ml milk');

  const prod = await ProductionService.startProduction({
    recipeId: recipe.id,
    quantity: 1,           // 1 batch run (scalar)
    franchiseId: franchise.id,
    productionType: 'FINISHED_GOOD',
    userId: 'test',
  });
  console.log(`Production created: ${prod.id}`);

  flourItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } });
  milkItem  = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: milk.id } });

  console.log(`Flour after production: ${flourItem.currentStock} g (expected 7500)`);
  console.log(`Milk after production: ${milkItem.currentStock} ml (expected 4500)`);

  if (flourItem.currentStock !== 7500) throw new Error(`FAIL Test 1 flour: expected 7500, got ${flourItem.currentStock}`);
  if (milkItem.currentStock !== 4500)  throw new Error(`FAIL Test 1 milk: expected 4500, got ${milkItem.currentStock}`);
  console.log('Test 1 PASSED ✓');

  // ─── Test 2: Scaling (scalar=2 → 1000 g flour + 1000 ml milk) ─────────────
  console.log('\n--- Test 2: Start production (2 batch runs, scalar=2) ---');
  console.log('Expected: consumes 1000 g flour + 1000 ml milk');

  const prod2 = await ProductionService.startProduction({
    recipeId: recipe.id,
    quantity: 2,
    franchiseId: franchise.id,
    productionType: 'FINISHED_GOOD',
    userId: 'test',
  });

  flourItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour.id } });
  milkItem  = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: milk.id } });

  console.log(`Flour after 2x production: ${flourItem.currentStock} g (expected 6500)`);
  console.log(`Milk after 2x production: ${milkItem.currentStock} ml (expected 3500)`);

  if (flourItem.currentStock !== 6500) throw new Error(`FAIL Test 2 flour: expected 6500, got ${flourItem.currentStock}`);
  if (milkItem.currentStock !== 3500)  throw new Error(`FAIL Test 2 milk: expected 3500, got ${milkItem.currentStock}`);
  console.log('Test 2 PASSED ✓');

  // ─── Test 3: Verify ledger transactionUnit is persisted correctly ───────────
  console.log('\n--- Test 3: Ledger records transactionUnit correctly ---');
  const ledgerRows = await prisma.stockMovement.findMany({
    where: {
      itemId: flour.id,
      movementType: 'PRODUCTION_OUT',
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const row of ledgerRows) {
    console.log(`  Ledger row: quantity=${row.quantity}, transactionUnit=${row.transactionUnit}, baseQty=${row.baseQty}`);
    if (row.transactionUnit !== 'g') throw new Error(`FAIL Test 3: expected transactionUnit 'g', got '${row.transactionUnit}'`);
    // baseQty should be the canonical (g) equivalent — same as quantity since recipe unit == canonical unit
    if (row.baseQty === null || row.baseQty === undefined) throw new Error('FAIL Test 3: baseQty should be set');
  }
  console.log('Test 3 PASSED ✓');

  // ─── Test 4: Incompatible units rejected ───────────────────────────────────
  console.log('\n--- Test 4: Incompatible units (G flour vs ML-stocked item) rejected ---');

  // Create a cross-dimension recipe: flour (g) used against an item tracked in ml
  const mlTrackedItem = await prisma.inventoryItem.create({
    data: {
      name: 'Test ML Item PRD',
      sku: 'PRDMLTEST',
      category: 'RAW_MATERIAL',
      unit: 'ml',         // volume canonical
      currentStock: 5000,
      costPrice: 0.01,
      isActive: true,
      minimumStock: 10,
    },
  });

  const badRecipe = await prisma.recipe.create({
    data: {
      name: 'Bad Recipe PRD',
      recipeCode: 'BADRPRD',
      yieldQty: 1,
      yieldUnit: 'KG',
      recipeItems: {
        create: [
          { inventoryItemId: mlTrackedItem.id, quantityRequired: 500, unit: 'g' }, // G vs ML — incompatible
        ],
      },
    },
  });

  let incompatibleRejected = false;
  try {
    await ProductionService.startProduction({
      recipeId: badRecipe.id,
      quantity: 1,
      franchiseId: franchise.id,
      productionType: 'FINISHED_GOOD',
      userId: 'test',
    });
  } catch (e: any) {
    if (e.message.includes('Unit mismatch') || e.message.includes('ncompatible')) {
      incompatibleRejected = true;
      console.log(`  Rejected with: ${e.message.substring(0, 100)}...`);
    } else {
      throw e;
    }
  }
  if (!incompatibleRejected) throw new Error('FAIL Test 4: incompatible units should have been rejected');
  console.log('Test 4 PASSED ✓');

  // ─── Test 5: Production yield stored in recipe.yieldUnit ──────────────────
  console.log('\n--- Test 5: Production yield = scalar × recipe.yieldQty in yieldUnit ---');
  // prod was scalar=1, yieldQty=2 → totalYield=2 KG
  // ProductBatch is only created by approveProduction, not startProduction
  await ProductionService.approveProduction(prod.id, 'test', undefined, 'Test complete');
  const batch1 = await prisma.productBatch.findFirst({ where: { productionId: prod.id } });
  if (!batch1) throw new Error('FAIL Test 5: No ProductBatch found for prod1');
  console.log(`  ProductBatch.quantity = ${batch1.quantity} (expected 2, in ${recipe.yieldUnit})`);
  if (batch1.quantity !== 2) throw new Error(`FAIL Test 5: expected 2, got ${batch1.quantity}`);
  console.log('Test 5 PASSED ✓');

  console.log('\n=== All Phase 5 Tests PASSED ✓ ===\n');
}

async function cleanup() {
  console.log('Cleaning up test data...');
  await prisma.productionStageLog.deleteMany({ where: { production: { franchise: { name: 'Test Franchise' } } } });
  await prisma.productionItem.deleteMany({ where: { production: { franchise: { name: 'Test Franchise' } } } });
  await prisma.productBatch.deleteMany({ where: { production: { franchise: { name: 'Test Franchise' } } } });
  await prisma.production.deleteMany({ where: { franchise: { name: 'Test Franchise' } } });
  await prisma.recipeItem.deleteMany({ where: { recipe: { name: { contains: 'PRD' } } } });
  await prisma.recipe.deleteMany({ where: { name: { contains: 'PRD' } } });
  await prisma.stockMovement.deleteMany({ where: { item: { sku: { startsWith: 'PRD' } } } });
  await prisma.inventoryItem.deleteMany({ where: { sku: { startsWith: 'PRD' } } });
  await prisma.$disconnect();
}

runTests()
  .catch(e => { console.error('\nTest suite failed:', e.message); })
  .finally(cleanup);
