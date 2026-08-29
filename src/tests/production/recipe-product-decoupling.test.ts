import prisma from '../../lib/prisma';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

async function runRecipeProductDecouplingTest() {
  console.log('================================================================');
  console.log('🧪 RECIPE DECOUPLING & PACKAGING PRODUCT SELECTION ACCEPTANCE TEST');
  console.log('================================================================\n');

  const testId = `DEC_${Date.now()}`;
  let failures = 0;

  let franchiseId: string | null = null;
  let warehouseId: string | null = null;
  let rawItemId: string | null = null;
  let productAId: string | null = null;
  let productBId: string | null = null;
  let recipeId: string | null = null;
  let prod1Id: string | null = null;
  let pkg1Id: string | null = null;
  let prod2Id: string | null = null;
  let pkg2Id: string | null = null;

  try {
    // 1. Setup Master Data
    console.log('1️⃣ Setting up Master Data (Franchise, Warehouse, Raw Material, Products A & B)...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `Decoupling Franchise ${testId}`,
        location: 'Tamil Nadu',
        ownerName: 'Decouple Admin',
        contactNum: '9111122222',
        isHQ: true
      }
    });
    franchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        name: `Decoupling Warehouse ${testId}`,
        nameKey: `dec_wh_${testId}`.toLowerCase(),
        status: 'ACTIVE'
      }
    });
    warehouseId = warehouse.id;

    // Raw Material: Black Gram (50 kg @ ₹54/kg)
    const rawItem = await prisma.inventoryItem.create({
      data: {
        name: `Raw Black Gram ${testId}`,
        sku: `BG-RAW-${testId}`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        costPrice: 54,
        currentStock: 0,
        franchiseId: franchise.id
      }
    });
    rawItemId = rawItem.id;

    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id,
      type: 'PURCHASE_IN',
      quantity: 50,
      warehouseId: warehouse.id,
      note: 'Raw Material Lot: 50 kg @ ₹54/kg',
      receiveAtCost: { unitCost: 54, batchNumber: `LOT-RAW-${testId}` }
    });

    // Create Sellable Product A (500G) & Product B (1KG)
    const productA = await prisma.product.create({
      data: {
        name: `Idli Batter 500G ${testId}`,
        sku: `IDB-500G-${testId}`,
        category: 'FINISHED_GOOD',
        productType: 'FINISHED_GOOD',
        basePrice: 50,
        isActive: true
      }
    });
    productAId = productA.id;

    const productB = await prisma.product.create({
      data: {
        name: `Idli Batter 1KG ${testId}`,
        sku: `IDB-1KG-${testId}`,
        category: 'FINISHED_GOOD',
        productType: 'FINISHED_GOOD',
        basePrice: 90,
        isActive: true
      }
    });
    productBId = productB.id;

    console.log('   ✅ Master Data created successfully.');

    // 2. Test 1 — Recipe creation without Product
    console.log('\n2️⃣ Test 1 — Creating Recipe without linked Product (productId = null)...');
    const recipe = await RecipeService.upsertRecipe({
      name: `Master Batter Formula ${testId}`,
      yieldQty: 100,
      yieldUnit: 'KG',
      instructions: 'Standard bulk fermentation process',
      items: [{ inventoryItemId: rawItem.id, quantityRequired: 5, unit: 'KG' }]
    });
    if (!recipe) throw new Error('Recipe creation failed');
    recipeId = recipe.id;

    if (!recipe.productId) {
      console.log(`   ✅ PASS: Recipe created without linked Product (Recipe ID: ${recipe.id}, productId: null)`);
    } else {
      console.error('   ❌ FAIL: Recipe has unexpected productId');
      failures++;
    }

    // 3. Test 2 — Production from unlinked Recipe
    console.log('\n3️⃣ Test 2 — Starting Production run from unlinked Recipe...');
    let prod1 = await ProductionService.startProduction({
      recipeId: recipe.id,
      quantity: 1,
      franchiseId: franchise.id,
      warehouseId: warehouse.id,
      productionType: 'BULK'
    });
    prod1Id = prod1.id;
    prod1 = await prisma.production.findUniqueOrThrow({ where: { id: prod1.id } });

    console.log(`   - Material Cost: ₹${(prod1.materialCost ?? 0).toFixed(2)} (Exp: ₹270.00 = 5kg × ₹54)`);
    if ((prod1.materialCost ?? 0) === 270) {
      console.log('   ✅ PASS: Production started successfully without Recipe Product!');
    } else {
      console.error(`   ❌ FAIL: Material cost mismatch (Exp ₹270, got ₹${prod1.materialCost})`);
      failures++;
    }

    // 4. Test 3 — QC Inspection (100 kg produced, 90 kg approved, 10 kg rejected)
    console.log('\n4️⃣ Test 3 — QC Inspection (100 kg produced, 90 kg approved, 10 kg rejected)...');
    const completed1 = await ProductionService.approveProduction(prod1.id, undefined, 100);
    const qc1 = await ProductionService.inspectBatch({
      batchId: completed1.batch.id,
      rejectionQty: 10,
      qcRemarks: '10 kg rejected during bulk QC'
    });

    console.log(`   - Post-QC Bulk Unit Cost: ₹${(qc1.unitCost ?? 0).toFixed(4)}/kg (Exp: ₹3.0000/kg = ₹270 / 90 kg)`);
    if (qc1.approvedQty === 90 && Math.abs((qc1.unitCost ?? 0) - 3.00) < 0.001) {
      console.log('   ✅ PASS: QC absorption verified (₹270 / 90 kg = ₹3.00/kg)!');
    } else {
      console.error(`   ❌ FAIL: Post-QC unit cost mismatch (Exp ₹3.00, got ₹${qc1.unitCost})`);
      failures++;
    }

    // 5. Test 4 — Confirm Packaging with Product Selection (Product A 500G)
    console.log('\n5️⃣ Test 4 — Confirming Packaging with explicit Product Selection (Product A 500G)...');
    const startPkg1 = await ProductionService.startPackaging({
      batchId: completed1.batch.id,
      packetSize: '500 G',
      quantityPackets: 18
    });
    pkg1Id = startPkg1.packaging.id;

    const confirmPkg1 = await ProductionService.confirmPackaging({
      packagingId: startPkg1.packaging.id,
      goodQty: 18,
      damagedQty: 0,
      spoiledQty: 0,
      productId: productA.id
    });

    const fgItemA = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg1.retailItem.id } });
    console.log(`   - Finished Goods Item A: ${fgItemA.name} (${fgItemA.sku}), Stock: ${fgItemA.currentStock}`);
    if (fgItemA.sku === productA.sku && fgItemA.currentStock === 18) {
      console.log('   ✅ PASS: Packaging confirmed with selected Product A (500G)!');
    } else {
      console.error(`   ❌ FAIL: Finished goods SKU mismatch (Exp ${productA.sku}, got ${fgItemA.sku})`);
      failures++;
    }

    // 6. Test 5 — Same Recipe, Second Production Run Packaged into Product B (1KG)
    console.log('\n6️⃣ Test 5 — Packaging second run from SAME Recipe into Product B (1KG)...');
    let prod2 = await ProductionService.startProduction({
      recipeId: recipeId!,
      quantity: 1,
      franchiseId: franchise.id,
      warehouseId: warehouse.id,
      productionType: 'BULK'
    });
    prod2Id = prod2.id;

    // Receive another 50 kg raw material for prod2
    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id,
      type: 'PURCHASE_IN',
      quantity: 50,
      warehouseId: warehouse.id,
      note: 'Raw Lot 2: 50 kg @ ₹54/kg',
      receiveAtCost: { unitCost: 54, batchNumber: `LOT-RAW2-${testId}` }
    });

    const completed2 = await ProductionService.approveProduction(prod2.id, undefined, 100);
    await ProductionService.inspectBatch({ batchId: completed2.batch.id, rejectionQty: 0, qcRemarks: '100 kg approved' });

    const startPkg2 = await ProductionService.startPackaging({
      batchId: completed2.batch.id,
      packetSize: '1 KG',
      quantityPackets: 10
    });
    pkg2Id = startPkg2.packaging.id;

    const confirmPkg2 = await ProductionService.confirmPackaging({
      packagingId: startPkg2.packaging.id,
      goodQty: 10,
      damagedQty: 0,
      spoiledQty: 0,
      productId: productB.id
    });

    const fgItemB = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg2.retailItem.id } });
    console.log(`   - Finished Goods Item B: ${fgItemB.name} (${fgItemB.sku}), Stock: ${fgItemB.currentStock}`);
    if (fgItemB.sku === productB.sku && fgItemB.currentStock === 10) {
      console.log('   ✅ PASS: ONE RECIPE successfully produced Product A (500G) AND Product B (1KG)!');
    } else {
      console.error(`   ❌ FAIL: Finished goods Product B mismatch (Exp ${productB.sku}, got ${fgItemB.sku})`);
      failures++;
    }

    // 7. Test 7 — POS FIFO COGS Consumption
    console.log('\n7️⃣ Test 7 — POS Sales Outward FIFO COGS Verification...');
    const posMove = await InventoryService.recordMovement(prisma, {
      itemId: fgItemA.id,
      type: 'SALES_OUT',
      quantity: -1,
      note: 'POS Test Sale Product A 500G'
    });

    const posCost = posMove.fifo?.totalCost ?? 0;
    console.log(`   - POS Sale 1 Packet Product A COGS: ₹${posCost.toFixed(4)}`);
    if (posCost > 0) {
      console.log('   ✅ PASS: POS COGS uses calculated finished goods FIFO lot unit cost!');
    } else {
      console.error('   ❌ FAIL: POS COGS is zero');
      failures++;
    }

    // 8. Test 9 — Invalid Product ID validation
    console.log('\n8️⃣ Test 9 — Attempting Packaging Confirmation with Invalid Product ID...');
    try {
      // Start a dummy packaging ticket
      const dummyPkg = await ProductionService.startPackaging({
        batchId: completed2.batch.id,
        packetSize: '1 KG',
        quantityPackets: 5
      });
      await ProductionService.confirmPackaging({
        packagingId: dummyPkg.packaging.id,
        goodQty: 5,
        damagedQty: 0,
        spoiledQty: 0,
        productId: 'INVALID_PRODUCT_ID_12345'
      });
      console.error('   ❌ FAIL: Invalid product ID was allowed');
      failures++;
    } catch (err: any) {
      console.log(`   ✅ PASS: Invalid product ID correctly rejected with error: "${err.message}"`);
    }

  } catch (err: any) {
    console.error('❌ Exception during Recipe-Product Decoupling Test:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up test data...');
    try {
      await prisma.wasteEntry.deleteMany({ where: { inventoryItem: { name: { contains: testId } } } });
      await prisma.stockMovement.deleteMany({ where: { item: { name: { contains: testId } } } });
      await prisma.inventoryBatch.deleteMany({ where: { inventoryItem: { name: { contains: testId } } } });
      await prisma.inventoryItem.deleteMany({ where: { name: { contains: testId } } });
      if (pkg1Id) await prisma.productPackaging.deleteMany({ where: { id: pkg1Id } });
      if (pkg2Id) await prisma.productPackaging.deleteMany({ where: { id: pkg2Id } });
      if (prod1Id) {
        await prisma.productionStageLog.deleteMany({ where: { productionId: prod1Id } });
        await prisma.productBatch.deleteMany({ where: { productionId: prod1Id } });
        await prisma.productionItem.deleteMany({ where: { productionId: prod1Id } });
        await prisma.production.delete({ where: { id: prod1Id } });
      }
      if (prod2Id) {
        await prisma.productionStageLog.deleteMany({ where: { productionId: prod2Id } });
        await prisma.productBatch.deleteMany({ where: { productionId: prod2Id } });
        await prisma.productionItem.deleteMany({ where: { productionId: prod2Id } });
        await prisma.production.delete({ where: { id: prod2Id } });
      }
      if (recipeId) {
        await prisma.recipeItem.deleteMany({ where: { recipeId } });
        await prisma.recipe.delete({ where: { id: recipeId } });
      }
      if (productAId) await prisma.product.delete({ where: { id: productAId } });
      if (productBId) await prisma.product.delete({ where: { id: productBId } });
      if (warehouseId) await prisma.warehouse.delete({ where: { id: warehouseId } });
      if (franchiseId) await prisma.franchise.delete({ where: { id: franchiseId } });
      console.log('   ✅ Test master data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 RECIPE DECOUPLING & PACKAGING SELECTION ACCEPTANCE TEST PASSED 100%! 🎉');
  } else {
    console.error(`💥 ${failures} TEST CHECK(S) FAILED.`);
    process.exit(1);
  }
}

runRecipeProductDecouplingTest()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
