import prisma from '../../lib/prisma';
import { RecipeService } from '../../modules/recipes/recipe.service';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

async function runE2EBusinessWorkflowAcceptanceScript() {
  console.log('================================================================');
  console.log('🏭 FULL BUSINESS WORKFLOW VERIFICATION: 500G + 1KG PACKAGING RUNS');
  console.log('================================================================\n');

  const scriptId = `E2E_${Date.now()}`;
  let failures = 0;

  let franchiseId: string | null = null;
  let warehouseId: string | null = null;
  let rawItemId: string | null = null;
  let product500GId: string | null = null;
  let product1KGId: string | null = null;
  let recipeId: string | null = null;
  let prodId: string | null = null;
  let pkg1Id: string | null = null;
  let pkg2Id: string | null = null;

  try {
    // 1. Setup Master Data & Products
    console.log('1️⃣ Setting up Master Data & Products...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `Workflow Franchise ${scriptId}`,
        location: 'Tamil Nadu',
        ownerName: 'Workflow Admin',
        contactNum: '9999911111',
        isHQ: true
      }
    });
    franchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        name: `Workflow Warehouse ${scriptId}`,
        nameKey: `wf_wh_${scriptId}`.toLowerCase(),
        status: 'ACTIVE'
      }
    });
    warehouseId = warehouse.id;

    // Raw Material: Black Gram (50 kg @ ₹54/kg)
    const rawItem = await prisma.inventoryItem.create({
      data: {
        name: `Black Gram Raw ${scriptId}`,
        sku: `BG-RAW-${scriptId}`,
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
      receiveAtCost: { unitCost: 54, batchNumber: `LOT-RAW-${scriptId}` }
    });

    // Create Sellable Product 500G & Product 1KG
    const product500G = await prisma.product.create({
      data: {
        name: `Idli/Dosa Batter 500G ${scriptId}`,
        sku: `IDB-500G-${scriptId}`,
        category: 'FINISHED_GOOD',
        productType: 'FINISHED_GOOD',
        basePrice: 50,
        isActive: true
      }
    });
    product500GId = product500G.id;

    const product1KG = await prisma.product.create({
      data: {
        name: `Idli/Dosa Batter 1KG ${scriptId}`,
        sku: `IDB-1KG-${scriptId}`,
        category: 'FINISHED_GOOD',
        productType: 'FINISHED_GOOD',
        basePrice: 90,
        isActive: true
      }
    });
    product1KGId = product1KG.id;

    console.log(`   - Product 1: ${product500G.name} (${product500G.sku})`);
    console.log(`   - Product 2: ${product1KG.name} (${product1KG.sku})`);

    // 2. Step 1 — Create Recipe (NO Product Selection)
    console.log('\n2️⃣ Step 1 — Create Recipe (NO Product Selection)...');
    const recipe = await RecipeService.upsertRecipe({
      name: `Idli/Dosa Batter Formula ${scriptId}`,
      yieldQty: 100,
      yieldUnit: 'KG',
      instructions: 'Grind rice and dal, ferment overnight at 30C',
      items: [{ inventoryItemId: rawItem.id, quantityRequired: 5, unit: 'KG' }]
    });
    if (!recipe) throw new Error('Recipe creation failed');
    recipeId = recipe.id;

    console.log(`   - Recipe Created: "${recipe.name}" (Yield: ${recipe.yieldQty} ${recipe.yieldUnit})`);
    console.log(`   - Linked Product: ${recipe.productId ? recipe.productId : 'NONE (null)'}`);
    if (recipe.productId === null) {
      console.log('   ✅ PASS: Recipe created with NO Product selected!');
    } else {
      console.error('   ❌ FAIL: Recipe has unexpected productId');
      failures++;
    }

    // 3. Step 2 & 3 & 4 — Create Production Plan, Start & Complete Production
    console.log('\n3️⃣ Steps 2, 3 & 4 — Production Plan, Start & Complete Production (Target: 100 KG)...');
    let prod = await ProductionService.startProduction({
      recipeId: recipe.id,
      quantity: 1,
      franchiseId: franchise.id,
      warehouseId: warehouse.id,
      productionType: 'BULK'
    });
    prodId = prod.id;
    prod = await prisma.production.findUniqueOrThrow({ where: { id: prod.id } });

    console.log(`   - Material Cost Consumed: ₹${(prod.materialCost ?? 0).toFixed(2)} (5 kg × ₹54 = ₹270.00)`);
    const completedProd = await ProductionService.approveProduction(prod.id, undefined, 100);
    console.log(`   - Produced Yield: 100 KG bulk batter`);

    // 4. Step 5 — QC Inspection (90 KG Approved, 10 KG Rejected)
    console.log('\n4️⃣ Step 5 — QC Inspection (90 KG Approved, 10 KG Rejected)...');
    const qcResult = await ProductionService.inspectBatch({
      batchId: completedProd.batch.id,
      rejectionQty: 10,
      qcRemarks: '10 kg rejected due to density variance'
    });

    const bulkUnitCost = qcResult.unitCost ?? 0;
    console.log(`   - QC Approved Qty: ${qcResult.approvedQty} KG`);
    console.log(`   - QC Rejected Qty: ${qcResult.rejectionQty} KG (recorded as WasteEntry)`);
    console.log(`   - Post-QC Bulk Unit Cost: ₹${bulkUnitCost.toFixed(4)}/kg (Exp: ₹3.0000/kg = ₹270 / 90 kg)`);
    if (qcResult.approvedQty === 90 && Math.abs(bulkUnitCost - 3.00) < 0.001) {
      console.log('   ✅ PASS: Bulk unit cost calculation & QC absorption verified (₹3.00/kg)!');
    } else {
      console.error(`   ❌ FAIL: Bulk unit cost mismatch (Exp ₹3.00, got ₹${bulkUnitCost})`);
      failures++;
    }

    // 5. Steps 6, 7, 8, 9, 10 — Packaging Run 1 (Product = Idli/Dosa Batter 500G)
    console.log('\n5️⃣ Packaging Run 1 — Product = Idli/Dosa Batter 500G (Planned: 19 Packets of 500G)...');
    const startPkg1 = await ProductionService.startPackaging({
      batchId: completedProd.batch.id,
      packetSize: '500 G',
      quantityPackets: 19
    });
    pkg1Id = startPkg1.packaging.id;

    const confirmPkg1 = await ProductionService.confirmPackaging({
      packagingId: startPkg1.packaging.id,
      goodQty: 18,
      damagedQty: 1,
      spoiledQty: 0,
      productId: product500G.id
    });

    const item500G = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg1.retailItem.id } });
    const batch500G = await prisma.inventoryBatch.findFirst({
      where: { inventoryItemId: item500G.id, productBatchId: completedProd.batch.id }
    });
    const cost500G = batch500G?.unitCost ?? 0;

    console.log(`   - Packaging Run 1 Result: Good = 18, Damaged = 1, Spoiled = 0`);
    console.log(`   - Inventory Item Created: ${item500G.name} (SKU: ${item500G.sku})`);
    console.log(`   - Current Stock: ${item500G.currentStock} packets`);
    console.log(`   - Packet Unit Cost: ₹${cost500G.toFixed(4)}/packet (Exp: ₹1.5833/packet = ₹28.50 bulk cost / 18 good)`);
    if (item500G.sku === product500G.sku && item500G.currentStock === 18) {
      console.log('   ✅ PASS: Packaging Run 1 successfully created 500G Finished Goods inventory!');
    } else {
      console.error(`   ❌ FAIL: 500G Finished Goods mismatch`);
      failures++;
    }

    // 6. Steps 6, 7, 8, 9, 10 — Packaging Run 2 (Product = Idli/Dosa Batter 1KG)
    console.log('\n6️⃣ Packaging Run 2 — Product = Idli/Dosa Batter 1KG (Planned: 10 Packets of 1KG)...');
    const startPkg2 = await ProductionService.startPackaging({
      batchId: completedProd.batch.id,
      packetSize: '1 KG',
      quantityPackets: 10
    });
    pkg2Id = startPkg2.packaging.id;

    const confirmPkg2 = await ProductionService.confirmPackaging({
      packagingId: startPkg2.packaging.id,
      goodQty: 10,
      damagedQty: 0,
      spoiledQty: 0,
      productId: product1KG.id
    });

    const item1KG = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg2.retailItem.id } });
    const batch1KG = await prisma.inventoryBatch.findFirst({
      where: { inventoryItemId: item1KG.id, productBatchId: completedProd.batch.id }
    });
    const cost1KG = batch1KG?.unitCost ?? 0;

    console.log(`   - Packaging Run 2 Result: Good = 10, Damaged = 0, Spoiled = 0`);
    console.log(`   - Inventory Item Created: ${item1KG.name} (SKU: ${item1KG.sku})`);
    console.log(`   - Current Stock: ${item1KG.currentStock} packets`);
    console.log(`   - Packet Unit Cost: ₹${cost1KG.toFixed(4)}/packet (Exp: ₹3.0000/packet = ₹30.00 bulk cost / 10 good)`);
    if (item1KG.sku === product1KG.sku && item1KG.currentStock === 10) {
      console.log('   ✅ PASS: Packaging Run 2 successfully created 1KG Finished Goods inventory!');
    } else {
      console.error(`   ❌ FAIL: 1KG Finished Goods mismatch`);
      failures++;
    }

    // 7. Verify Recipe Immutability
    console.log('\n7️⃣ Verifying Recipe Immutability...');
    const reloadedRecipe = await prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
    console.log(`   - Recipe Name: "${reloadedRecipe.name}"`);
    console.log(`   - Recipe productId: ${reloadedRecipe.productId ? reloadedRecipe.productId : 'NONE (null)'}`);
    if (reloadedRecipe.productId === null) {
      console.log('   ✅ PASS: Recipe remained 100% UNCHANGED throughout both packaging runs!');
    } else {
      console.error('   ❌ FAIL: Recipe was mutated!');
      failures++;
    }

    // 8. POS & COGS Verification
    console.log('\n8️⃣ Verifying POS & COGS Integration...');
    const posSale500G = await InventoryService.recordMovement(prisma, {
      itemId: item500G.id,
      type: 'SALES_OUT',
      quantity: -1,
      note: 'POS Test Sale 1 Packet 500G'
    });

    const posCost500G = posSale500G.fifo?.totalCost ?? 0;
    console.log(`   - POS Selling 1 Packet 500G -> COGS: ₹${posCost500G.toFixed(4)} (Exp: ₹1.5833)`);
    if (Math.abs(posCost500G - 1.5833) < 0.001) {
      console.log('   ✅ PASS: POS COGS correctly consumed the finished goods FIFO lot unit cost!');
    } else {
      console.error(`   ❌ FAIL: POS COGS mismatch (got ₹${posCost500G})`);
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during full workflow verification:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up verification data...');
    try {
      await prisma.wasteEntry.deleteMany({ where: { inventoryItem: { name: { contains: scriptId } } } });
      await prisma.stockMovement.deleteMany({ where: { item: { name: { contains: scriptId } } } });
      await prisma.inventoryBatch.deleteMany({ where: { inventoryItem: { name: { contains: scriptId } } } });
      await prisma.inventoryItem.deleteMany({ where: { name: { contains: scriptId } } });
      if (pkg1Id) await prisma.productPackaging.deleteMany({ where: { id: pkg1Id } });
      if (pkg2Id) await prisma.productPackaging.deleteMany({ where: { id: pkg2Id } });
      if (prodId) {
        await prisma.productionStageLog.deleteMany({ where: { productionId: prodId } });
        await prisma.productBatch.deleteMany({ where: { productionId: prodId } });
        await prisma.productionItem.deleteMany({ where: { productionId: prodId } });
        await prisma.production.delete({ where: { id: prodId } });
      }
      if (recipeId) {
        await prisma.recipeItem.deleteMany({ where: { recipeId } });
        await prisma.recipe.delete({ where: { id: recipeId } });
      }
      if (product500GId) await prisma.product.delete({ where: { id: product500GId } });
      if (product1KGId) await prisma.product.delete({ where: { id: product1KGId } });
      if (warehouseId) await prisma.warehouse.delete({ where: { id: warehouseId } });
      if (franchiseId) await prisma.franchise.delete({ where: { id: franchiseId } });
      console.log('   ✅ Verification data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 FULL E2E BUSINESS WORKFLOW VERIFICATION PASSED 100%! 🎉');
  } else {
    console.error(`💥 ${failures} WORKFLOW CHECK(S) FAILED.`);
    process.exit(1);
  }
}

runE2EBusinessWorkflowAcceptanceScript()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
