import prisma from '../../lib/prisma';
import { FranchiseOrderService } from '../../modules/franchise/franchise-order.service';
import { FranchiseOrderStatus } from '@prisma/client';

async function runPaymentTests() {
  console.log('================================================================');
  console.log('🧪 TWO-PHASE FRANCHISE PAYMENT FLOW — END-TO-END TEST SUITE');
  console.log('================================================================\n');

  try {
    const hqFranchise = await prisma.franchise.findFirst({
      where: { isHQ: true },
      include: { accounts: true },
    });
    if (!hqFranchise) throw new Error('No HQ Franchise found');

    const hqAccount = hqFranchise.accounts[0];
    if (!hqAccount) throw new Error('No HQ Account found');

    const franchise = await prisma.franchise.findFirst({
      where: { isHQ: false, status: 'ACTIVE' },
      include: { accounts: true },
    });
    if (!franchise) throw new Error('No active test franchise found');

    let franchiseAccount = franchise.accounts[0];
    if (!franchiseAccount) {
      franchiseAccount = await prisma.account.create({
        data: {
          franchise: { connect: { id: franchise.id } },
          name: `${franchise.name} Test Cash Account`,
          type: 'CASH',
          balance: 50000,
        },
      });
    }

    // Find product with existing HQ inventory
    let testProduct = await prisma.product.findFirst({
      where: {
        isActive: true,
        sku: 'FG-BANY-200G' // Known product with stock
      }
    });
    if (!testProduct) {
      testProduct = await prisma.product.findFirst({ where: { isActive: true } });
    }
    if (!testProduct) throw new Error('No test product found');

    console.log(`1️⃣ Environment:`);
    console.log(`   - HQ Franchise: ${hqFranchise.name} (ID: ${hqFranchise.id})`);
    console.log(`   - HQ Account: "${hqAccount.name}" (Balance: ₹${hqAccount.balance})`);
    console.log(`   - Franchise: "${franchise.name}" (ID: ${franchise.id})`);
    console.log(`   - Franchise Account: "${franchiseAccount.name}" (Balance: ₹${franchiseAccount.balance})`);
    console.log(`   - Franchise Initial Outstanding: ₹${franchise.outstandingAmount}\n`);

    // STEP 1: Franchise places order
    console.log('2️⃣ STEP 1: Franchise Places Order...');
    const order = await FranchiseOrderService.createOrder({
      franchiseId: franchise.id,
      items: [{ productId: testProduct.id, quantity: 1 }],
      notes: 'End-to-End Payment Flow Test'
    });
    console.log(`   - Created Order: ${order.orderNumber} (Total: ₹${order.totalAmount})`);
    console.log(`   - Payment Status: ${order.paymentStatus}\n`);

    // STEP 2: Super Admin cannot mark payment when franchise has NOT paid
    console.log('3️⃣ STEP 2: Verify Super Admin Cannot Mark Payment Before Franchise Pays...');
    let blockedPrePayment = false;
    try {
      await FranchiseOrderService.recordPayment(order.id, undefined, hqAccount.id, 'super-admin', true);
    } catch (e: any) {
      blockedPrePayment = true;
      console.log(`   - Expected Rejection: "${e.message}"`);
    }
    if (!blockedPrePayment) throw new Error('Super Admin should not be allowed to mark payment before Franchise pays');
    console.log('   ✅ PASS: Unpaid order cannot be marked as received by HQ\n');

    // STEP 3: Franchise pays the order amount
    console.log('4️⃣ STEP 3: Franchise Pays Order Amount (Source Transaction)...');
    const hqBalBeforeFranPay = (await prisma.account.findUnique({ where: { id: hqAccount.id } }))!.balance;
    const franBalBeforeFranPay = (await prisma.account.findUnique({ where: { id: franchiseAccount.id } }))!.balance;
    const franOutstandingBefore = (await prisma.franchise.findUnique({ where: { id: franchise.id } }))!.outstandingAmount;

    await FranchiseOrderService.recordPayment(order.id, order.totalAmount, franchiseAccount.id, 'franchise-user', false);

    const hqBalAfterFranPay = (await prisma.account.findUnique({ where: { id: hqAccount.id } }))!.balance;
    const franBalAfterFranPay = (await prisma.account.findUnique({ where: { id: franchiseAccount.id } }))!.balance;
    const franOutstandingAfter = (await prisma.franchise.findUnique({ where: { id: franchise.id } }))!.outstandingAmount;

    const paymentsAfterFranPay = await prisma.payment.findMany({
      where: { linkedDocId: order.orderNumber, status: 'SUCCESS' }
    });

    console.log(`   - Franchise Account Balance: ₹${franBalBeforeFranPay} -> ₹${franBalAfterFranPay} (Diff: -₹${franBalBeforeFranPay - franBalAfterFranPay})`);
    console.log(`   - HQ Account Balance: ₹${hqBalBeforeFranPay} -> ₹${hqBalAfterFranPay} (Diff: ₹${hqBalAfterFranPay - hqBalBeforeFranPay} - HQ untouched)`);
    console.log(`   - Franchise Outstanding: ₹${franOutstandingBefore} -> ₹${franOutstandingAfter} (Diff: -₹${franOutstandingBefore - franOutstandingAfter})`);
    console.log(`   - Payments created: ${paymentsAfterFranPay.length} (ApprovedBy: ${paymentsAfterFranPay[0]?.approvedBy || 'null/unapproved'})`);

    if (paymentsAfterFranPay.length !== 1) throw new Error('Exactly 1 source payment should be created');
    if (Math.abs(franBalBeforeFranPay - franBalAfterFranPay - order.totalAmount) > 0.01) throw new Error('Franchise account should be debited');
    if (hqBalBeforeFranPay !== hqBalAfterFranPay) throw new Error('HQ balance must NOT change yet (HQ has not confirmed receipt)');
    if (paymentsAfterFranPay[0].approvedBy !== null) throw new Error('Payment must be unapproved until HQ marks received');
    console.log('   ✅ PASS: Source payment recorded correctly on franchise side\n');

    // STEP 4: Super Admin Approves and Dispatches Order
    console.log('5️⃣ STEP 4: Super Admin Approves & Dispatches Order...');
    await FranchiseOrderService.updateStatus(order.id, FranchiseOrderStatus.APPROVED);
    await FranchiseOrderService.updateStatus(order.id, FranchiseOrderStatus.DISPATCHED);

    const hqBalAfterDispatch = (await prisma.account.findUnique({ where: { id: hqAccount.id } }))!.balance;
    const paymentsAfterDispatch = await prisma.payment.findMany({
      where: { linkedDocId: order.orderNumber, status: 'SUCCESS' }
    });

    console.log(`   - Order Status: DISPATCHED`);
    console.log(`   - HQ Balance after dispatch: ₹${hqBalAfterDispatch} (No money moved during dispatch)`);
    console.log(`   - Total Payments: ${paymentsAfterDispatch.length}`);
    if (hqBalAfterDispatch !== hqBalAfterFranPay) throw new Error('Dispatch must not change HQ balance');
    if (paymentsAfterDispatch.length !== 1) throw new Error('Dispatch must not create payments');
    console.log('   ✅ PASS: Dispatch completed with no monetary distortion\n');

    // STEP 5: Super Admin Mark Payment (HQ Receipt Confirmation)
    console.log('6️⃣ STEP 5: Super Admin Clicks "Mark Payment" (Confirming HQ Receipt)...');
    const orderDataForHq = (await FranchiseOrderService.getOrderById(order.id)) as any;
    console.log(`   - Fetched Order For HQ: paidAmount = ₹${orderDataForHq.paidAmount}, balanceDue = ₹${orderDataForHq.balanceDue}`);
    console.log(`   - Franchise Paid: ${orderDataForHq.franchisePaid}, HQ Received: ${orderDataForHq.hqReceived}`);
    if (!orderDataForHq.franchisePaid) throw new Error('franchisePaid must be true');
    if (orderDataForHq.hqReceived) throw new Error('hqReceived must be false before Super Admin confirms');

    await FranchiseOrderService.recordPayment(order.id, undefined, hqAccount.id, 'super-admin-user', true);

    const hqBalFinal = (await prisma.account.findUnique({ where: { id: hqAccount.id } }))!.balance;
    const franBalFinal = (await prisma.account.findUnique({ where: { id: franchiseAccount.id } }))!.balance;
    const franOutstandingFinal = (await prisma.franchise.findUnique({ where: { id: franchise.id } }))!.outstandingAmount;
    const finalPayments = await prisma.payment.findMany({
      where: { linkedDocId: order.orderNumber, status: 'SUCCESS' }
    });
    const finalOrder = (await FranchiseOrderService.getOrderById(order.id)) as any;

    console.log(`   - HQ Account Balance: ₹${hqBalAfterDispatch} -> ₹${hqBalFinal} (Diff: +₹${hqBalFinal - hqBalAfterDispatch})`);
    console.log(`   - Franchise Account Balance: ₹${franBalAfterFranPay} -> ₹${franBalFinal} (Diff: ₹0 - Not deducted again)`);
    console.log(`   - Franchise Outstanding: ₹${franOutstandingAfter} -> ₹${franOutstandingFinal} (Diff: ₹0 - Not duplicated)`);
    console.log(`   - Total Payment Records in DB: ${finalPayments.length} (Single source payment approved)`);
    console.log(`   - Final Order: paymentStatus = ${finalOrder.paymentStatus}, hqReceived = ${finalOrder.hqReceived}`);

    if (Math.abs(hqBalFinal - (hqBalAfterDispatch + order.totalAmount)) > 0.01) throw new Error('HQ balance should increase by order amount');
    if (franBalFinal !== franBalAfterFranPay) throw new Error('Franchise account must NOT be deducted again');
    if (franOutstandingFinal !== franOutstandingAfter) throw new Error('Franchise outstanding must NOT change again');
    if (finalPayments.length !== 1) throw new Error('Must NOT create duplicate payment record');
    if (!finalOrder.hqReceived) throw new Error('hqReceived must be true after HQ confirmation');
    console.log('   ✅ PASS: HQ receipt confirmed with single payment record and exact ledger accounting\n');

    // STEP 6: Duplicate Super Admin Mark Payment Blocked
    console.log('7️⃣ STEP 6: Verify Duplicate Mark Payment Attempt is Blocked...');
    let blockedDuplicate = false;
    try {
      await FranchiseOrderService.recordPayment(order.id, undefined, hqAccount.id, 'super-admin-user', true);
    } catch (e: any) {
      blockedDuplicate = true;
      console.log(`   - Expected Duplicate Rejection: "${e.message}"`);
    }
    if (!blockedDuplicate) throw new Error('Duplicate Mark Payment was not blocked');
    console.log('   ✅ PASS: Duplicate HQ receipt strictly prevented!\n');

    console.log('🎉 ALL TWO-PHASE PAYMENT INTEGRATION TESTS PASSED PERFECTLY!');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runPaymentTests();
