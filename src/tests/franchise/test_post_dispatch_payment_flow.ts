import prisma from '../../lib/prisma';
import { FranchiseOrderService } from '../../modules/franchise/franchise-order.service';
import { FranchiseOrderStatus, FranchiseOrderType, LedgerType } from '@prisma/client';
import { FranchiseService } from '../../modules/franchise/franchise.service';

async function runPostDispatchPaymentTestSuite() {
  console.log('================================================================');
  console.log('🧪 SUPER ADMIN POST-DISPATCH PAYMENT WORKFLOW TEST SUITE');
  console.log('================================================================\n');

  // 1. Get HQ and Franchise
  const hq = await FranchiseService.getHqFranchiseOrNull(prisma);
  if (!hq) throw new Error('HQ Franchise not found');

  const franchise = await prisma.franchise.findFirst({
    where: { isHQ: false, status: 'ACTIVE' }
  });
  if (!franchise) throw new Error('Active non-HQ franchise not found');

  let hqAccount = await prisma.account.findFirst({
    where: {
      OR: [{ franchiseId: hq.id }, { franchiseId: null }],
      status: 'ACTIVE'
    }
  });
  if (!hqAccount) {
    hqAccount = await prisma.account.create({
      data: {
        name: 'HQ Main Operating Account Test',
        type: 'BANK',
        balance: 50000,
        franchiseId: hq.id,
        status: 'ACTIVE'
      }
    });
  }

  const appamProduct = await prisma.product.findFirst({
    where: { sku: 'FG-APPA-450G' }
  });
  if (!appamProduct) throw new Error('APPAM product not found');

  const hqInvBefore = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: appamProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  const stockBefore = hqInvBefore.currentStock;
  const initialHqBalance = hqAccount.balance;
  const initialFranchiseOutstanding = franchise.outstandingAmount || 0;

  console.log(`1️⃣ Setup Info:`);
  console.log(`   - HQ: "${hq.name}" | HQ Account: "${hqAccount.name}" (Balance: ₹${initialHqBalance})`);
  console.log(`   - Franchise: "${franchise.name}" (Outstanding: ₹${initialFranchiseOutstanding})`);
  console.log(`   - APPAM Stock: ${stockBefore} PC`);

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 1: CREATE ORDER
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n2️⃣ STEP 1: Franchise places order for 2 APPAM units...');
  const order = await FranchiseOrderService.createOrder({
    franchiseId: franchise.id,
    orderType: FranchiseOrderType.STOCK,
    notes: 'TEST_POST_DISPATCH_PAYMENT',
    items: [{ productId: appamProduct.id, quantity: 2 }]
  });
  console.log(`   - Order Created: ${order.orderNumber} (Status: ${order.status}, Total: ₹${order.totalAmount})`);
  if (order.status !== 'PENDING') throw new Error('Expected order status to be PENDING');

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 2: APPROVE ORDER (RESERVE STOCK)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n3️⃣ STEP 2: HQ Approves Order (Verifies & reserves stock)...');
  const approvedOrder = await FranchiseOrderService.updateStatus(order.id, FranchiseOrderStatus.APPROVED);
  console.log(`   - Order Status: ${approvedOrder?.status}`);
  if (approvedOrder?.status !== 'APPROVED') throw new Error('Expected order status to be APPROVED');

  const reservation = await prisma.inventoryReservation.findUnique({
    where: { franchiseOrderId: order.id },
    include: { allocations: true }
  });
  console.log(`   - Reservation created: Status=${reservation?.status}, Allocated Batches=${reservation?.allocations.length}`);
  if (!reservation || reservation.status !== 'ACTIVE') throw new Error('Active reservation expected');

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 3: MARK DISPATCHED (NO PAYMENT RECORDED HERE)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n4️⃣ STEP 3: Super Admin Marks Dispatched (No payment modal/action here)...');
  const dispatchedOrder = await FranchiseOrderService.updateStatus(order.id, FranchiseOrderStatus.DISPATCHED);
  console.log(`   - Order Status: ${dispatchedOrder?.status}`);
  if (dispatchedOrder?.status !== 'DISPATCHED') throw new Error('Expected order status to be DISPATCHED');

  const hqInvAfterDispatch = await prisma.inventoryItem.findFirstOrThrow({
    where: { sku: appamProduct.sku, OR: [{ franchiseId: hq.id }, { franchiseId: null }] } as any
  });
  console.log(`   - HQ Stock after dispatch: ${hqInvAfterDispatch.currentStock} PC (Decremented by 2)`);
  if (hqInvAfterDispatch.currentStock !== stockBefore - 2) throw new Error('HQ stock did not decrement correctly');

  // Verify HQ Account balance is UNCHANGED
  const hqAccountAfterDispatch = await prisma.account.findUniqueOrThrow({ where: { id: hqAccount.id } });
  console.log(`   - HQ Account balance: ₹${hqAccountAfterDispatch.balance} (Unchanged: ${hqAccountAfterDispatch.balance === initialHqBalance})`);
  if (hqAccountAfterDispatch.balance !== initialHqBalance) throw new Error('HQ balance must not change during dispatch');

  // Verify NO payment records exist for this order yet
  const paymentsBefore = await prisma.payment.findMany({
    where: { OR: [{ linkedDocId: order.orderNumber }, { linkedDocId: order.id }] }
  });
  console.log(`   - Payments count before Mark Payment: ${paymentsBefore.length}`);
  if (paymentsBefore.length > 0) throw new Error('No payments should exist before Mark Payment');

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 4: MARK PAYMENT (SUPER ADMIN CONFIRMS PAYMENT RECEIVED)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n5️⃣ STEP 4: Super Admin Clicks "Mark Payment" & Confirms Payment Received...');
  const orderDetails = await FranchiseOrderService.getOrderById(order.id);
  const outstandingToReceive = orderDetails?.balanceDue || order.totalAmount;
  console.log(`   - Outstanding Amount to Receive: ₹${outstandingToReceive}`);

  const paidOrder = await FranchiseOrderService.recordPayment(
    order.id,
    outstandingToReceive,
    hqAccount.id,
    'Super Admin',
    true // isHqAdmin
  );
  console.log(`   - Order Payment Status: ${paidOrder.paymentStatus}`);
  console.log(`   - Order Status remains: ${paidOrder.status} (MUST remain DISPATCHED)`);
  if (paidOrder.paymentStatus !== 'PAID') throw new Error('Expected paymentStatus to be PAID');
  if (paidOrder.status !== 'DISPATCHED') throw new Error('Order status must remain DISPATCHED after payment');

  // Verify HQ Account balance INCREASED by totalAmount
  const hqAccountAfterPayment = await prisma.account.findUniqueOrThrow({ where: { id: hqAccount.id } });
  console.log(`   - HQ Account balance: ₹${initialHqBalance} -> ₹${hqAccountAfterPayment.balance} (Diff: +₹${outstandingToReceive})`);
  if (hqAccountAfterPayment.balance !== initialHqBalance + outstandingToReceive) {
    throw new Error('HQ Account balance was not credited properly');
  }

  // Verify Payment Record
  const paymentsAfter = await prisma.payment.findMany({
    where: { OR: [{ linkedDocId: order.orderNumber }, { linkedDocId: order.id }], status: 'SUCCESS' }
  });
  console.log(`   - Payment record created: Mode=${paymentsAfter[0]?.paymentMode}, Amount=₹${paymentsAfter[0]?.paidAmount}`);
  if (paymentsAfter.length !== 1 || paymentsAfter[0].paidAmount !== outstandingToReceive) {
    throw new Error('Payment record was not created accurately');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 5: DUPLICATE PAYMENT ATTEMPT IS BLOCKED
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n6️⃣ STEP 5: Duplicate Payment Attempt Protection...');
  let duplicateBlocked = false;
  try {
    await FranchiseOrderService.recordPayment(order.id, outstandingToReceive, hqAccount.id, 'Super Admin', true);
  } catch (err: any) {
    duplicateBlocked = true;
    console.log(`   - Duplicate payment correctly blocked with message: "${err.message}"`);
  }
  if (!duplicateBlocked) throw new Error('Duplicate payment should have been blocked');
  console.log('   ✅ PASS: Duplicate payment protection verified.');

  // ──────────────────────────────────────────────────────────────────────────
  // STEP 6: MARK DELIVERED (COMPLETES DELIVERY FLOW)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n7️⃣ STEP 6: Complete Delivery Flow (DISPATCHED -> DELIVERED)...');
  const deliveredOrder = await FranchiseOrderService.updateStatus(order.id, FranchiseOrderStatus.DELIVERED);
  console.log(`   - Final Order Status: ${deliveredOrder?.status}`);
  if (deliveredOrder?.status !== 'DELIVERED') throw new Error('Expected order status to be DELIVERED');
  console.log('   ✅ PASS: Order delivery finished successfully.');

  // ──────────────────────────────────────────────────────────────────────────
  // CLEANUP TEST DATA
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n🧹 Cleaning up test data...');
  const res = await prisma.inventoryReservation.findUnique({ where: { franchiseOrderId: order.id } });
  if (res) {
    await prisma.inventoryReservationAllocation.deleteMany({ where: { reservationId: res.id } });
    await prisma.inventoryReservation.delete({ where: { id: res.id } });
  }
  await prisma.payment.deleteMany({ where: { OR: [{ linkedDocId: order.orderNumber }, { linkedDocId: order.id }] } });
  await prisma.franchiseLedger.deleteMany({ where: { referenceId: order.orderNumber } });
  await prisma.stockMovement.deleteMany({ where: { referenceId: order.id } });
  await prisma.productBatch.deleteMany({ where: { batchCode: { contains: order.orderNumber } } });
  await prisma.franchiseOrderItem.deleteMany({ where: { orderId: order.id } });
  await prisma.franchiseOrder.delete({ where: { id: order.id } });

  // Revert account balance & inventory
  await prisma.account.update({
    where: { id: hqAccount.id },
    data: { balance: initialHqBalance }
  });
  await prisma.inventoryItem.update({
    where: { id: hqInvBefore.id },
    data: { currentStock: stockBefore }
  });
  await prisma.franchise.update({
    where: { id: franchise.id },
    data: { outstandingAmount: initialFranchiseOutstanding }
  });

  console.log('   ✅ Cleanup complete.');
  console.log('\n🎉 ALL POST-DISPATCH PAYMENT WORKFLOW TESTS PASSED SUCCESSFULLY!');
}

runPostDispatchPaymentTestSuite()
  .catch(e => {
    console.error('❌ Test failed with error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
