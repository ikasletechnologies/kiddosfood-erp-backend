// End-to-end check of the simplified production workflow (production QC,
// Labels & Barcodes and Batch Recall switched off):
//   Planning -> Start -> Complete (auto Ready for Packaging) -> Package & Confirm -> Finished Goods
// Run: npx tsx src/tests/production/simplified-workflow.test.ts
import prisma from '../../lib/prisma';
import { assertBillablePrice, PRICING_PENDING } from '../../utils/selling-price.util';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { QC_NOT_REQUIRED } from '../../modules/production/production.flags';

process.env.PRODUCTION_QC_ENABLED = 'false';
process.env.PRODUCTION_LABELS_ENABLED = 'false';
process.env.PRODUCTION_RECALL_ENABLED = 'false';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`   ✅ PASS: ${label}`);
  else { console.error(`   ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
async function expectReject(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, 'call was unexpectedly allowed');
  } catch (err: any) {
    check(label, true);
    console.log(`      ↳ "${err.message}"`);
  }
}

async function runTest() {
  console.log('🧪 Simplified Production Workflow E2E\n');
  const testId = `SW${Date.now().toString().slice(-6)}`;

  const hq = (await FranchiseService.getHqFranchiseOrNull()) || (await prisma.franchise.findFirst());
  if (!hq) throw new Error('No franchise found in DB for test');
  const warehouse = (await prisma.warehouse.findFirst({ where: { status: 'ACTIVE' } })) || (await prisma.warehouse.findFirst());
  if (!warehouse) throw new Error('No warehouse found in DB for test');

  const rawItem = await prisma.inventoryItem.create({
    data: {
      name: `Raw Test Ingredient ${testId}`, sku: `RM-ING-${testId}`, category: 'RAW_MATERIAL',
      unit: 'KG', currentStock: 0, franchiseId: null, basePrice: 40, costPrice: 40,
    },
  });
  await InventoryService.recordMovement(prisma, {
    itemId: rawItem.id, type: 'PURCHASE_IN', quantity: 30, warehouseId: warehouse.id,
    note: `Initial Test Stock ${testId}`, receiveAtCost: { unitCost: 40, batchNumber: `LOT-${testId}` },
  });

  const recipe = await prisma.recipe.create({
    data: {
      name: `Test Simplified Recipe ${testId}`, recipeCode: `RCP-${testId}`, category: 'Test Category',
      yieldQty: 10, yieldUnit: 'KG',
      recipeItems: { create: [{ inventoryItemId: rawItem.id, quantityRequired: 10, unit: 'KG' }] },
    },
  });
  const fgProduct = await prisma.product.create({
    data: {
      name: `Test Packed ${testId} (500g)`, sku: `FG-${testId}-500G`, category: 'FINISHED_GOOD',
      productType: 'FINISHED_GOOD', basePrice: 100, taxPercent: 5, isActive: true,
    },
  });

  try {
    // ── 1. Start: raw material is validated and deducted, batch code generated ──
    console.log('1️⃣ Start production (1× recipe = 10 KG)');
    await expectReject('Start is refused when warehouse stock is insufficient (4× = 40 KG needed, 30 KG held)', () =>
      ProductionService.startProduction({ recipeId: recipe.id, quantity: 4, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' }));
    const prod = await ProductionService.startProduction({
      recipeId: recipe.id, quantity: 1, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD',
    });
    check('Run is IN_PROGRESS with a PRD- batch reference', prod.status === 'IN_PROGRESS' && /^PRD-\d{4}-\d{4,}$/.test(prod.productionBatchCode || ''), `${prod.status} ${prod.productionBatchCode}`);
    const rawAfterStart = await InventoryService.computeWarehouseStock(rawItem.id, warehouse.id);
    check('10 KG raw material deducted (30 → 20)', Math.abs(rawAfterStart - 20) < 0.0001, `got ${rawAfterStart}`);

    // ── 2. Complete: actual yield + wastage, no QC, straight to packaging ──
    console.log('\n2️⃣ Complete production without QC (actual 9 KG, 1 KG wastage)');
    await expectReject('Actual yield of 0 is rejected', () => ProductionService.approveProduction(prod.id, undefined, 0));
    await expectReject('Negative wastage is rejected', () => ProductionService.approveProduction(prod.id, undefined, 9, undefined, undefined, { quantity: -1 }));

    const completed = await ProductionService.approveProduction(prod.id, undefined, 9, 'test', undefined, { quantity: 1 });
    const batchId = completed.batch.id;
    check('Run is COMPLETED', completed.production.status === 'COMPLETED');
    check(`Batch marked ${QC_NOT_REQUIRED} (not a fabricated APPROVED)`, completed.batch.qcStatus === QC_NOT_REQUIRED, `got ${completed.batch.qcStatus}`);
    check('Full 9 KG released for packaging', completed.batch.approvedQty === 9, `got ${completed.batch.approvedQty}`);

    const bulkItem = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: `RCP-${testId}-BULK` } });
    check('Bulk stock credited exactly once (9 KG)', Math.abs(bulkItem.currentStock - 9) < 0.0001, `got ${bulkItem.currentStock}`);
    const wasteRows = await prisma.wasteEntry.findMany({ where: { inventoryItemId: bulkItem.id } });
    check('1 KG YIELD_LOSS wastage recorded', wasteRows.length === 1 && wasteRows[0].reason === 'YIELD_LOSS' && wasteRows[0].quantity === 1, JSON.stringify(wasteRows.map(w => [w.reason, w.quantity])));

    await expectReject('Completing the same run twice is blocked', () => ProductionService.approveProduction(prod.id, undefined, 9));
    await expectReject('Releasing an already-released batch is blocked', () => ProductionService.releaseBatchToPackaging(batchId));
    await expectReject('QC inspection cannot re-credit a released batch', () => ProductionService.inspectBatch({ batchId, rejectionQty: 0 }));
    const bulkAfterRepeats = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bulkItem.id } });
    check('Bulk stock unchanged after repeated attempts (still 9 KG)', Math.abs(bulkAfterRepeats.currentStock - 9) < 0.0001, `got ${bulkAfterRepeats.currentStock}`);

    // ── 3. Package & Confirm in one action ──
    console.log('\n3️⃣ Package & Confirm: 10 packed + 2 damaged × 500g (6 KG)');
    await expectReject('Fractional packet counts are rejected', () =>
      ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 2.5, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0 }));
    await expectReject('Packing more than the produced output is rejected (20 × 500g = 10 KG > 9 KG)', () =>
      ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 20, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0 }));

    const pk = await ProductionService.packageAndConfirm({
      batchId, packetSize: '500g', packedQty: 10, damagedQty: 2, productId: fgProduct.id, expectedPackagedQty: 0,
    });
    check('Packaging run CONFIRMED in a single call', pk.packaging.status === 'CONFIRMED' && pk.packaging.goodQty === 10 && pk.packaging.damagedQty === 2);
    const fgItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: pk.retailItem.id } });
    check('Finished goods stock = 10 packets on the selected product SKU', fgItem.currentStock === 10 && fgItem.sku === fgProduct.sku, `stock ${fgItem.currentStock}, sku ${fgItem.sku}`);
    const fgLot = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: fgItem.id, productBatchId: batchId } });
    check('FG lot carries the production batch reference', !!fgLot && fgLot.batchNumber === prod.productionBatchCode, `lot ${fgLot?.batchNumber}`);
    const bulkAfterPack = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bulkItem.id } });
    check('6 KG bulk deducted (9 → 3)', Math.abs(bulkAfterPack.currentStock - 3) < 0.0001, `got ${bulkAfterPack.currentStock}`);
    check('2 damaged packets recorded as wastage', pk.wasteEntries.length === 1 && pk.wasteEntries[0].quantity === 2);
    const pending = await prisma.productPackaging.count({ where: { batchId, status: 'AWAITING_CONFIRMATION' } });
    check('No dangling AWAITING_CONFIRMATION ticket', pending === 0, `got ${pending}`);

    // ── 4. Duplicate submission (double-click / retry with the same snapshot) ──
    console.log('\n4️⃣ Duplicate submission protection');
    await expectReject('Repeat with stale expectedPackagedQty is blocked', () =>
      ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 1, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0 }));
    const [dupA, dupB] = await Promise.allSettled([
      ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 2, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 6 }),
      ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 2, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 6 }),
    ]);
    const okCount = [dupA, dupB].filter(r => r.status === 'fulfilled').length;
    check('Two concurrent identical submissions → exactly one succeeds', okCount === 1, `${okCount} succeeded`);
    const fgAfterDup = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fgItem.id } });
    check('Finished goods credited once for the pair (10 + 2 = 12)', fgAfterDup.currentStock === 12, `got ${fgAfterDup.currentStock}`);

    // ── 5. Pack the remainder → fully packaged ──
    console.log('\n5️⃣ Pack the remaining 2 KG');
    await ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 4, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 7 });
    const finalBatch = await prisma.productBatch.findUniqueOrThrow({ where: { id: batchId } });
    check('Batch PACKAGED with 9 KG packed', finalBatch.packagingStatus === 'PACKAGED' && Math.abs((finalBatch.packagedQty || 0) - 9) < 0.0001, `${finalBatch.packagingStatus} ${finalBatch.packagedQty}`);
    await expectReject('Nothing more can be packed from a fully packaged batch', () =>
      ProductionService.packageAndConfirm({ batchId, packetSize: '500g', packedQty: 1, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 9 }));

    // ── 6. Batch stuck at PENDING (completed while QC was required / by an
    //       older server) packs directly — no manual Release step ──
    console.log("\n6️⃣ PENDING batch packs directly, released inside Confirm Packaging");
    const legacyProd = await ProductionService.startProduction({
      recipeId: recipe.id, quantity: 1, franchiseId: hq.id, warehouseId: warehouse.id, productionType: "FINISHED_GOOD",
    });
    process.env.PRODUCTION_QC_ENABLED = "true";
    const legacy = await ProductionService.approveProduction(legacyProd.id, undefined, 10);
    check("With QC enabled, completion leaves the batch PENDING (original behaviour)", legacy.batch.qcStatus === "PENDING", `got ${legacy.batch.qcStatus}`);
    await expectReject("While QC is enabled a PENDING batch cannot be packed", () =>
      ProductionService.packageAndConfirm({ batchId: legacy.batch.id, packetSize: "500g", packedQty: 2, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0 }));
    process.env.PRODUCTION_QC_ENABLED = "false";

    const fgBefore = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fgItem.id } })).currentStock;
    check("Completion alone did not add finished goods", fgBefore === 16, `got ${fgBefore}`);
    const bulkBefore = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bulkItem.id } })).currentStock;
    const direct = await ProductionService.packageAndConfirm({
      batchId: legacy.batch.id, packetSize: "500g", packedQty: 6, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0,
    });
    check("PENDING batch packed in one call", direct.packaging.status === "CONFIRMED");
    const legacyAfter = await prisma.productBatch.findUniqueOrThrow({ where: { id: legacy.batch.id } });
    check(`Batch now ${QC_NOT_REQUIRED} with 10 KG released, 3 KG packed`, legacyAfter.qcStatus === QC_NOT_REQUIRED && legacyAfter.approvedQty === 10 && Math.abs((legacyAfter.packagedQty || 0) - 3) < 0.0001, `${legacyAfter.qcStatus} ${legacyAfter.approvedQty} ${legacyAfter.packagedQty}`);
    const fgAfter = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fgItem.id } })).currentStock;
    check("Finished goods +6 exactly once", fgAfter - fgBefore === 6, `delta ${fgAfter - fgBefore}`);
    const bulkAfter = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bulkItem.id } })).currentStock;
    check("Bulk pool net +7 KG (10 released − 3 packed)", Math.abs(bulkAfter - bulkBefore - 7) < 0.0001, `delta ${bulkAfter - bulkBefore}`);
    await expectReject("Second pack with the stale snapshot is blocked (no double release)", () =>
      ProductionService.packageAndConfirm({ batchId: legacy.batch.id, packetSize: "500g", packedQty: 6, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0 }));

    // ── 7. Blocked PENDING batches are never auto-released ──
    console.log("\n7️⃣ Expired / cancelled / recalled PENDING batches stay blocked");
    const blockedProd = await ProductionService.startProduction({
      recipeId: recipe.id, quantity: 1, franchiseId: hq.id, warehouseId: warehouse.id, productionType: "FINISHED_GOOD",
    });
    process.env.PRODUCTION_QC_ENABLED = "true";
    const blocked = await ProductionService.approveProduction(blockedProd.id, undefined, 10);
    process.env.PRODUCTION_QC_ENABLED = "false";
    const tryPack = () => ProductionService.packageAndConfirm({ batchId: blocked.batch.id, packetSize: "500g", packedQty: 1, damagedQty: 0, productId: fgProduct.id, expectedPackagedQty: 0 });

    await prisma.productBatch.update({ where: { id: blocked.batch.id }, data: { expiryDate: new Date(Date.now() - 86400000) } });
    await expectReject("Expired batch is not released", tryPack);
    await prisma.productBatch.update({ where: { id: blocked.batch.id }, data: { expiryDate: new Date(Date.now() + 7 * 86400000) } });

    await prisma.production.update({ where: { id: blockedProd.id }, data: { status: "CANCELLED" } });
    await expectReject("Batch of a cancelled run is not released", tryPack);
    await prisma.production.update({ where: { id: blockedProd.id }, data: { status: "COMPLETED" } });

    const recall = await prisma.batchRecall.create({ data: { productBatchId: blocked.batch.id, reason: `TEST ${testId}` } as any });
    await expectReject("Recalled batch is not released", tryPack);
    await prisma.batchRecall.delete({ where: { id: recall.id } });

    const stillPending = await prisma.productBatch.findUniqueOrThrow({ where: { id: blocked.batch.id } });
    check("Blocked batch untouched (still PENDING, nothing credited)", stillPending.qcStatus === "PENDING" && (stillPending.approvedQty || 0) === 0);

    // ── 8. Multi-size packaging: several pack sizes / SKUs, one confirmation ──
    console.log('\n8️⃣ Multi-size packaging of a 20 KG batch');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id, type: 'PURCHASE_IN', quantity: 20, warehouseId: warehouse.id,
      note: `Top-up Test Stock ${testId}`, receiveAtCost: { unitCost: 40, batchNumber: `LOT2-${testId}` },
    });
    const multiProd = await ProductionService.startProduction({
      recipeId: recipe.id, quantity: 2, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD',
    });
    const multi = (await ProductionService.approveProduction(multiProd.id, undefined, 20)).batch;
    const p250 = await prisma.product.create({
      data: { name: `Test Packed ${testId} 250g`, sku: `FG-${testId}-250G`, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', basePrice: 60, isActive: true },
    });
    const stockOf = async (sku: string) => (await prisma.inventoryItem.findFirst({ where: { sku } }))?.currentStock ?? 0;
    const fg500Before = await stockOf(fgProduct.sku!);

    await expectReject('A product whose SKU size differs from the row pack size is refused', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: 0, rows: [{ packetSize: '250g', packedQty: 1, productId: fgProduct.id }] }));
    await expectReject('Rows totalling more than the remaining bulk are refused as a whole', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: 0, rows: [
        { packetSize: '1kg', packedQty: 15, productId: undefined, newProduct: { name: `Test Packed ${testId} 1kg`, sku: `FG-${testId}-1KG`, basePrice: 0 } },
        { packetSize: '500g', packedQty: 12, productId: fgProduct.id },
      ] }));
    await expectReject('Negative / decimal packet counts are refused', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: 0, rows: [{ packetSize: '500g', packedQty: 2, damagedQty: -1, productId: fgProduct.id }] }));
    const afterRejects = await prisma.productBatch.findUniqueOrThrow({ where: { id: multi.id } });
    check('Rejected requests changed nothing (packedQty 0, no new variant)', (afterRejects.packagedQty || 0) === 0 &&
      (await prisma.product.count({ where: { sku: `FG-${testId}-1KG` } })) === 0);

    const res = await ProductionService.packageAndConfirm({
      batchId: multi.id, expectedPackagedQty: 0, rows: [
        { packetSize: '500g', packedQty: 5, damagedQty: 1, productId: fgProduct.id },
        { packetSize: '250g', packedQty: 3, productId: p250.id },
        { packetSize: '1kg', packedQty: 4, newProduct: { name: `Test Packed ${testId} 1kg`, sku: `FG-${testId}-1KG`, basePrice: 200 } },
      ],
    });
    check('One confirmation returns a 3-row summary', res.summary.length === 3, JSON.stringify(res.summary));
    check('500g SKU +5 pcs', (await stockOf(fgProduct.sku!)) - fg500Before === 5);
    check('250g SKU +3 pcs (existing SKU reused)', (await stockOf(p250.sku!)) === 3);
    check('1kg variant created once and stocked +4 pcs', (await prisma.product.count({ where: { sku: `FG-${testId}-1KG` } })) === 1 && (await stockOf(`FG-${testId}-1KG`)) === 4);
    const afterMulti = await prisma.productBatch.findUniqueOrThrow({ where: { id: multi.id } });
    // 5×0.5 + 1×0.5 (damaged) + 3×0.25 + 4×1 = 7.75 KG
    check('Batch packed 7.75 KG (good 7.25 + damaged 0.5), 12.25 KG left, not auto-wasted',
      Math.abs((afterMulti.packagedQty || 0) - 7.75) < 0.0001 && afterMulti.packagingStatus === 'PARTIALLY_PACKED',
      `${afterMulti.packagedQty} ${afterMulti.packagingStatus}`);
    const multiWaste = await prisma.wasteEntry.count({ where: { productPackagingId: { in: res.rows.map(r => r.packaging.id) } } });
    check('1 damage wastage entry (500g row only)', multiWaste === 1, `got ${multiWaste}`);

    await expectReject('Retrying the same confirmation is blocked', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: 0, rows: [{ packetSize: '250g', packedQty: 3, productId: p250.id }] }));

    // Second session on the same batch; "create" the 1kg variant again → reused.
    await ProductionService.packageAndConfirm({
      batchId: multi.id, expectedPackagedQty: 7.75, rows: [
        { packetSize: '1kg', packedQty: 2, newProduct: { name: `Test Packed ${testId} 1kg`, sku: `FG-${testId}-1KG`, basePrice: 200 } },
        { packetSize: '2kg', packedQty: 1, newProduct: { name: `Test Packed ${testId} 2kg`, basePrice: 450 } },
        { packetSize: '100g', packedQty: 2, newProduct: { name: `Test Packed ${testId} 100g`, sku: `FG-${testId}-100G`, basePrice: 25 } },
      ],
    });
    check('Second session reused the 1kg variant (no duplicate) → 6 pcs', (await prisma.product.count({ where: { name: { equals: `Test Packed ${testId} 1kg`, mode: 'insensitive' } } })) === 1 && (await stockOf(`FG-${testId}-1KG`)) === 6);
    const p2kg = await prisma.product.findFirst({ where: { name: `Test Packed ${testId} 2kg` } });
    check('Auto-generated SKU keeps the ERP format with size last', !!p2kg?.sku && /^FG-[A-Z0-9]+-2KG$/.test(p2kg.sku), p2kg?.sku || 'none');
    const afterSecond = await prisma.productBatch.findUniqueOrThrow({ where: { id: multi.id } });
    check('Batch packed 11.95 KG after two sessions (2×1kg + 1×2kg + 2×100g added)', Math.abs((afterSecond.packagedQty || 0) - 11.95) < 0.0001, `${afterSecond.packagedQty}`);
    check('Two new variants in one confirmation, each with its own price',
      (await prisma.product.findFirst({ where: { sku: `FG-${testId}-100G` } }))?.basePrice === 25 && p2kg?.basePrice === 450);
    check('New variant has exactly one stock item (Product Master sync reused, +2 pcs)',
      (await prisma.inventoryItem.count({ where: { sku: `FG-${testId}-100G` } })) === 1 && (await stockOf(`FG-${testId}-100G`)) === 2);
    check('Existing product price not overwritten by packaging', (await prisma.product.findUniqueOrThrow({ where: { id: p250.id } })).basePrice === 60);

    // ── 9. Variant validation ──
    console.log('\n9️⃣ Variant validation');
    const snap = (await prisma.productBatch.findUniqueOrThrow({ where: { id: multi.id } })).packagedQty || 0;
    // Packaging creates a new variant without a selling price as Pricing
    // Pending; it can't then be billed at ₹0 until priced in Product Master.
    check('A Pricing Pending product is not billable at ₹0', (() => { try { assertBillablePrice({ name: 'Pending', pricingStatus: PRICING_PENDING }, 0); return false; } catch { return true; } })());
    check('A Pricing Pending product is billable once it has a price', (() => { try { assertBillablePrice({ name: 'Pending', pricingStatus: PRICING_PENDING }, 45); return true; } catch { return false; } })());
    await expectReject('SKU already owned by a different product is refused', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: snap, rows: [{ packetSize: '250g', packedQty: 1, newProduct: { name: `Test Other ${testId} 250g`, sku: p250.sku!, basePrice: 10 } }] }));
    await expectReject('Two rows for the same product are refused', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: snap, rows: [
        { packetSize: '250g', packedQty: 1, productId: p250.id },
        { packetSize: '250g', packedQty: 1, newProduct: { name: p250.name, sku: p250.sku!, basePrice: 60 } },
      ] }));
    await expectReject('Zero pack size is refused', () =>
      ProductionService.packageAndConfirm({ batchId: multi.id, expectedPackagedQty: snap, rows: [{ packetSize: '0g', packedQty: 1, productId: p250.id }] }));
    const afterValidation = await prisma.productBatch.findUniqueOrThrow({ where: { id: multi.id } });
    check('Refused requests changed nothing', (afterValidation.packagedQty || 0) === snap &&
      (await prisma.product.count({ where: { name: { contains: `Test Other ${testId}` } } })) === 0 &&
      (await stockOf(p250.sku!)) === 3);
  } finally {
    console.log('\n🧹 Cleaning up test records...');
    const testItems = await prisma.inventoryItem.findMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] } });
    const itemIds = testItems.map(i => i.id);
    await prisma.wasteEntry.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.stockMovement.deleteMany({ where: { itemId: { in: itemIds } } });
    await prisma.productPackaging.deleteMany({ where: { batch: { production: { recipeId: recipe.id } } } });
    await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.productBatch.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.productionStageLog.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.productionItem.deleteMany({ where: { production: { recipeId: recipe.id } } });
    await prisma.production.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipeItem.deleteMany({ where: { recipeId: recipe.id } });
    await prisma.recipe.delete({ where: { id: recipe.id } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
    await prisma.product.deleteMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] } });
    console.log('🧹 Cleanup complete.\n');
  }

  if (failures === 0) console.log('🎉 ALL SIMPLIFIED WORKFLOW TESTS PASSED');
  else { console.error(`💥 ${failures} CHECK(S) FAILED`); process.exit(1); }
}

runTest()
  .catch(err => { console.error('Test execution error:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
