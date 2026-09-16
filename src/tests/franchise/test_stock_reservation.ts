import prisma from '../../lib/prisma';
import { FranchiseOrderService } from '../../modules/franchise/franchise-order.service';
import { FranchiseOrderStatus, FranchiseOrderType } from '@prisma/client';
import { InventoryReservationService } from '../../modules/inventory/inventory-reservation.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

async function runTest() {
  console.log('--- Starting Stock Reservation Test ---');

  // 1. Find HQ franchise and the BANYARD MILLET 200 G product
  const hq = await FranchiseService.getHqFranchiseOrNull(prisma);
  console.log('HQ Franchise ID:', hq?.id);

  const product = await prisma.product.findFirst({
    where: {
      OR: [
        { sku: { equals: 'FG-BANY-200G', mode: 'insensitive' } },
        { name: { contains: 'BANYARD MILLET', mode: 'insensitive' } }
      ]
    }
  });

  if (!product) {
    console.error('Product BANYARD MILLET 200 G not found!');
    process.exit(1);
  }
  console.log(`Found Product: ${product.name} (SKU: ${product.sku}, ID: ${product.id})`);

  // Find HQ InventoryItem
  const hqInvItem = await prisma.inventoryItem.findFirst({
    where: {
      OR: [{ franchiseId: hq?.id }, { franchiseId: null }],
      sku: { equals: product.sku!, mode: 'insensitive' }
    }
  });
  console.log(`Found HQ InventoryItem: ID=${hqInvItem?.id}, currentStock=${hqInvItem?.currentStock}`);

  if (!hqInvItem) {
    console.error('HQ InventoryItem not found!');
    process.exit(1);
  }

  // Find batches for this inventory item
  const batches = await prisma.inventoryBatch.findMany({
    where: { inventoryItemId: hqInvItem.id, status: 'APPROVED' }
  });
  console.log(`Found ${batches.length} approved batches for item ${hqInvItem.name}:`);
  batches.forEach(b => console.log(` - Batch ${b.batchNumber}: currentQty=${b.currentQty}, warehouseId=${b.warehouseId}`));

  // Find a non-HQ franchise to create the order for
  const franchise = await prisma.franchise.findFirst({
    where: { isHQ: false }
  });
  if (!franchise) {
    console.error('Non-HQ franchise not found!');
    process.exit(1);
  }
  console.log(`Using Franchise: ${franchise.name} (ID: ${franchise.id})`);

  // Step 2: Create a Test Franchise Order (Order Type: STOCK)
  const createdOrder = await FranchiseOrderService.createOrder({
    franchiseId: franchise.id,
    orderType: FranchiseOrderType.STOCK,
    notes: 'TEST_STOCK_RESERVATION_ORDER',
    items: [
      {
        productId: product.id,
        quantity: 1,
      }
    ]
  });
  console.log(`Created Test Order: ${createdOrder.orderNumber} (ID: ${createdOrder.id}, Status: ${createdOrder.status})`);

  try {
    // Step 3: Approve Order
    console.log('\nApproving Order...');
    const approvedOrder = await FranchiseOrderService.updateStatus(createdOrder.id, FranchiseOrderStatus.APPROVED);
    console.log(`Order Status after approval: ${approvedOrder?.status}`);

    // Step 4: Verify Reservation & Allocations
    const reservation = await prisma.inventoryReservation.findUnique({
      where: { franchiseOrderId: createdOrder.id },
      include: { allocations: { include: { inventoryBatch: true } } }
    });

    console.log(`Reservation Header: ID=${reservation?.id}, Status=${reservation?.status}`);
    if (!reservation || reservation.status !== 'ACTIVE') {
      throw new Error(`Reservation is not ACTIVE: ${reservation?.status}`);
    }
    console.log(`Allocations Count: ${reservation.allocations.length}`);
    let totalReserved = 0;
    for (const alloc of reservation.allocations) {
      console.log(` - Allocation: Batch=${alloc.inventoryBatch.batchNumber}, ReservedQty=${alloc.reservedQty}, ItemId=${alloc.inventoryItemId}`);
      totalReserved += alloc.reservedQty;
    }

    if (totalReserved !== 1) {
      throw new Error(`Expected total reserved quantity 1, got ${totalReserved}`);
    }
    console.log('✅ 1 Unit Successfully Reserved!');

    // Step 5: Test over-reservation validation during reserveStock directly and via REQUEST order
    console.log('\nTesting insufficient stock validation on approval...');
    const totalCurrentStock = batches.reduce((acc, b) => acc + b.currentQty, 0);
    const hugeOrder = await FranchiseOrderService.createOrder({
      franchiseId: franchise.id,
      orderType: FranchiseOrderType.REQUEST, // REQUEST type allows order creation even with shortfall
      notes: 'TEST_HUGE_ORDER',
      items: [
        {
          productId: product.id,
          quantity: totalCurrentStock + 999999,
        }
      ]
    });

    let failedAsExpected = false;
    try {
      await prisma.$transaction(async tx => {
        await InventoryReservationService.reserveStock(tx, hugeOrder.id, [
          { productId: product.id, inventoryItemId: hqInvItem.id, quantity: totalCurrentStock + 999999 }
        ]);
      });
    } catch (err: any) {
      failedAsExpected = true;
      console.log(`✅ Excessive stock reservation failed as expected with error: "${err.message}"`);
    }

    if (!failedAsExpected) {
      throw new Error('Excessive reservation should have thrown insufficient stock error!');
    }

    // Clean up huge order
    await prisma.franchiseOrderItem.deleteMany({ where: { orderId: hugeOrder.id } });
    await prisma.franchiseOrder.delete({ where: { id: hugeOrder.id } });

    // Step 6: Test Cancellation and Release
    console.log('\nTesting Order Cancellation and Reservation Release...');
    const cancelledOrder = await FranchiseOrderService.updateStatus(createdOrder.id, FranchiseOrderStatus.CANCELLED);
    console.log(`Order Status after cancellation: ${cancelledOrder?.status}`);

    const reservationAfterCancel = await prisma.inventoryReservation.findUnique({
      where: { franchiseOrderId: createdOrder.id },
      include: { allocations: true }
    });
    console.log(`Reservation Status after cancellation: ${reservationAfterCancel?.status}`);
    if (reservationAfterCancel?.status !== 'RELEASED') {
      throw new Error(`Expected reservation status RELEASED, got ${reservationAfterCancel?.status}`);
    }
    for (const alloc of reservationAfterCancel.allocations) {
      console.log(` - Allocation: reservedQty=${alloc.reservedQty}, releasedQty=${alloc.releasedQty}`);
      if (alloc.releasedQty !== alloc.reservedQty) {
        throw new Error(`Expected releasedQty ${alloc.reservedQty}, got ${alloc.releasedQty}`);
      }
    }
    console.log('✅ Reservation Release Verified!');

    // Clean up test order
    console.log('\nCleaning up test order records...');
    await prisma.inventoryReservationAllocation.deleteMany({ where: { reservationId: reservation.id } });
    await prisma.inventoryReservation.delete({ where: { id: reservation.id } });
    await prisma.franchiseOrderItem.deleteMany({ where: { orderId: createdOrder.id } });
    await prisma.franchiseOrder.delete({ where: { id: createdOrder.id } });
    console.log('✅ Cleanup finished successfully.');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    // Cleanup attempt
    try {
      const res = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: createdOrder.id } });
      if (res) {
        await prisma.inventoryReservationAllocation.deleteMany({ where: { reservationId: res.id } });
        await prisma.inventoryReservation.delete({ where: { id: res.id } });
      }
      await prisma.franchiseOrderItem.deleteMany({ where: { orderId: createdOrder.id } });
      await prisma.franchiseOrder.delete({ where: { id: createdOrder.id } });
    } catch (_) {}
    process.exit(1);
  }

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runTest()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

