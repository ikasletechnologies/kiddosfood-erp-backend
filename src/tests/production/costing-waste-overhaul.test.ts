import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

async function runCostingWasteOverhaulTest() {
  console.log('================================================================');
  console.log('🧪 PRODUCTION COSTING + WASTE IMPACT END-TO-END ACCEPTANCE TEST');
  console.log('================================================================\n');

  let failures = 0;
  const testId = `COST_${Date.now()}`;

  let createdFranchiseId: string | null = null;
  let createdWarehouseId: string | null = null;
  let createdRecipeId: string | null = null;
  let createdRawItemId: string | null = null;
  let createdProductionId: string | null = null;
  let createdPackagingId: string | null = null;

  try {
    // 1. Setup Test Master Data
    console.log('1️⃣ Setting up Master Data (Raw Material, Recipe, Franchise, Warehouse)...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `Costing Franchise ${testId}`,
        location: 'Maharashtra',
        ownerName: 'Owner',
        contactNum: '9999922222',
        isHQ: true
      }
    });
    createdFranchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        name: `Costing Warehouse ${testId}`,
        nameKey: `costing_warehouse_${testId}`.toLowerCase(),
        status: 'ACTIVE'
      }
    });
    createdWarehouseId = warehouse.id;

    // Create raw material ingredient with stock = 1000 KG @ ₹10/KG
    const rawItem = await prisma.inventoryItem.create({
      data: {
        name: `Costing Raw Material ${testId}`,
        sku: `RAW-${testId}`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        costPrice: 10,
        currentStock: 0,
        franchiseId: franchise.id
      }
    });
    createdRawItemId = rawItem.id;

    // Seed 1000 KG raw material stock into the warehouse via InventoryService.recordMovement
    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id,
      type: 'PURCHASE_IN',
      quantity: 1000,
      warehouseId: warehouse.id,
      note: 'Opening raw material stock for costing test',
      receiveAtCost: {
        unitCost: 10,
        batchNumber: `BATCH-RAW-${testId}`
      }
    });

    const uniqueName = `RecipeRun_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    // Create Recipe yielding 100 KG using 100 KG of raw material (Total raw material cost = ₹1,000)
    const recipe = await txOrPrisma(prisma, async (tx) => {
      return tx.recipe.create({
        data: {
          recipeCode: `RCP-${testId}`,
          name: uniqueName,
          yieldQty: 100,
          yieldUnit: 'KG',
          recipeItems: {
            create: [
              {
                inventoryItemId: rawItem.id,
                quantityRequired: 100,
                unit: 'KG'
              }
            ]
          }
        }
      });
    });
    createdRecipeId = recipe.id;

    // 2. Start & Complete Production
    console.log('\n2️⃣ Starting & Completing Production Run (Target Yield: 100 KG)...');
    const production = await ProductionService.startProduction({
      recipeId: recipe.id,
      quantity: 1, // 1 batch run = 100 KG yield
      franchiseId: franchise.id,
      warehouseId: warehouse.id,
      productionType: 'BULK'
    });
    createdProductionId = production.id;

    const completed = await ProductionService.approveProduction(production.id, undefined, 100);
    const productBatch = completed.batch;

    console.log(`   - Produced: ${productBatch.quantity} KG, Total Cost: ₹${productBatch.totalCost}, Initial Unit Cost: ₹${(productBatch.unitCost ?? 0).toFixed(4)}/KG`);

    if (productBatch.totalCost === 1000 && productBatch.unitCost === 10) {
      console.log('   ✅ Initial production cost verified (₹1,000 total cost / 100 KG = ₹10.00/KG).');
    } else {
      console.error(`   ❌ Initial production cost mismatch (Exp ₹1,000, got ₹${productBatch.totalCost}).`);
      failures++;
    }

    // 3. Perform QC Inspection (90 KG Approved, 10 KG Rejected)
    console.log('\n3️⃣ Performing QC Inspection (90 KG Approved, 10 KG Rejected)...');
    const qcResult = await ProductionService.inspectBatch({
      batchId: productBatch.id,
      rejectionQty: 10,
      qcRemarks: '10 KG failed moisture check'
    });

    console.log(`   - QC Approved: ${qcResult.approvedQty} KG, QC Rejected: ${qcResult.rejectionQty} KG`);
    console.log(`   - Effective Bulk Unit Cost (post-QC): ₹${(qcResult.unitCost ?? 0).toFixed(4)}/KG (Exp: ₹11.1111/KG)`);

    if (qcResult.approvedQty === 90 && Math.abs((qcResult.unitCost ?? 0) - 11.1111) < 0.001) {
      console.log('   ✅ PASS: QC Rejection cost absorption verified! (₹1,000 total cost / 90 KG approved = ₹11.1111/KG).');
    } else {
      console.error(`   ❌ FAIL: Effective bulk unit cost mismatch (Exp ₹11.1111, got ₹${qcResult.unitCost}).`);
      failures++;
    }

    // 4. Start & Confirm Packaging (90 Packets planned, 85 Good, 5 Rejected)
    console.log('\n4️⃣ Starting & Confirming Packaging (90 Packets of 1 KG: 85 Good, 5 Rejected)...');
    const startPkg = await ProductionService.startPackaging({
      batchId: productBatch.id,
      packetSize: '1 KG',
      quantityPackets: 90
    });
    createdPackagingId = startPkg.packaging.id;

    const confirmPkg = await ProductionService.confirmPackaging({
      packagingId: startPkg.packaging.id,
      goodQty: 85,
      damagedQty: 2,
      spoiledQty: 3
    });

    // Check created retail Finished Goods item & lot cost
    const freshRetailItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg.retailItem.id } });
    const fgBatch = await prisma.inventoryBatch.findFirst({
      where: { inventoryItemId: freshRetailItem.id, productBatchId: productBatch.id }
    });

    const fgUnitCost = fgBatch?.unitCost ?? 0;
    console.log(`   - Packets Good: ${confirmPkg.packaging.goodQty}, Damaged: ${confirmPkg.packaging.damagedQty}, Spoiled: ${confirmPkg.packaging.spoiledQty}`);
    console.log(`   - Retail FG Item: ${freshRetailItem.name} (${freshRetailItem.sku}), Current Stock: ${freshRetailItem.currentStock} packets`);
    console.log(`   - Retail Lot Unit Cost (post-Packaging): ₹${fgUnitCost.toFixed(4)}/packet (Exp: ₹11.7647/packet)`);
    console.log(`   - Total FG Inventory Valuation: ₹${(freshRetailItem.currentStock * fgUnitCost).toFixed(2)} (Exp: ₹1,000.00)`);

    if (
      freshRetailItem.currentStock === 85 &&
      fgBatch &&
      Math.abs(fgUnitCost - 11.7647) < 0.001 &&
      Math.abs((freshRetailItem.currentStock * fgUnitCost) - 1000) < 0.1
    ) {
      console.log('   ✅ PASS: Packaging Rejection cost absorption verified! (₹1,000 total cost / 85 good packets = ₹11.7647/packet, total valuation = ₹1,000.00).');
    } else {
      console.error(`   ❌ FAIL: Retail finished goods unit cost absorption mismatch (Exp ₹11.7647, got ₹${fgUnitCost}).`);
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during Costing & Waste Overhaul test:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up test master data...');
    try {
      if (createdPackagingId) await prisma.productPackaging.deleteMany({ where: { id: createdPackagingId } });
      await prisma.wasteEntry.deleteMany({ where: { OR: [{ inventoryItem: { name: { contains: 'RecipeRun' } } }, { inventoryItem: { name: { contains: 'BatchRun' } } }, { inventoryItem: { name: { contains: 'Costing' } } }] } });
      await prisma.stockMovement.deleteMany({ where: { OR: [{ item: { name: { contains: 'RecipeRun' } } }, { item: { name: { contains: 'BatchRun' } } }, { item: { name: { contains: 'Costing' } } }] } });
      await prisma.inventoryBatch.deleteMany({ where: { OR: [{ inventoryItem: { name: { contains: 'RecipeRun' } } }, { inventoryItem: { name: { contains: 'BatchRun' } } }, { inventoryItem: { name: { contains: 'Costing' } } }] } });
      await prisma.inventoryItem.deleteMany({ where: { OR: [{ name: { contains: 'RecipeRun' } }, { name: { contains: 'BatchRun' } }, { name: { contains: 'Costing' } }] } });
      if (createdProductionId) {
        await prisma.productionStageLog.deleteMany({ where: { productionId: createdProductionId } });
        await prisma.productBatch.deleteMany({ where: { productionId: createdProductionId } });
        await prisma.productionItem.deleteMany({ where: { productionId: createdProductionId } });
        await prisma.production.delete({ where: { id: createdProductionId } });
      }
      if (createdRecipeId) {
        await prisma.recipeItem.deleteMany({ where: { recipeId: createdRecipeId } });
        await prisma.recipe.delete({ where: { id: createdRecipeId } });
      }
      if (createdWarehouseId) await prisma.warehouse.delete({ where: { id: createdWarehouseId } });
      if (createdFranchiseId) await prisma.franchise.delete({ where: { id: createdFranchiseId } });
      console.log('   ✅ Test master data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 PRODUCTION COSTING + WASTE IMPACT ACCEPTANCE TEST PASSED! 🎉');
  } else {
    console.error(`💥 ${failures} TEST(S) FAILED.`);
    process.exit(1);
  }
}

async function txOrPrisma(client: any, fn: (tx: any) => Promise<any>) {
  return fn(client);
}

runCostingWasteOverhaulTest()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
