import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { SalesController } from '../../modules/sales/sales.controller';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

const closeEnough = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

async function runFranchiseReturnsWorkflowTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING COMPREHENSIVE FRANCHISE RETURNS WORKFLOW TEST SUITE');
  console.log('================================================================\n');

  // 1. Setup Franchises
  const hq = await FranchiseService.getHqFranchise();
  const tn72 = await prisma.franchise.findFirst({
    where: { isHQ: false, name: { contains: 'tn72', mode: 'insensitive' } }
  }) || await prisma.franchise.findFirst({ where: { isHQ: false } });

  if (!tn72) throw new Error('Test Franchise tn72 not found');

  const otherFranchise = await prisma.franchise.create({
    data: {
      name: `Other Franchise ${Date.now()}`,
      isHQ: false,
      location: 'Salem',
      ownerName: 'Other Owner',
      contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      outstandingAmount: 0
    }
  });

  console.log(`📍 HQ Franchise: ${hq.name} (${hq.id})`);
  console.log(`📍 Test Franchise A: ${tn72.name} (${tn72.id})`);
  console.log(`📍 Test Franchise B: ${otherFranchise.name} (${otherFranchise.id})\n`);

  // Setup Finished Good product and inventory in Franchise tn72
  const sku = `RET-FG-${Date.now()}`;
  const invTn72 = await prisma.inventoryItem.create({
    data: {
      name: `Ret Test Product ${Date.now()}`,
      sku,
      category: 'FINISHED_GOOD',
      currentStock: 50,
      unit: 'PC',
      costPrice: 20,
      franchisePrice: 35,
      dealerPrice: 40,
      customerPrice: 50,
      basePrice: 50,
      franchiseId: tn72.id,
      gstRate: 5
    }
  });

  const product = await prisma.product.create({
    data: {
      name: invTn72.name,
      sku,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 50,
      taxPercent: 5,
      isActive: true,
      is_menu_item: false
    }
  });

  // Setup Customer and Cash Account for tn72
  const customer = await prisma.customer.create({
    data: {
      name: `Ret Test Customer ${Date.now()}`,
      phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      franchiseId: tn72.id
    }
  });

  const cashAccount = await prisma.account.create({
    data: {
      name: `tn72 Cash ${Date.now()}`,
      type: 'CASH',
      balance: 10000,
      franchiseId: tn72.id
    }
  });

  const createdOrderIds: string[] = [];
  const createdReturnIds: string[] = [];
  const createdPaymentIds: string[] = [];

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    try {
      await prisma.stockMovement.deleteMany({ where: { referenceId: { in: createdReturnIds }, referenceType: 'SALES_RETURN' } });
      await prisma.payment.deleteMany({ where: { linkedDocId: { in: createdReturnIds } } });
      await prisma.customerLedger.deleteMany({ where: { customerId: customer.id } });
      await prisma.returnItem.deleteMany({ where: { returnId: { in: createdReturnIds } } });
      await prisma.returnOrder.deleteMany({ where: { id: { in: createdReturnIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.payment.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      await prisma.account.delete({ where: { id: cashAccount.id } });
      await prisma.customer.delete({ where: { id: customer.id } });
      await prisma.inventoryItem.delete({ where: { id: invTn72.id } });
      await prisma.product.delete({ where: { id: product.id } });
      await prisma.franchise.delete({ where: { id: otherFranchise.id } });
      console.log('   ✅ Cleanup completed successfully.');
    } catch (e: any) {
      console.log('   ⚠️ Cleanup notice:', e.message);
    }
  };

  try {
    // ── Test 1: Franchise A sells 5 units to Customer ───────────────────────────
    console.log('--- Test 1: Franchise A creates Sale Invoice for 5 units to Customer ---');
    const grossTotal = 50 * 5;
    const taxTotal = grossTotal * 0.05;
    const saleOrderA = await prisma.order.create({
      data: {
        invoiceNum: `TEST-INV-A-${Date.now()}`,
        franchiseId: tn72.id,
        customerId: customer.id,
        customerName: customer.name,
        partyType: 'CUSTOMER',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        paymentType: 'CASH',
        subTotal: grossTotal,
        taxAmount: taxTotal,
        discountAmount: 0,
        totalAmount: grossTotal + taxTotal,
        orderItems: {
          create: [{
            productId: product.id,
            quantity: 5,
            price: 50,
            discountPct: 0,
            taxAmount: taxTotal,
            totalAmount: grossTotal
          }],
        },
        payments: {
          create: [{
            paymentMode: 'CASH',
            paidAmount: grossTotal + taxTotal,
            status: 'PAID',
            accountId: cashAccount.id,
            type: 'DIRECT',
            linkedDocId: `TEST-INV-A`,
            linkedDocType: 'INVOICE'
          }]
        }
      }
    });
    createdOrderIds.push(saleOrderA.id);
    console.log(`   ✅ Created Order #${saleOrderA.invoiceNum} (Total: ₹${saleOrderA.totalAmount}) for Franchise ${tn72.name}`);

    // Create another order for Franchise B
    const saleOrderB = await prisma.order.create({
      data: {
        invoiceNum: `TEST-INV-B-${Date.now()}`,
        franchiseId: otherFranchise.id,
        partyType: 'CUSTOMER',
        customerName: 'Customer B',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subTotal: 100, taxAmount: 5, discountAmount: 0, totalAmount: 105,
        orderItems: { create: [{ productId: product.id, quantity: 2, price: 50, totalAmount: 100 }] }
      }
    });
    createdOrderIds.push(saleOrderB.id);

    // ── Test 2: Franchise Ownership Security Enforcement ────────────────────────
    console.log('\n--- Test 2: Controller Security - Cross-Franchise & Procurement Return Rejection ---');
    
    // Mock Franchise A request context
    const fakeFranchiseAReq: any = {
      user: { role: 'FRANCHISE_ADMIN', franchiseId: tn72.id, userId: 'user-a' },
      body: { posOrderId: saleOrderB.id, reason: 'Cross franchise attempt', items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 50 }] }
    };
    let blockedCrossFranchise = false;
    const fakeResCross: any = {
      status: (code: number) => ({
        json: (data: any) => {
          if (code === 403) blockedCrossFranchise = true;
          return data;
        }
      })
    };
    await SalesController.createReturnOrder(fakeFranchiseAReq, fakeResCross);
    if (!blockedCrossFranchise) throw new Error('SECURITY FAIL: Franchise A was able to return against Franchise B invoice!');
    console.log('   ✅ PASS: Cross-franchise return attempt strictly blocked with 403 Forbidden.');

    // ── Test 3: Over-return Quantity Guard ───────────────────────────────────────
    console.log('\n--- Test 3: Return Quantity Exceeding Sold Qty Guard ---');
    const fakeOverReturnReq: any = {
      user: { role: 'FRANCHISE_ADMIN', franchiseId: tn72.id, userId: 'user-a' },
      body: { posOrderId: saleOrderA.id, reason: 'Over return attempt', items: [{ productId: product.id, productName: product.name, quantity: 10, rate: 50 }] }
    };
    let blockedOverReturn = false;
    const fakeResOver: any = {
      status: (code: number) => ({
        json: (data: any) => {
          if (code === 400) blockedOverReturn = true;
          return data;
        }
      })
    };
    await SalesController.createReturnOrder(fakeOverReturnReq, fakeResOver);
    if (!blockedOverReturn) throw new Error('VALIDATION FAIL: Return quantity exceeding sold quantity was not rejected with 400!');
    console.log('   ✅ PASS: Return quantity exceeding sold quantity strictly blocked with 400 Bad Request.');

    // ── Test 4: Create Valid Return Order (2 units) ──────────────────────────────
    console.log('\n--- Test 4: Create Valid Return Order for 2 units against Franchise A Invoice ---');
    let createdReturnObj: any = null;
    const fakeValidReturnReq: any = {
      user: { role: 'FRANCHISE_ADMIN', franchiseId: tn72.id, userId: 'user-a' },
      body: {
        posOrderId: saleOrderA.id,
        reason: 'Customer returned 2 units with broken seal',
        refundMethod: 'Cash Voucher',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 50, condition: 'Good' }]
      }
    };
    const fakeResValid: any = {
      status: (code: number) => ({
        json: (data: any) => {
          if (code === 201) createdReturnObj = data;
          return data;
        }
      })
    };
    await SalesController.createReturnOrder(fakeValidReturnReq, fakeResValid);
    if (!createdReturnObj) throw new Error('Failed to create valid return order via controller');
    createdReturnIds.push(createdReturnObj.id);

    console.log(`   ✅ Return #${createdReturnObj.returnNumber} created with status: ${createdReturnObj.status}`);
    console.log(`   Refund Amount: ₹${createdReturnObj.refundAmount} (2 units * ₹50 + 5% GST = ₹105.00)`);
    if (!closeEnough(createdReturnObj.refundAmount, 105)) {
      throw new Error(`Expected refundAmount 105, got ${createdReturnObj.refundAmount}`);
    }
    if (createdReturnObj.status !== 'PENDING') {
      throw new Error(`Expected initial status PENDING, got ${createdReturnObj.status}`);
    }

    // ── Test 5: Verify Franchise Return Scoping in getReturnOrders ───────────────
    console.log('\n--- Test 5: Verify Scoping in getReturnOrders ---');
    const franchiseReturns = await SalesService.getReturnOrders({ operatingFranchiseId: tn72.id });
    const foundInFranchiseA = franchiseReturns.some(r => r.id === createdReturnObj.id);
    if (!foundInFranchiseA) throw new Error('Franchise A returns list does NOT contain its own return order!');
    console.log(`   ✅ Franchise A returns list correctly contains return #${createdReturnObj.returnNumber}`);

    const otherFranchiseReturns = await SalesService.getReturnOrders({ operatingFranchiseId: otherFranchise.id });
    const foundInOther = otherFranchiseReturns.some(r => r.id === createdReturnObj.id);
    if (foundInOther) throw new Error('ISOLATION LEAK: Other Franchise saw Franchise A return order!');
    console.log('   ✅ Isolation verified: Other Franchise sees 0 returns from Franchise A.');

    // ── Test 6: Approve Return & Stock Restoration ──────────────────────────────
    console.log('\n--- Test 6: Approve Return & Verify Finished Goods Stock Restoration ---');
    const stockBefore = (await prisma.inventoryItem.findUnique({ where: { id: invTn72.id } }))!.currentStock;
    console.log(`   Franchise inventory stock before approval: ${stockBefore} units`);

    const approveReq: any = {
      user: { role: 'FRANCHISE_ADMIN', franchiseId: tn72.id, userId: 'user-a' },
      params: { id: createdReturnObj.id },
      body: { status: 'APPROVED' }
    };
    let approvedReturn: any = null;
    const fakeResApprove: any = {
      json: (data: any) => { approvedReturn = data; return data; },
      status: (code: number) => ({ json: (d: any) => d })
    };
    await SalesController.updateReturnOrder(approveReq, fakeResApprove);
    if (!approvedReturn || approvedReturn.status !== 'APPROVED') {
      throw new Error('Failed to approve return order');
    }

    const stockAfter = (await prisma.inventoryItem.findUnique({ where: { id: invTn72.id } }))!.currentStock;
    console.log(`   Franchise inventory stock after approval: ${stockAfter} units`);
    if (!closeEnough(stockAfter, stockBefore + 2)) {
      throw new Error(`Expected stock to increase by 2 units (from ${stockBefore} to ${stockBefore + 2}), but got ${stockAfter}`);
    }
    console.log('   ✅ Stock restored strictly into Franchise A inventory (+2 units)!');

    // Verify stock movement was recorded under SALES_RETURN
    const movement = await prisma.stockMovement.findFirst({
      where: { referenceId: createdReturnObj.id, referenceType: 'SALES_RETURN' }
    });
    if (!movement) throw new Error('Expected StockMovement row with referenceType SALES_RETURN');
    console.log(`   ✅ StockMovement logged: type=${movement.movementType}, qty=+${movement.quantity}`);

    // Idempotency: approving again must not restock twice
    await SalesService.restoreStockForReturnOrder(prisma, approvedReturn, 'user-a');
    const stockAfterReRun = (await prisma.inventoryItem.findUnique({ where: { id: invTn72.id } }))!.currentStock;
    if (!closeEnough(stockAfterReRun, stockAfter)) {
      throw new Error('IDEMPOTENCY FAIL: Re-running restoreStockForReturnOrder added stock again!');
    }
    console.log('   ✅ Idempotency verified: re-running approval does not duplicate stock movements.');

    // ── Test 7: Refund Processing via Cash/Bank Account ─────────────────────────
    console.log('\n--- Test 7: Process Return Refund via Franchise Cash Account ---');
    const cashBefore = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    console.log(`   Franchise Cash account balance before refund: ₹${cashBefore}`);

    const refundReq: any = {
      user: { role: 'FRANCHISE_ADMIN', franchiseId: tn72.id, userId: 'user-a' },
      params: { id: createdReturnObj.id },
      body: { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH' }
    };
    let refundResult: any = null;
    const fakeResRefund: any = {
      json: (data: any) => { refundResult = data; return data; },
      status: (code: number) => ({ json: (d: any) => d })
    };
    await SalesController.refundReturnOrder(refundReq, fakeResRefund);

    if (!refundResult || refundResult.returnOrder.status !== 'COMPLETED') {
      throw new Error(`Expected return status COMPLETED, got ${refundResult?.returnOrder?.status}`);
    }

    const cashAfter = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    console.log(`   Franchise Cash account balance after refund: ₹${cashAfter}`);
    if (!closeEnough(cashBefore - cashAfter, 105)) {
      throw new Error(`Expected cash balance to decrease by ₹105, decreased by ${cashBefore - cashAfter}`);
    }
    console.log('   ✅ Payout executed: Franchise Cash account decreased by exact refund amount ₹105.00!');
    console.log('   ✅ Return Order status transitioned to: COMPLETED (Settled)!');

    // ── Test 8: Credit Ledger Refund against Unpaid Order ───────────────────────
    console.log('\n--- Test 8: Credit Ledger Refund against Unpaid Order ---');
    const unpaidOrder = await prisma.order.create({
      data: {
        invoiceNum: `TEST-UNPAID-${Date.now()}`,
        franchiseId: tn72.id,
        customerId: customer.id,
        customerName: customer.name,
        partyType: 'CUSTOMER',
        status: 'COMPLETED',
        paymentStatus: 'UNPAID',
        subTotal: 100, taxAmount: 5, discountAmount: 0, totalAmount: 105,
        orderItems: { create: [{ productId: product.id, quantity: 2, price: 50, taxAmount: 5, totalAmount: 100 }] }
      }
    });
    createdOrderIds.push(unpaidOrder.id);

    const retUnpaid = await SalesService.createReturnOrder({
      posOrderId: unpaidOrder.id,
      customerId: customer.id,
      reason: 'Credit ledger return on unpaid invoice',
      items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 50 }]
    });
    createdReturnIds.push(retUnpaid.id);

    await SalesService.updateReturnOrder(retUnpaid.id, { status: 'APPROVED', approvedBy: 'user-a' });

    // Process refund via Credit Ledger
    const creditRefund = await SalesService.recordRefund(retUnpaid.id, {
      refundMethod: 'Credit Ledger',
      createdBy: 'user-a'
    });

    if (creditRefund.ledger.appliedToOutstanding <= 0) {
      throw new Error('Expected credit ledger to apply against unpaid order outstanding due');
    }
    console.log(`   ✅ Applied ₹${creditRefund.ledger.appliedToOutstanding} to reduce outstanding invoice due.`);
    if (!creditRefund.ledger.ledgerEntry) {
      throw new Error('Expected CustomerLedger CREDIT row');
    }
    console.log(`   ✅ CustomerLedger CREDIT entry created with note: "${creditRefund.ledger.ledgerEntry.note}"`);

    // ── Test 9: Refund Processing with Auto-Resolved Settlement (Omitted Account & Method) ─────────────
    console.log('\n--- Test 9: Refund Processing with Auto-Resolved Settlement (No Account/Method in Payload) ---');
    const cashBeforeAuto = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;

    // Create a 1-unit return against saleOrderA (which was paid into cashAccount)
    const retAuto = await SalesService.createReturnOrder({
      posOrderId: saleOrderA.id,
      reason: 'Auto-settle return without prompt',
      items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 50 }]
    });
    createdReturnIds.push(retAuto.id);
    await SalesService.updateReturnOrder(retAuto.id, { status: 'APPROVED', approvedBy: 'user-a' });

    // Call refundReturnOrder controller with empty body {} - no accountId, no refundMethod
    let autoRefundResult: any = null;
    const reqEmpty: any = {
      user: { role: 'FRANCHISE_ADMIN', franchiseId: tn72.id, userId: 'user-a' },
      params: { id: retAuto.id },
      body: {}
    };
    const resEmpty: any = {
      json: (data: any) => { autoRefundResult = data; return data; },
      status: (code: number) => ({ json: (d: any) => d })
    };
    await SalesController.refundReturnOrder(reqEmpty, resEmpty);

    if (!autoRefundResult || autoRefundResult.returnOrder.status !== 'COMPLETED') {
      throw new Error(`Expected return status COMPLETED, got ${autoRefundResult?.returnOrder?.status}`);
    }

    const cashAfterAuto = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    // 1 unit of ₹50 + 5% GST = ₹52.50
    if (!closeEnough(cashBeforeAuto - cashAfterAuto, 52.5)) {
      throw new Error(`Expected cash balance to decrease by ₹52.50 (inclusive of GST), decreased by ${cashBeforeAuto - cashAfterAuto}`);
    }
    console.log('   ✅ Auto-settlement executed perfectly: Franchise Cash account decreased by ₹52.50 (1 unit + GST)!');
    console.log('   ✅ Settlement account and payment mode auto-resolved without user prompting!');

    console.log('\n================================================================');
    console.log('🎉 ALL FRANCHISE RETURNS WORKFLOW TESTS PASSED PERFECTLY!');
    console.log('================================================================');

  } finally {
    await cleanup();
  }
}

runFranchiseReturnsWorkflowTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ TEST SUITE FAILED:', err);
    process.exit(1);
  });
