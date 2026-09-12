import prisma from './src/lib/prisma';
import { FranchiseOrderService } from './src/modules/franchise/franchise-order.service';

async function runTests() {
  console.log("=== STARTING REGRESSION TESTS ===");
  // Setup
  // Using unique TS values, so no cleanup necessary
  
  let hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
  let franchise = await prisma.franchise.findFirst({ where: { isHQ: false } });
  
  if (!hq) hq = await prisma.franchise.create({ data: { name: "HQ", isHQ: true, location: "", ownerName: "", contactNum: "" } }) as any;
  if (!franchise) franchise = await prisma.franchise.create({ data: { name: "F1", isHQ: false, location: "", ownerName: "", contactNum: "" } }) as any;

  const ts = Date.now();
  const product = await prisma.product.create({
    data: {
      name: `Test Product ${ts}`,
      basePrice: 10,
      sku: `SKU-${ts}`
    }
  });

  const hqInvItem = await prisma.inventoryItem.create({
    data: {
      name: product.name,
      sku: product.sku || '',
      category: 'FINISHED_GOOD',
      currentStock: 200, // 200 total physical stock
      unit: 'PC',
      basePrice: 10,
      costPrice: 5,
      isActive: true,
      franchiseId: hq!.id
    }
  });

  // Layer 1: 150 @ $5
  const pb1 = await prisma.productBatch.create({
    data: {
      productId: product.id,
      quantity: 150,
      batchCode: `L1-${ts}`
    }
  });
  const ib1 = await prisma.inventoryBatch.create({
    data: {
      inventoryItemId: hqInvItem.id,
      productBatchId: pb1.id,
      batchNumber: `L1-${ts}`,
      initialQty: 150,
      currentQty: 150,
      unitCost: 5,
      status: 'APPROVED',
      mfgDate: new Date('2024-01-01') // Older, picked first
    }
  });

  // Layer 2: 50 @ $6
  const pb2 = await prisma.productBatch.create({
    data: {
      productId: product.id,
      quantity: 50,
      batchCode: `L2-${ts}`
    }
  });
  const ib2 = await prisma.inventoryBatch.create({
    data: {
      inventoryItemId: hqInvItem.id,
      productBatchId: pb2.id,
      batchNumber: `L2-${ts}`,
      initialQty: 50,
      currentQty: 50,
      unitCost: 6,
      status: 'APPROVED',
      mfgDate: new Date('2024-02-01') // Newer
    }
  });

  console.log("Setup complete. Physical=200");

  // TEST 1: Multiple FIFO layers
  console.log("\n--- TEST 1: Multiple FIFO Layers ---");
  const orderMult = await prisma.franchiseOrder.create({
    data: {
      orderNumber: `MULT-${ts}`,
      orderType: 'STOCK',
      status: 'PENDING',
      franchiseId: franchise!.id,
      totalAmount: 1800,
      items: {
        create: {
          productId: product.id,
          quantity: 180, // Needs all of Layer 1 (150) and 30 of Layer 2
          unitPrice: 10,
          totalAmount: 1800
        }
      }
    }
  });
  await FranchiseOrderService.updateStatus(orderMult.id, 'APPROVED');
  const resMult = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: orderMult.id }, include: { allocations: true } });
  console.log(`Reservation created for 180. Allocations: ${resMult?.allocations.length}`);
  resMult?.allocations.forEach(a => console.log(` - Batch ${a.inventoryBatchId === ib1.id ? 'L1' : 'L2'}: ${a.reservedQty}`));

  // TEST 2: Insufficient Stock
  console.log("\n--- TEST 2: Insufficient Stock ---");
  const orderFail = await prisma.franchiseOrder.create({
    data: {
      orderNumber: `FAIL-${ts}`,
      orderType: 'STOCK',
      status: 'PENDING',
      franchiseId: franchise!.id,
      totalAmount: 500,
      items: {
        create: { productId: product.id, quantity: 50, unitPrice: 10, totalAmount: 500 }
      }
    }
  });
  try {
    await FranchiseOrderService.updateStatus(orderFail.id, 'APPROVED');
    console.log("FAIL: Order should have thrown insufficient stock");
  } catch (err: any) {
    console.log(`PASS: Caught expected error: ${err.message}`);
  }
  const failOrderCheck = await prisma.franchiseOrder.findUnique({ where: { id: orderFail.id } });
  console.log(`Order status remains: ${failOrderCheck?.status}`);

  // TEST 3: Cancellation Atomic Release
  console.log("\n--- TEST 3: Cancellation Atomic Release ---");
  await FranchiseOrderService.updateStatus(orderMult.id, 'CANCELLED');
  const resCancel = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: orderMult.id }, include: { allocations: true } });
  console.log(`Reservation cancelled. Allocations released:`);
  resCancel?.allocations.forEach(a => console.log(` - Batch ${a.inventoryBatchId === ib1.id ? 'L1' : 'L2'}: reserved=${a.reservedQty}, released=${a.releasedQty}`));

  // TEST 4: Recalled Reserved Stock exclusion
  console.log("\n--- TEST 4: Recalled Reserved Stock Exclusion ---");
  await prisma.batchRecall.create({
    data: { productBatchId: pb1.id, status: 'IN_PROGRESS', reason: 'Test recall' }
  });
  
  const orderExcl = await prisma.franchiseOrder.create({
    data: {
      orderNumber: `EXCL-${ts}`,
      orderType: 'STOCK',
      status: 'PENDING',
      franchiseId: franchise!.id,
      totalAmount: 500,
      items: { create: { productId: product.id, quantity: 50, unitPrice: 10, totalAmount: 500 } }
    }
  });
  await FranchiseOrderService.updateStatus(orderExcl.id, 'APPROVED');
  const resExcl = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: orderExcl.id }, include: { allocations: true } });
  console.log(`Reservation created for 50. Allocations:`);
  resExcl?.allocations.forEach(a => console.log(` - Batch ${a.inventoryBatchId === ib1.id ? 'L1 (Recalled)' : 'L2 (Safe)'}: reserved=${a.reservedQty}`));

  // TEST 5: Recall AFTER reservation but BEFORE dispatch
  console.log("\n--- TEST 5: Recall before dispatch ---");
  await prisma.batchRecall.create({
    data: { productBatchId: pb2.id, status: 'IN_PROGRESS', reason: 'Late recall' }
  });
  try {
    await FranchiseOrderService.updateStatus(orderExcl.id, 'DISPATCHED');
    console.log("FAIL: Dispatch should have thrown recall error");
  } catch (err: any) {
    console.log(`PASS: Caught expected error: ${err.message}`);
  }

  // TEST 6: Source/cost preservation through franchise receipt
  console.log("\n--- TEST 6: Source/Cost preservation ---");
  await prisma.batchRecall.deleteMany({}); // Clear recalls
  const orderDeliv = await prisma.franchiseOrder.create({
    data: {
      orderNumber: `DELIV-${ts}`,
      orderType: 'STOCK',
      status: 'PENDING',
      franchiseId: franchise!.id,
      totalAmount: 120,
      items: { create: { productId: product.id, quantity: 12, unitPrice: 10, totalAmount: 120 } }
    }
  });
  await FranchiseOrderService.updateStatus(orderDeliv.id, 'APPROVED');
  await FranchiseOrderService.updateStatus(orderDeliv.id, 'DISPATCHED');
  await FranchiseOrderService.updateStatus(orderDeliv.id, 'DELIVERED');
  
  const sm = await prisma.stockMovement.findFirst({
    where: { referenceId: orderDeliv.id, referenceType: 'FRANCHISE_ORDER', movementType: 'TRANSFER_IN' },
    orderBy: { createdAt: 'desc' }
  });
  console.log(`Receipt Stock Movement: Qty ${sm?.quantity}, Cost ${sm?.unitCost}`);

  console.log("=== TESTS COMPLETE ===");
}

runTests().catch(console.error).finally(() => prisma.$disconnect());
