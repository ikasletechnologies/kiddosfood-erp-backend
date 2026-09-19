import prisma from '../../lib/prisma';
import { FranchiseOrderService } from '../../modules/franchise/franchise-order.service';
import { FranchiseOrderStatus, FranchiseOrderType } from '@prisma/client';
import { FranchiseService } from '../../modules/franchise/franchise.service';

async function runDispatchTestSuite() {
  console.log('================================================================');
  console.log('🧪 FRANCHISE ORDER DISPATCH FLOW — FULL ACCEPTANCE TEST SUITE');
  console.log('================================================================\n');

  const hq = await FranchiseService.getHqFranchiseOrNull(prisma);
  if (!hq) throw new Error('HQ Franchise not found');

  const franchise = await prisma.franchise.findFirst({
    where: { isHQ: false, status: 'ACTIVE' }
  });
  if (!franchise) throw new Error('Active non-HQ franchise not found');

  console.log(`1️⃣ Using HQ: "${hq.name}" and Franchise: "${franchise.name}"`);

  // Find APPAM product
  const appamProduct = await prisma.product.findFirst({
    where: { sku: 'FG-APPA-450G' }
  });
  if (!appamProduct) throw new Error('APPAM product not found');

  const banyardProduct = await prisma.product.findFirst({
    where: { sku: 'FG-BANY-200G' }
  });
  if (!banyardProduct) throw new Error('BANYARD MILLET product not found');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: APPAM ORDER (CHECK STOCK & ORDER -> APPROVED -> DISPATCHED)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n2️⃣ TEST 1: APPAM Order Lifecycle (Created -> Approved -> Dispatched)...');
  const appamInvBefore = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: appamProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  const appamStockBefore = appamInvBefore.currentStock;
  console.log(`   - APPAM HQ stock before order: ${appamStockBefore} PC`);

  const order1 = await FranchiseOrderService.createOrder({
    franchiseId: franchise.id,
    orderType: FranchiseOrderType.STOCK,
    notes: 'TEST_APPAM_DISPATCH',
    items: [
      {
        productId: appamProduct.id,
        quantity: 2
      }
    ]
  });
  console.log(`   - Created Order: ${order1.orderNumber} (Status: ${order1.status})`);

  // Approve
  const approved1 = await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.APPROVED);
  console.log(`   - Order Status after approval: ${approved1?.status}`);

  const res1 = await prisma.inventoryReservation.findUnique({
    where: { franchiseOrderId: order1.id },
    include: { allocations: true }
  });
  console.log(`   - Reservation created at approval: Status=${res1?.status}, Allocations=${res1?.allocations.length}`);
  if (!res1 || res1.status !== 'ACTIVE') throw new Error('Reservation should be ACTIVE after approval');

  // Dispatch
  const dispatched1 = await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.DISPATCHED);
  console.log(`   - Order Status after dispatch: ${dispatched1?.status}`);

  const appamInvAfter = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: appamProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  console.log(`   - APPAM HQ stock after dispatch: ${appamInvAfter.currentStock} PC (Expected: ${appamStockBefore - 2})`);
  if (appamInvAfter.currentStock !== appamStockBefore - 2) {
    throw new Error(`Expected APPAM stock to decrement by 2, got ${appamInvAfter.currentStock}`);
  }

  const resAfter1 = await prisma.inventoryReservation.findUnique({
    where: { franchiseOrderId: order1.id },
    include: { allocations: true }
  });
  console.log(`   - Reservation Status after dispatch: ${resAfter1?.status}`);
  if (resAfter1?.status !== 'CONSUMED') throw new Error('Reservation should be CONSUMED after dispatch');

  console.log('   ✅ PASS: APPAM order approved and dispatched cleanly!');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: IDEMPOTENCY ON DISPATCH
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n3️⃣ TEST 2: Idempotency (Calling DISPATCHED a second time on order1)...');
  const dispatchedAgain = await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.DISPATCHED);
  const appamInvAfterIdemp = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: appamProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  if (appamInvAfterIdemp.currentStock !== appamInvAfter.currentStock) {
    throw new Error('Idempotent dispatch call modified stock!');
  }
  console.log('   ✅ PASS: Calling Mark Dispatched repeatedly is completely idempotent.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: DELIVER ORDER (FRANCHISE INWARD)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n4️⃣ TEST 3: Delivery (DISPATCHED -> DELIVERED receiving into franchise)...');
  const delivered1 = await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.DELIVERED);
  console.log(`   - Order Status after delivery: ${delivered1?.status}`);
  if (delivered1?.status !== 'DELIVERED') throw new Error('Order should be DELIVERED');
  console.log('   ✅ PASS: Franchise inward receipt completed successfully.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: BANYARD MILLET MULTI-UNIT DISPATCH
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n5️⃣ TEST 4: Banyard Millet Multi-unit Dispatch Flow...');
  const banyInvBefore = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: banyardProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  const banyStockBefore = banyInvBefore.currentStock;

  const order2 = await FranchiseOrderService.createOrder({
    franchiseId: franchise.id,
    orderType: FranchiseOrderType.STOCK,
    notes: 'TEST_BANYARD_MULTI_DISPATCH',
    items: [
      {
        productId: banyardProduct.id,
        quantity: 3
      }
    ]
  });

  await FranchiseOrderService.updateStatus(order2.id, FranchiseOrderStatus.APPROVED);
  await FranchiseOrderService.updateStatus(order2.id, FranchiseOrderStatus.DISPATCHED);

  const banyInvAfter = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: banyardProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  console.log(`   - Banyard HQ stock: ${banyStockBefore} -> ${banyInvAfter.currentStock} (Diff: -3)`);
  if (banyInvAfter.currentStock !== banyStockBefore - 3) {
    throw new Error('Banyard stock did not decrement correctly by 3 units');
  }
  console.log('   ✅ PASS: Multi-unit Banyard Millet dispatch verified.');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: CANCELLED ORDER CANNOT BE DISPATCHED
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n6️⃣ TEST 5: Cancelled Order Safety (Cannot dispatch cancelled order)...');
  const order3 = await FranchiseOrderService.createOrder({
    franchiseId: franchise.id,
    orderType: FranchiseOrderType.STOCK,
    notes: 'TEST_CANCELLED_DISPATCH_BLOCK',
    items: [
      {
        productId: appamProduct.id,
        quantity: 1
      }
    ]
  });

  await FranchiseOrderService.updateStatus(order3.id, FranchiseOrderStatus.APPROVED);
  await FranchiseOrderService.updateStatus(order3.id, FranchiseOrderStatus.CANCELLED);

  let cancelDispatchBlocked = false;
  try {
    await FranchiseOrderService.updateStatus(order3.id, FranchiseOrderStatus.DISPATCHED);
  } catch (err: any) {
    cancelDispatchBlocked = true;
    console.log(`   - Dispatching cancelled order rejected as expected: "${err.message}"`);
  }
  if (!cancelDispatchBlocked) throw new Error('Dispatching a cancelled order should have thrown an error!');
  console.log('   ✅ PASS: Cancelled order dispatch strictly rejected.');

  // ──────────────────────────────────────────────────────────────────────────
  // CLEANUP TEST ORDERS
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🧹 Cleaning up test data...');
  for (const o of [order1, order2, order3]) {
    const res = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: o.id } });
    if (res) {
      await prisma.inventoryReservationAllocation.deleteMany({ where: { reservationId: res.id } });
      await prisma.inventoryReservation.delete({ where: { id: res.id } });
    }
    await prisma.stockMovement.deleteMany({ where: { referenceId: o.id } });
    await prisma.franchiseOrderItem.deleteMany({ where: { orderId: o.id } });
    await prisma.franchiseOrder.delete({ where: { id: o.id } });
  }

  // Restore inventory stock count so test is non-destructive
  await prisma.inventoryItem.update({
    where: { id: appamInvBefore.id },
    data: { currentStock: appamStockBefore }
  });
  await prisma.inventoryItem.update({
    where: { id: banyInvBefore.id },
    data: { currentStock: banyStockBefore }
  });

  console.log('   ✅ Cleanup complete.');
  console.log('\n🎉 ALL DISPATCH ACCEPTANCE TESTS PASSED SUCCESSFULLY!');
}

runDispatchTestSuite()
  .catch(e => {
    console.error('❌ Test failed with error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
