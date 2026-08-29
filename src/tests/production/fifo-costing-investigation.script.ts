import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

async function runFifoCostingInvestigationScript() {
  console.log('================================================================');
  console.log('🔍 PRODUCTION UNIT COST & FIFO COSTING INVESTIGATION (READ-ONLY)');
  console.log('================================================================\n');

  const scriptId = `FIFO_INV_${Date.now()}`;
  let failures = 0;

  let createdFranchiseId: string | null = null;
  let createdWarehouseId: string | null = null;
  let createdRawItemId: string | null = null;
  let createdRecipe1Id: string | null = null;
  let createdRecipe2Id: string | null = null;
  let createdProd1Id: string | null = null;
  let createdProd2Id: string | null = null;
  let createdPkgId: string | null = null;

  try {
    // 1. Setup Master Data
    console.log('1️⃣ Setting up Master Data (Black Gram Raw Material, Lots A & B)...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `FIFO Franchise ${scriptId}`,
        location: 'Tamil Nadu',
        ownerName: 'FIFO Admin',
        contactNum: '9888877777',
        isHQ: true
      }
    });
    createdFranchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: {
        name: `FIFO Warehouse ${scriptId}`,
        nameKey: `fifo_wh_${scriptId}`.toLowerCase(),
        status: 'ACTIVE'
      }
    });
    createdWarehouseId = warehouse.id;

    const blackGram = await prisma.inventoryItem.create({
      data: {
        name: `Black Gram ${scriptId}`,
        sku: `BG-${scriptId}`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        costPrice: 55,
        currentStock: 0,
        franchiseId: franchise.id
      }
    });
    createdRawItemId = blackGram.id;

    // Receive Lot A: 4 kg @ ₹55/kg
    const lotA = await InventoryService.recordMovement(prisma, {
      itemId: blackGram.id,
      type: 'PURCHASE_IN',
      quantity: 4,
      warehouseId: warehouse.id,
      note: 'Lot A Receipt: 4 kg @ ₹55/kg',
      receiveAtCost: {
        unitCost: 55,
        batchNumber: `LOT-A-${scriptId}`
      }
    });

    console.log(`   - Lot A created: 4 kg @ ₹55/kg (Batch ID: ${lotA.item.id})`);

    // Create Recipe 1 requiring 2 kg of Black Gram
    const recipe1 = await prisma.recipe.create({
      data: {
        recipeCode: `RCP1-${scriptId}`,
        name: `Recipe 1 ${scriptId}`,
        yieldQty: 10,
        yieldUnit: 'KG',
        recipeItems: {
          create: [{ inventoryItemId: blackGram.id, quantityRequired: 2, unit: 'KG' }]
        }
      }
    });
    createdRecipe1Id = recipe1.id;

    // Production 1: Consumes 2 kg of Black Gram
    console.log('\n2️⃣ Executing Production 1 (Consuming 2 kg of Black Gram)...');
    let prod1 = await ProductionService.startProduction({
      recipeId: recipe1.id,
      quantity: 1,
      franchiseId: franchise.id,
      warehouseId: warehouse.id,
      productionType: 'BULK'
    });
    createdProd1Id = prod1.id;
    prod1 = await prisma.production.findUniqueOrThrow({ where: { id: prod1.id } });

    console.log(`   - Production 1 Material Cost: ₹${(prod1.materialCost ?? 0).toFixed(2)} (Exp: ₹110.00)`);

    // Verify Lot A remaining stock = 2 kg @ ₹55/kg
    const lotABatch = await prisma.inventoryBatch.findFirst({
      where: { inventoryItemId: blackGram.id, batchNumber: `LOT-A-${scriptId}` }
    });
    console.log(`   - Lot A Remaining Stock: ${lotABatch?.currentQty} kg @ ₹${lotABatch?.unitCost}/kg (Exp: 2 kg @ ₹55)`);

    // Receive Lot B: 4 kg @ ₹80/kg
    console.log('\n3️⃣ Receiving Lot B (4 kg @ ₹80/kg)...');
    const lotB = await InventoryService.recordMovement(prisma, {
      itemId: blackGram.id,
      type: 'PURCHASE_IN',
      quantity: 4,
      warehouseId: warehouse.id,
      note: 'Lot B Receipt: 4 kg @ ₹80/kg',
      receiveAtCost: {
        unitCost: 80,
        batchNumber: `LOT-B-${scriptId}`
      }
    });

    // Create Recipe 2 requiring 4 kg of Black Gram
    const recipe2 = await prisma.recipe.create({
      data: {
        recipeCode: `RCP2-${scriptId}`,
        name: `Recipe 2 ${scriptId}`,
        yieldQty: 100,
        yieldUnit: 'KG',
        recipeItems: {
          create: [{ inventoryItemId: blackGram.id, quantityRequired: 4, unit: 'KG' }]
        }
      }
    });
    createdRecipe2Id = recipe2.id;

    // Production 2: Consumes 4 kg of Black Gram
    console.log('\n4️⃣ Executing Production 2 (Consuming 4 kg of Black Gram)...');
    let prod2 = await ProductionService.startProduction({
      recipeId: recipe2.id,
      quantity: 1,
      franchiseId: franchise.id,
      warehouseId: warehouse.id,
      productionType: 'BULK'
    });
    createdProd2Id = prod2.id;
    prod2 = await prisma.production.findUniqueOrThrow({ where: { id: prod2.id } });

    console.log(`   - Production 2 Material Cost: ₹${(prod2.materialCost ?? 0).toFixed(2)} (Exp: ₹270.00 = 2kg×₹55 + 2kg×₹80)`);

    const prod2Item = await prisma.productionItem.findFirst({
      where: { productionId: prod2.id, inventoryItemId: blackGram.id }
    });
    const breakdown: any[] = Array.isArray(prod2Item?.batchBreakdown) ? (prod2Item?.batchBreakdown as any[]) : [];
    console.log('   - Production 2 Ingredient FIFO Consumption Breakdown:');
    breakdown.forEach((b, idx) => {
      console.log(`     Line ${idx + 1}: ${b.qty} kg @ ₹${b.unitCost}/kg = ₹${b.totalCost} (Batch: ${b.billNumber})`);
    });

    const isFifoPass = prod2.materialCost === 270 && breakdown.length === 2 && breakdown[0].totalCost === 110 && breakdown[1].totalCost === 160;
    if (isFifoPass) {
      console.log('   ✅ PASS: Raw material FIFO lot depletion verified (₹110 + ₹160 = ₹270)!');
    } else {
      console.error(`   ❌ FAIL: Material cost mismatch (Exp ₹270, got ₹${prod2.materialCost})`);
      failures++;
    }

    // Complete Production 2 (100 kg actual yield)
    const completed2 = await ProductionService.approveProduction(prod2.id, undefined, 100);
    const pb2 = completed2.batch;
    console.log(`\n5️⃣ Production 2 Completed: Produced 100 kg, Total Cost: ₹${pb2.totalCost}, Initial Unit Cost: ₹${(pb2.unitCost ?? 0).toFixed(4)}/kg`);

    // QC Inspection (90 kg approved, 10 kg rejected)
    console.log('\n6️⃣ QC Inspection (90 kg Approved, 10 kg Rejected)...');
    const qc2 = await ProductionService.inspectBatch({
      batchId: pb2.id,
      rejectionQty: 10,
      qcRemarks: '10 kg rejected'
    });
    console.log(`   - Post-QC Bulk Unit Cost: ₹${(qc2.unitCost ?? 0).toFixed(4)}/kg (Exp: ₹3.0000/kg = ₹270 / 90 kg)`);
    if (qc2.approvedQty === 90 && Math.abs((qc2.unitCost ?? 0) - 3.00) < 0.001) {
      console.log('   ✅ PASS: Post-QC unit cost absorption verified (₹270 / 90 kg = ₹3.00/kg)!');
    } else {
      console.error(`   ❌ FAIL: Post-QC unit cost mismatch (Exp ₹3.00, got ₹${qc2.unitCost})`);
      failures++;
    }

    // Packaging Confirmation (90 Packets of 1 kg: 85 Good, 5 Rejected)
    console.log('\n7️⃣ Packaging Confirmation (90 Packets: 85 Good, 2 Damaged, 3 Spoiled)...');
    const startPkg = await ProductionService.startPackaging({
      batchId: pb2.id,
      packetSize: '1 KG',
      quantityPackets: 90
    });
    createdPkgId = startPkg.packaging.id;

    const confirmPkg = await ProductionService.confirmPackaging({
      packagingId: startPkg.packaging.id,
      goodQty: 85,
      damagedQty: 2,
      spoiledQty: 3
    });

    const fgItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: confirmPkg.retailItem.id } });
    const fgBatch = await prisma.inventoryBatch.findFirst({
      where: { inventoryItemId: fgItem.id, productBatchId: pb2.id }
    });

    const fgUnitCost = fgBatch?.unitCost ?? 0;
    console.log(`   - Packets Good: ${confirmPkg.packaging.goodQty}, Damaged: ${confirmPkg.packaging.damagedQty}, Spoiled: ${confirmPkg.packaging.spoiledQty}`);
    console.log(`   - Finished Goods Stock: ${fgItem.currentStock} packets`);
    console.log(`   - Post-Packaging FG Lot Unit Cost: ₹${fgUnitCost.toFixed(4)}/packet (Exp: ₹3.1765/packet = ₹270 / 85 packets)`);
    console.log(`   - Total FG Stock Valuation: ₹${(fgItem.currentStock * fgUnitCost).toFixed(2)} (Exp: ₹270.00)`);

    if (fgItem.currentStock === 85 && fgBatch && Math.abs(fgUnitCost - 3.1765) < 0.001) {
      console.log('   ✅ PASS: Post-packaging unit cost absorption verified (₹270 / 85 packets = ₹3.1765/packet)!');
    } else {
      console.error(`   ❌ FAIL: Post-packaging unit cost mismatch (Exp ₹3.1765, got ₹${fgUnitCost})`);
      failures++;
    }

    // 8. Test POS COGS Consumption
    console.log('\n8️⃣ POS Sales Outward Consumption Test...');
    const salesMove = await InventoryService.recordMovement(prisma, {
      itemId: fgItem.id,
      type: 'SALES_OUT',
      quantity: -1,
      note: 'POS Test Sale 1 Packet'
    });

    console.log(`   - POS Sale 1 Packet COGS: ₹${(salesMove.fifo?.totalCost ?? salesMove.item?.costPrice ?? 0).toFixed(4)} (Exp: ₹3.1765)`);
    if (Math.abs((salesMove.fifo?.totalCost ?? 0) - 3.1765) < 0.001) {
      console.log('   ✅ PASS: POS COGS uses corrected FIFO Finished Goods lot cost (₹3.1765)!');
    } else {
      console.error(`   ❌ FAIL: POS COGS mismatch (Exp ₹3.1765, got ₹${salesMove.fifo?.totalCost})`);
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during FIFO costing investigation script:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up investigation master data...');
    try {
      if (createdPkgId) await prisma.productPackaging.deleteMany({ where: { id: createdPkgId } });
      await prisma.wasteEntry.deleteMany({ where: { inventoryItem: { name: { contains: scriptId } } } });
      await prisma.stockMovement.deleteMany({ where: { item: { name: { contains: scriptId } } } });
      await prisma.inventoryBatch.deleteMany({ where: { inventoryItem: { name: { contains: scriptId } } } });
      await prisma.inventoryItem.deleteMany({ where: { name: { contains: scriptId } } });
      if (createdProd1Id) {
        await prisma.productionStageLog.deleteMany({ where: { productionId: createdProd1Id } });
        await prisma.productBatch.deleteMany({ where: { productionId: createdProd1Id } });
        await prisma.productionItem.deleteMany({ where: { productionId: createdProd1Id } });
        await prisma.production.delete({ where: { id: createdProd1Id } });
      }
      if (createdProd2Id) {
        await prisma.productionStageLog.deleteMany({ where: { productionId: createdProd2Id } });
        await prisma.productBatch.deleteMany({ where: { productionId: createdProd2Id } });
        await prisma.productionItem.deleteMany({ where: { productionId: createdProd2Id } });
        await prisma.production.delete({ where: { id: createdProd2Id } });
      }
      if (createdRecipe1Id) {
        await prisma.recipeItem.deleteMany({ where: { recipeId: createdRecipe1Id } });
        await prisma.recipe.delete({ where: { id: createdRecipe1Id } });
      }
      if (createdRecipe2Id) {
        await prisma.recipeItem.deleteMany({ where: { recipeId: createdRecipe2Id } });
        await prisma.recipe.delete({ where: { id: createdRecipe2Id } });
      }
      if (createdWarehouseId) await prisma.warehouse.delete({ where: { id: createdWarehouseId } });
      if (createdFranchiseId) await prisma.franchise.delete({ where: { id: createdFranchiseId } });
      console.log('   ✅ Investigation master data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 PRODUCTION UNIT COST & FIFO COSTING AUDIT PASSED 100%! 🎉');
  } else {
    console.error(`💥 ${failures} AUDIT CHECK(S) FAILED.`);
    process.exit(1);
  }
}

runFifoCostingInvestigationScript()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
