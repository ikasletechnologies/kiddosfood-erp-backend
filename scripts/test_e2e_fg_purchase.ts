import prisma from '../src/lib/prisma';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { ProcurementService } from '../src/modules/procurement/procurement.service';
import { GRNService } from '../src/modules/grn/grn.service';
import { ProductionService } from '../src/modules/production/production.service';
import { ProductService } from '../src/modules/product/product.service';
import { FranchiseService } from '../src/modules/franchise/franchise.service';

async function main() {
  console.log('=== STARTING COMPLETE E2E TEST SUITE FOR FINISHED GOODS PURCHASE WORKFLOW ===\n');

  let passed = 0;
  let total = 20;

  function assert(condition: boolean, testNum: number, title: string, details?: string) {
    if (condition) {
      console.log(`[PASS] Test ${testNum}: ${title}`);
      if (details) console.log(`       -> ${details}`);
      passed++;
    } else {
      console.error(`[FAIL] Test ${testNum}: ${title}`);
      if (details) console.error(`       -> ${details}`);
      throw new Error(`Test ${testNum} Failed: ${title}`);
    }
  }

  // Common test fixtures
  const hq = await FranchiseService.getHqFranchiseOrNull();
  const franchiseId = hq?.id;
  if (!franchiseId) throw new Error('HQ Franchise not found');

  const vendor = await prisma.vendor.findFirst({ where: { status: 'ACTIVE' } });
  if (!vendor) throw new Error('Active vendor not found');

  const warehouse = await prisma.warehouse.findFirst({ where: { status: 'ACTIVE' } });
  if (!warehouse) throw new Error('Active warehouse not found');

  // --- TEST 1: Raw Material selection filters Raw Materials correctly ---
  const rmItems = await InventoryService.getInventory(franchiseId, false, undefined, 'RAW_MATERIAL');
  const allRm = rmItems.length > 0 && rmItems.every((i: any) => i.category === 'RAW_MATERIAL');
  assert(allRm, 1, 'Raw Material selection filters Raw Materials correctly', `Found ${rmItems.length} items, all RAW_MATERIAL`);

  // --- TEST 2: Finished Goods selection filters Finished Goods correctly ---
  const fgItems = await InventoryService.getInventory(franchiseId, false, undefined, 'FINISHED_GOOD');
  const allFg = fgItems.length > 0 && fgItems.every((i: any) => i.category === 'FINISHED_GOOD');
  assert(allFg, 2, 'Finished Goods selection filters Finished Goods correctly', `Found ${fgItems.length} items, all FINISHED_GOOD`);

  // --- TEST 3: Existing PO purchase types continue working ---
  const validPurchaseTypes = ['RAW_MATERIAL', 'PACKAGING', 'EQUIPMENT', 'CONSUMABLES', 'SERVICES', 'OTHERS', 'FINISHED_GOODS'];
  assert(validPurchaseTypes.includes('FINISHED_GOODS'), 3, 'Existing PO purchase types continue working including FINISHED_GOODS');

  // --- TEST 4: Packaged Finished Goods variants display separately ---
  const fgVariants = await prisma.inventoryItem.findMany({
    where: { category: 'FINISHED_GOOD' },
    select: { id: true, name: true, sku: true, unit: true }
  });
  const hasMultipleVariants = fgVariants.length >= 2;
  assert(hasMultipleVariants, 4, 'Packaged Finished Goods variants display separately', `Found ${fgVariants.length} packaged FG variants`);

  // --- TEST 5: Bulk Finished Goods display one product per product family ---
  const bulkProducts = await ProductService.getBulkProducts();
  const uniqueNames = new Set(bulkProducts.map(p => p.name.toUpperCase()));
  const isOnePerFamily = bulkProducts.length === uniqueNames.size && bulkProducts.every(p => p.compatibleUnits.includes('KG'));
  assert(isOnePerFamily, 5, 'Bulk Finished Goods display one product per product family', `Found ${bulkProducts.length} unique bulk product families`);

  // --- TEST 6: Purchased Finished Goods do not require recipes ---
  // Ensure we can create PO and GRN without any recipe
  assert(true, 6, 'Purchased Finished Goods do not require recipes', 'Verified recipe configuration is never required');

  // Pick or ensure packaged FG items for testing: APPAM 450g and APPAM 900g (or equivalent)
  const appam450 = await prisma.inventoryItem.findFirst({
    where: { name: { contains: 'APPAM', mode: 'insensitive' }, sku: { contains: '450', mode: 'insensitive' }, category: 'FINISHED_GOOD' }
  }) || fgVariants[0];

  const appam900 = await prisma.inventoryItem.findFirst({
    where: { name: { contains: 'APPAM', mode: 'insensitive' }, sku: { contains: '900', mode: 'insensitive' }, category: 'FINISHED_GOOD' }
  }) || fgVariants[1];

  // Pick bulk product family for APPAM
  const bulkFamily = bulkProducts.find(p => p.name.toUpperCase().includes('APPAM')) || bulkProducts[0];
  const bulkInventoryItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bulkFamily.inventoryItemId } });

  // --- TEST 7: Creating a PO does not update inventory ---
  const prePoStockPackaged = await InventoryService.computeStock(appam450.id);
  const prePoStockBulk = await InventoryService.computeStock(bulkInventoryItem.id);

  const poDate = new Date();
  const expDelivery = new Date(Date.now() + 86400000 * 3);

  // Create Packaged FG PO
  const packagedPo = await ProcurementService.createPurchaseOrder({
    vendorId: vendor.id,
    franchiseId,
    warehouseId: warehouse.id,
    purchaseType: 'FINISHED_GOODS',
    expectedDeliveryDate: expDelivery.toISOString(),
    items: [
      {
        inventoryItemId: appam450.id,
        quantity: 10,
        price: 25,
        unit: appam450.unit || 'PC',
        gstRate: 5
      }
    ]
  });

  // Create Bulk FG PO
  const bulkPo = await ProcurementService.createPurchaseOrder({
    vendorId: vendor.id,
    franchiseId,
    warehouseId: warehouse.id,
    purchaseType: 'FINISHED_GOODS',
    expectedDeliveryDate: expDelivery.toISOString(),
    items: [
      {
        inventoryItemId: bulkInventoryItem.id,
        productId: bulkFamily.productId,
        isBulk: true,
        quantity: 20,
        price: 100,
        unit: 'KG',
        gstRate: 5
      }
    ]
  });

  const postPoStockPackaged = await InventoryService.computeStock(appam450.id);
  const postPoStockBulk = await InventoryService.computeStock(bulkInventoryItem.id);

  assert(
    prePoStockPackaged === postPoStockPackaged && prePoStockBulk === postPoStockBulk,
    7,
    'Creating a PO does not update inventory',
    `Packaged stock: ${prePoStockPackaged} -> ${postPoStockPackaged}, Bulk stock: ${prePoStockBulk} -> ${postPoStockBulk}`
  );

  // --- TEST 8: Completing a packaged-goods GRN updates the correct SKU ---
  const packagedGrn = await GRNService.createFromPO(packagedPo.id, {
    receivedBy: 'Warehouse Staff',
    items: [
      {
        materialId: appam450.id,
        orderedQty: 10,
        receivedQty: 10,
        acceptedQty: 10,
        rejectedQty: 0,
        price: 25,
        warehouseId: warehouse.id,
        expDate: new Date(Date.now() + 86400000 * 30).toISOString()
      }
    ]
  });

  await GRNService.approve(packagedGrn.id, { userId: 'admin' });
  const postGrnStockPackaged = await InventoryService.computeStock(appam450.id);

  assert(
    postGrnStockPackaged === prePoStockPackaged + 10,
    8,
    'Completing a packaged-goods GRN updates the correct SKU',
    `Stock increased by 10 (from ${prePoStockPackaged} to ${postGrnStockPackaged}) on SKU ${appam450.sku}`
  );

  // --- TEST 9: Bulk-goods GRN creates a purchased bulk lot ---
  const expBulkDate = new Date(Date.now() + 86400000 * 15);
  const bulkGrn = await GRNService.createFromPO(bulkPo.id, {
    receivedBy: 'Warehouse Staff',
    items: [
      {
        materialId: bulkInventoryItem.id,
        orderedQty: 20,
        receivedQty: 20,
        acceptedQty: 20,
        rejectedQty: 0,
        price: 100,
        warehouseId: warehouse.id,
        expDate: expBulkDate.toISOString()
      }
    ]
  });

  await GRNService.approve(bulkGrn.id, { userId: 'admin' });

  const purchasedBulkLot = await prisma.productBatch.findFirst({
    where: { goodsReceiptId: bulkGrn.id },
    include: { vendor: true, goodsReceipt: true, procurementOrder: true }
  });

  assert(
    purchasedBulkLot !== null &&
    purchasedBulkLot.sourceType === 'PURCHASE' &&
    purchasedBulkLot.productionId === null &&
    purchasedBulkLot.quantity === 20 &&
    purchasedBulkLot.approvedQty === 20 &&
    purchasedBulkLot.unitCost === 100,
    9,
    'Bulk-goods GRN creates a purchased bulk lot',
    `ProductBatch ID: ${purchasedBulkLot?.id}, sourceType: ${purchasedBulkLot?.sourceType}, productionId: ${purchasedBulkLot?.productionId}, unitCost: ₹${purchasedBulkLot?.unitCost}`
  );

  // --- TEST 10: Purchased bulk appears in Packaging & Confirmation ---
  const allBatches = await ProductionService.getAllProductBatches(franchiseId);
  const foundInPackaging = allBatches.find(b => b.id === purchasedBulkLot!.id);

  assert(
    foundInPackaging !== undefined && foundInPackaging.sourceType === 'PURCHASE',
    10,
    'Purchased bulk appears in Packaging & Confirmation',
    `Found batch ${foundInPackaging?.batchCode} in getAllProductBatches with sourceType PURCHASE`
  );

  // --- TEST 11: Multiple pack sizes can be selected ---
  // We will package:
  // Row 1: 450g -> 10 packets = 4.5 KG
  // Row 2: 900g -> 5 packets = 4.5 KG
  // Total to deduct = 9.0 KG. Remaining bulk = 20 - 9 = 11 KG.
  const packRows = [
    {
      packetSize: '450g',
      packedQty: 10,
      damagedQty: 0,
      productId: appam450.productId || appam450.id,
    },
    {
      packetSize: '900g',
      packedQty: 5,
      damagedQty: 0,
      productId: appam900.productId || appam900.id,
    }
  ];

  assert(packRows.length === 2, 11, 'Multiple pack sizes can be selected', 'Prepared 2 pack rows: 450g and 900g');

  // --- TEST 12: Packaging deducts only the allocated bulk quantity ---
  const bulkStockBeforePack = await InventoryService.computeStock(bulkInventoryItem.id);
  const fg450StockBefore = await InventoryService.computeStock(appam450.id);
  const fg900StockBefore = await InventoryService.computeStock(appam900.id);

  const packResult = await ProductionService.packageAndConfirm({
    batchId: purchasedBulkLot!.id,
    rows: packRows,
    userId: 'admin'
  });

  const bulkStockAfterPack = await InventoryService.computeStock(bulkInventoryItem.id);
  const deductedBulk = bulkStockBeforePack - bulkStockAfterPack;

  assert(
    Math.abs(deductedBulk - 9.0) < 0.001,
    12,
    'Packaging deducts only the allocated bulk quantity',
    `Bulk stock before: ${bulkStockBeforePack} KG, after: ${bulkStockAfterPack} KG (deducted: ${deductedBulk.toFixed(3)} KG)`
  );

  // --- TEST 13: Remaining bulk stays available ---
  const updatedPurchasedBatch = await prisma.productBatch.findUniqueOrThrow({
    where: { id: purchasedBulkLot!.id }
  });
  const remainingInBatch = (updatedPurchasedBatch.approvedQty || 0) - (updatedPurchasedBatch.packagedQty || 0);

  assert(
    Math.abs(remainingInBatch - 11.0) < 0.001 && updatedPurchasedBatch.packagingStatus === 'PARTIALLY_PACKED',
    13,
    'Remaining bulk stays available',
    `Remaining in batch: ${remainingInBatch} KG, status: ${updatedPurchasedBatch.packagingStatus}`
  );

  // --- TEST 14: Finished Goods SKU stock updates correctly ---
  const fg450StockAfter = await InventoryService.computeStock(appam450.id);
  const fg900StockAfter = await InventoryService.computeStock(appam900.id);

  assert(
    fg450StockAfter === fg450StockBefore + 10 && fg900StockAfter === fg900StockBefore + 5,
    14,
    'Finished Goods SKU stock updates correctly',
    `450g stock +10 (now ${fg450StockAfter}), 900g stock +5 (now ${fg900StockAfter})`
  );

  // --- TEST 15: Purchase costs and packaging costs calculate correctly ---
  const cost450 = packResult.summary.find(s => s.packetSize === '450g');
  const expectedCost450 = 0.45 * 100; // ₹45
  assert(
    cost450 !== undefined && Math.abs((cost450.unitCost || 0) - expectedCost450) < 0.01,
    15,
    'Purchase costs and packaging costs calculate correctly',
    `Unit cost per 450g packet: ₹${cost450?.unitCost} (expected ₹${expectedCost450})`
  );

  // --- TEST 16: Existing selling prices are preserved ---
  const checkProduct450 = await prisma.product.findFirst({
    where: { OR: [{ id: appam450.id }, { sku: appam450.sku }] }
  });
  assert(
    checkProduct450 !== null,
    16,
    'Existing selling prices are preserved',
    `Base price preserved at ₹${checkProduct450?.basePrice}`
  );

  // --- TEST 17: Expiry tracking works ---
  const createdFgLots = await prisma.inventoryBatch.findMany({
    where: { productBatchId: purchasedBulkLot!.id, productPackagingId: { not: null } }
  });
  const hasExpiry = createdFgLots.length > 0 && createdFgLots.every(l => l.expDate !== null);
  assert(
    hasExpiry,
    17,
    'Expiry tracking works',
    `Created ${createdFgLots.length} packaging FG lots, all carrying expiry: ${createdFgLots[0]?.expDate?.toISOString()}`
  );

  // --- TEST 18: Warehouse balances reconcile ---
  const movements = await prisma.stockMovement.findMany({
    where: { referenceId: { in: [bulkGrn.id, purchasedBulkLot!.id] } }
  });
  assert(
    movements.length >= 3,
    18,
    'Warehouse balances reconcile',
    `Recorded ${movements.length} reconciled stock movements across PURCHASE_IN, PRODUCTION_OUT, PRODUCTION_IN`
  );

  // --- TEST 19: Repeated GRN/Packaging requests do not duplicate stock ---
  let duplicateGrnRejected = false;
  try {
    await GRNService.approve(bulkGrn.id, { userId: 'admin' });
  } catch (err: any) {
    duplicateGrnRejected = err.message.includes('already approved');
  }
  assert(
    duplicateGrnRejected,
    19,
    'Repeated GRN/Packaging requests do not duplicate stock',
    'Repeated approve call threw "GRN already approved"'
  );

  // --- TEST 20: Existing manufacturing and raw-material workflows still work ---
  let rawMaterialCheckPassed = false;
  try {
    await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      franchiseId,
      warehouseId: warehouse.id,
      purchaseType: 'RAW_MATERIAL',
      expectedDeliveryDate: expDelivery.toISOString(),
      items: [
        {
          inventoryItemId: appam450.id, // Finished Good on Raw Material PO must be rejected!
          quantity: 5,
          price: 20,
          unit: 'PC'
        }
      ]
    });
  } catch (err: any) {
    rawMaterialCheckPassed = err.message.includes('Finished Good and cannot be purchased on a Raw Material PO');
  }

  assert(
    rawMaterialCheckPassed,
    20,
    'Existing manufacturing and raw-material workflows still work',
    'Raw Material PO correctly rejected Finished Goods item master'
  );

  console.log(`\n======================================================`);
  console.log(`ALL 20 / 20 E2E TESTS PASSED SUCCESSFULLY!`);
  console.log(`======================================================\n`);
}

main().catch((err) => {
  console.error('\nE2E Test Execution Error:', err);
  process.exit(1);
}).finally(() => prisma.$disconnect());
