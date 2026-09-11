import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { RecallService } from '../../modules/production/recall.service';
import { SalesService } from '../../modules/sales/sales.service';

/**
 * Regression script for customer-return recall quarantine.
 *
 * Business rule under test: a product that originated from a recalled
 * ProductBatch must NEVER become saleable again through a customer return,
 * even if the operator marks its condition as "GOOD" — the backend must
 * override that regardless of what the frontend/operator submits.
 *
 * Also validates a closely related, previously-open gap: an ordinary
 * (non-recalled) "GOOD" return used to just bump InventoryItem.currentStock
 * with NO InventoryBatch/ProductBatch identity at all (InventoryService.
 * stockIn with no receiveAtCost) — meaning if that same ProductBatch were
 * recalled LATER, the already-restocked units would be permanently
 * invisible to the block. Returns whose source sale traces to exactly one
 * ProductBatch are now tagged with it (resolveSingleSourceProductBatchId),
 * so a later recall can still find and block them — proven in step 4 below.
 */
async function run() {
  console.log('================================================================');
  console.log('🔍 CUSTOMER RETURN RECALL QUARANTINE REGRESSION');
  console.log('================================================================\n');

  const scriptId = `RETURNFIX_${Date.now()}`;
  let failures = 0;

  let franchiseId: string | null = null;
  let warehouseId: string | null = null;
  let rawItemId: string | null = null;
  let recipeId: string | null = null;
  let prodAId: string | null = null;
  let pkgAId: string | null = null;
  let bulkItemId: string | null = null;
  let retailItemId: string | null = null;
  let orderId: string | null = null;
  const returnOrderIds: string[] = [];

  // Unrelated control batch/product, never recalled.
  let recipeZId: string | null = null;
  let prodZId: string | null = null;
  let pkgZId: string | null = null;
  let bulkItemZId: string | null = null;
  let retailItemZId: string | null = null;
  let orderZId: string | null = null;

  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) {
      console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
    } else {
      console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`);
      failures++;
    }
  };

  try {
    console.log('1️⃣ Setup: franchise (HQ), warehouse, raw item, recipe, Batch A — 10 KG approved, packaged into 10 x 1KG retail packets...');
    const franchise = await prisma.franchise.create({
      data: { name: `ReturnFix Franchise ${scriptId}`, location: 'Tamil Nadu', ownerName: 'Admin', contactNum: '9000000002', isHQ: true },
    });
    franchiseId = franchise.id;

    const warehouse = await prisma.warehouse.create({
      data: { name: `ReturnFix Warehouse ${scriptId}`, nameKey: `returnfix_wh_${scriptId}`.toLowerCase(), status: 'ACTIVE' },
    });
    warehouseId = warehouse.id;

    const rawItem = await prisma.inventoryItem.create({
      data: { name: `ReturnFix Raw ${scriptId}`, sku: `RTFR-${scriptId}`, category: 'RAW_MATERIAL', unit: 'KG', costPrice: 0, currentStock: 0, franchiseId },
    });
    rawItemId = rawItem.id;

    const recipe = await prisma.recipe.create({
      data: {
        recipeCode: `RTFRCP-${scriptId}`,
        name: `ReturnFix Recipe ${scriptId}`,
        yieldQty: 10,
        yieldUnit: 'KG',
        recipeItems: { create: [{ inventoryItemId: rawItemId, quantityRequired: 1, unit: 'KG' }] },
      },
    });
    recipeId = recipe.id;

    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId, type: 'PURCHASE_IN', quantity: 1, warehouseId,
      note: 'Lot A', receiveAtCost: { unitCost: 40, batchNumber: `LOT-A-${scriptId}` },
    });
    const prodA = await ProductionService.startProduction({ recipeId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodAId = prodA.id;
    const completedA = await ProductionService.approveProduction(prodA.id, undefined, 10);
    const batchA = completedA.batch;
    await ProductionService.inspectBatch({ batchId: batchA.id, rejectionQty: 0 });

    const bulkItem = await prisma.inventoryItem.findFirst({ where: { sku: { contains: `RTFRCP-${scriptId}` } } });
    bulkItemId = bulkItem!.id;
    const startPkgA = await ProductionService.startPackaging({ batchId: batchA.id, packetSize: '1 KG', quantityPackets: 10 });
    pkgAId = startPkgA.packaging.id;
    const confirmA = await ProductionService.confirmPackaging({ packagingId: pkgAId, goodQty: 10, damagedQty: 0, spoiledQty: 0 });
    retailItemId = confirmA.retailItem.id;
    const retailProduct = await prisma.product.findFirstOrThrow({ where: { sku: (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } })).sku! } });

    console.log('\n2️⃣ POS sale of all 10 packets to a customer (Order + simulated FIFO deduction, exactly like pos.service.ts)...');
    const order = await prisma.order.create({
      data: {
        invoiceNum: `INV-${scriptId}`,
        franchiseId,
        totalAmount: 100, subTotal: 100, taxAmount: 0,
        orderItems: { create: [{ productId: retailProduct.id, quantity: 10, price: 10, totalAmount: 100 }] },
      },
    });
    orderId = order.id;
    await InventoryService.recordMovement(prisma, {
      itemId: retailItemId, type: 'SALES_OUT', quantity: -10, referenceType: 'ORDER', referenceId: order.id, note: 'Simulated POS sale',
    });
    const itemAfterSale = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    check('All 10 packets sold, currentStock = 0', itemAfterSale.currentStock === 0, `got ${itemAfterSale.currentStock}`);

    console.log('\n3️⃣ Return #1 (BEFORE recall): customer returns 4 packets, condition GOOD — must restock normally, AND get tagged with Batch A for forward-looking recall protection...');
    const returnOrder1 = await SalesService.createReturnOrder({
      posOrderId: order.id, reason: 'Customer changed mind', status: 'APPROVED',
      items: [{ productId: retailProduct.id, productName: retailProduct.name, quantity: 4, rate: 10, condition: 'GOOD' }],
    });
    returnOrderIds.push(returnOrder1.id);
    const itemAfterReturn1 = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    check('Return #1 restocked normally: currentStock = 4', itemAfterReturn1.currentStock === 4, `got ${itemAfterReturn1.currentStock}`);
    const returnItem1 = await prisma.returnItem.findFirstOrThrow({ where: { returnId: returnOrder1.id } });
    check('Return #1 is NOT recall-flagged (recallId null)', returnItem1.recallId === null);
    const returnedBatch1 = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: retailItemId, productBatchId: batchA.id, status: 'APPROVED', batchNumber: { contains: 'RETURN' } } });
    check('Return #1 created a batch-tracked APPROVED lot tagged to Batch A (not untracked)', !!returnedBatch1 && returnedBatch1.currentQty === 4, `found=${!!returnedBatch1}, qty=${returnedBatch1?.currentQty}`);

    console.log('\n4️⃣ Control resale BEFORE recall: sell 2 of those returned packets — must succeed (no regression)...');
    const saleOfReturned = await InventoryService.recordMovement(prisma, {
      itemId: retailItemId, type: 'SALES_OUT', quantity: -2, referenceType: 'ORDER', referenceId: `${scriptId}-resale`, note: 'Resale of returned-GOOD stock',
    });
    check('Resale of returned-GOOD stock succeeded', (saleOfReturned.fifo?.consumedFromBatches ?? 0) === 2, `consumed ${saleOfReturned.fifo?.consumedFromBatches}`);
    const itemAfterResale = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    check('currentStock = 2 after resale', itemAfterResale.currentStock === 2, `got ${itemAfterResale.currentStock}`);

    console.log('\n5️⃣ Initiate recall on Batch A...');
    await RecallService.initiateRecall(batchA.id, { reason: 'Contamination' });
    const returnedBatch1AfterRecall = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: returnedBatch1!.id } });
    check(
      "Return #1's remaining 2 packets (tagged to Batch A) got BLOCKED by the recall — proves the forward-looking tagging in step 3 actually works",
      returnedBatch1AfterRecall.status === 'BLOCKED' && returnedBatch1AfterRecall.currentQty === 2,
      `status=${returnedBatch1AfterRecall.status}, currentQty=${returnedBatch1AfterRecall.currentQty}`,
    );

    console.log('\n6️⃣ Return #2 (AFTER recall): customer returns 3 MORE packets from the SAME original sale, condition GOOD — backend MUST override to quarantine regardless...');
    const returnOrder2 = await SalesService.createReturnOrder({
      posOrderId: order.id, reason: 'Customer changed mind', status: 'APPROVED',
      items: [{ productId: retailProduct.id, productName: retailProduct.name, quantity: 3, rate: 10, condition: 'GOOD' }],
    });
    returnOrderIds.push(returnOrder2.id);
    const returnItem2 = await prisma.returnItem.findFirstOrThrow({ where: { returnId: returnOrder2.id } });
    check('Return #2 IS recall-flagged (recallId set) even though condition submitted was GOOD', !!returnItem2.recallId, `recallId=${returnItem2.recallId}`);

    const itemAfterReturn2 = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    console.log(`   - currentStock after Return #2 = ${itemAfterReturn2.currentStock} (Exp: 5 = 2 pre-recall-approved + 3 quarantined — physically present, but NOT saleable)`);
    check('currentStock correctly reflects physical receipt (5), not silently dropped', itemAfterReturn2.currentStock === 5, `got ${itemAfterReturn2.currentStock}`);

    const quarantineBatch2 = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: retailItemId, productBatchId: batchA.id, status: 'RETURNED', currentQty: 3 } });
    check('Return #2 created a RETURNED (non-sellable) lot, not APPROVED', !!quarantineBatch2, `found=${!!quarantineBatch2}`);

    const recallAfterReturn2 = await prisma.batchRecall.findUniqueOrThrow({ where: { productBatchId: batchA.id } });
    check('BatchRecall.returnedQty was incremented by the generic customer return (3)', recallAfterReturn2.returnedQty === 3, `got ${recallAfterReturn2.returnedQty}`);
    const auditEvent = await prisma.batchRecallEvent.findFirst({ where: { recallId: recallAfterReturn2.id, event: 'RETURN_COLLECTED' } });
    check('Audit trail recorded the customer-return quarantine event', !!auditEvent);

    console.log('\n7️⃣ Attempt a POS sale of 1 packet AFTER both blocks/quarantine — must be REJECTED, wrapped in prisma.$transaction exactly like real checkout...');
    let blockedCorrectly = false;
    const stockBeforeAttempt = itemAfterReturn2.currentStock;
    try {
      await prisma.$transaction(async (tx) => {
        await InventoryService.recordMovement(tx, {
          itemId: retailItemId!, type: 'SALES_OUT', quantity: -1, referenceType: 'ORDER', referenceId: `${scriptId}-post-recall-sale`, note: 'Post-recall sale attempt (must fail)',
        });
      });
    } catch (e: any) {
      blockedCorrectly = /recalled|blocked/i.test(e.message);
      console.log(`   - Rejected with: "${e.message}"`);
    }
    check('Sale of recalled + quarantined-returned stock was rejected', blockedCorrectly);
    const itemAfterRejectedAttempt = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemId } });
    check('currentStock unchanged (transaction rolled back)', itemAfterRejectedAttempt.currentStock === stockBeforeAttempt, `before=${stockBeforeAttempt}, after=${itemAfterRejectedAttempt.currentStock}`);

    console.log('\n8️⃣ Scoping control: an UNRELATED product (different recipe, never recalled) — sale + GOOD return + resale — must work completely normally...');
    const recipeZ = await prisma.recipe.create({
      data: {
        recipeCode: `RTFRCPZ-${scriptId}`,
        name: `ReturnFix Recipe Z ${scriptId}`,
        yieldQty: 5,
        yieldUnit: 'KG',
        recipeItems: { create: [{ inventoryItemId: rawItemId!, quantityRequired: 1, unit: 'KG' }] },
      },
    });
    recipeZId = recipeZ.id;
    await InventoryService.recordMovement(prisma, {
      itemId: rawItemId!, type: 'PURCHASE_IN', quantity: 1, warehouseId,
      note: 'Lot Z', receiveAtCost: { unitCost: 30, batchNumber: `LOT-Z-${scriptId}` },
    });
    const prodZ = await ProductionService.startProduction({ recipeId: recipeZId, quantity: 1, franchiseId, warehouseId, productionType: 'BULK' });
    prodZId = prodZ.id;
    const completedZ = await ProductionService.approveProduction(prodZ.id, undefined, 5);
    const batchZ = completedZ.batch;
    await ProductionService.inspectBatch({ batchId: batchZ.id, rejectionQty: 0 });
    const bulkItemZ = await prisma.inventoryItem.findFirst({ where: { sku: { contains: `RTFRCPZ-${scriptId}` } } });
    bulkItemZId = bulkItemZ!.id;
    const startPkgZ = await ProductionService.startPackaging({ batchId: batchZ.id, packetSize: '1 KG', quantityPackets: 5 });
    pkgZId = startPkgZ.packaging.id;
    const confirmZ = await ProductionService.confirmPackaging({ packagingId: pkgZId, goodQty: 5, damagedQty: 0, spoiledQty: 0 });
    retailItemZId = confirmZ.retailItem.id;
    const retailProductZ = await prisma.product.findFirstOrThrow({ where: { sku: (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: retailItemZId } })).sku! } });

    const orderZ = await prisma.order.create({
      data: {
        invoiceNum: `INV-Z-${scriptId}`,
        franchiseId,
        totalAmount: 50, subTotal: 50, taxAmount: 0,
        orderItems: { create: [{ productId: retailProductZ.id, quantity: 5, price: 10, totalAmount: 50 }] },
      },
    });
    orderZId = orderZ.id;
    await InventoryService.recordMovement(prisma, {
      itemId: retailItemZId, type: 'SALES_OUT', quantity: -5, referenceType: 'ORDER', referenceId: orderZ.id, note: 'Simulated POS sale (unrelated product)',
    });
    const returnOrderZ = await SalesService.createReturnOrder({
      posOrderId: orderZ.id, reason: 'Customer changed mind', status: 'APPROVED',
      items: [{ productId: retailProductZ.id, productName: retailProductZ.name, quantity: 2, rate: 10, condition: 'GOOD' }],
    });
    returnOrderIds.push(returnOrderZ.id);
    const returnItemZ = await prisma.returnItem.findFirstOrThrow({ where: { returnId: returnOrderZ.id } });
    check('Unrelated product return is NOT recall-flagged', returnItemZ.recallId === null);
    const saleZ = await InventoryService.recordMovement(prisma, {
      itemId: retailItemZId, type: 'SALES_OUT', quantity: -1, referenceType: 'ORDER', referenceId: `${scriptId}-z-resale`, note: 'Resale of unrelated returned stock',
    });
    check('Unrelated product resale of its own returned-GOOD stock succeeds', (saleZ.fifo?.consumedFromBatches ?? 0) === 1, `consumed ${saleZ.fifo?.consumedFromBatches}`);

  } catch (err: any) {
    console.error('❌ Exception during customer-return recall quarantine regression script:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up...');
    try {
      for (const roId of returnOrderIds) {
        await prisma.returnItem.deleteMany({ where: { returnId: roId } });
        await prisma.returnOrder.deleteMany({ where: { id: roId } });
      }
      for (const oId of [orderId, orderZId]) {
        if (!oId) continue;
        await prisma.orderItem.deleteMany({ where: { orderId: oId } });
        await prisma.order.deleteMany({ where: { id: oId } });
      }
      for (const pkgId of [pkgAId, pkgZId]) {
        if (!pkgId) continue;
        await prisma.wasteEntry.deleteMany({ where: { productPackagingId: pkgId } });
        await prisma.productPackaging.deleteMany({ where: { id: pkgId } });
      }
      for (const itemId of [retailItemId, retailItemZId, bulkItemId, bulkItemZId, rawItemId]) {
        if (!itemId) continue;
        await prisma.stockMovement.deleteMany({ where: { itemId } });
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: itemId } });
      }
      for (const prodId of [prodAId, prodZId]) {
        if (!prodId) continue;
        await prisma.batchRecallEvent.deleteMany({ where: { recall: { productBatch: { productionId: prodId } } } });
        await prisma.batchRecall.deleteMany({ where: { productBatch: { productionId: prodId } } });
        await prisma.productionStageLog.deleteMany({ where: { productionId: prodId } });
        await prisma.productBatch.deleteMany({ where: { productionId: prodId } });
        await prisma.productionItem.deleteMany({ where: { productionId: prodId } });
        await prisma.production.delete({ where: { id: prodId } });
      }
      for (const rId of [recipeId, recipeZId]) {
        if (!rId) continue;
        await prisma.recipeItem.deleteMany({ where: { recipeId: rId } });
        await prisma.recipe.delete({ where: { id: rId } });
      }
      // Auto-created Product catalog rows for the retail SKUs.
      for (const itemId of [retailItemId, retailItemZId]) {
        if (!itemId) continue;
      }
      for (const itemId of [retailItemId, retailItemZId, bulkItemId, bulkItemZId, rawItemId]) {
        if (!itemId) continue;
        const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { sku: true } });
        if (item?.sku) await prisma.product.deleteMany({ where: { sku: item.sku } });
        await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
      }
      if (warehouseId) await prisma.warehouse.delete({ where: { id: warehouseId } });
      if (franchiseId) await prisma.franchise.delete({ where: { id: franchiseId } });
      console.log('   ✅ Cleanup complete.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 CUSTOMER RETURN RECALL QUARANTINE REGRESSION PASSED 100%! 🎉');
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
