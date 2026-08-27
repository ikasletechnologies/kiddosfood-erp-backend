import prisma from '../lib/prisma';
import { PurchaseService } from '../modules/purchase/purchase.service';
import { ProcurementService } from '../modules/procurement/procurement.service';
import { VendorInvoiceService } from '../modules/vendor-invoices/vendor-invoices.service';

async function runTests() {
  console.log('--- STARTING PURCHASE RETURN -> VENDOR LEDGER INTEGRATION TESTS ---');

  // 1. Create a dedicated test vendor and test account
  const vendor = await prisma.vendor.create({
    data: {
      name: `Test Vendor PR Ledger ${Date.now()}`,
      contact: '9876543210',
      email: `test_pr_${Date.now()}@example.com`,
      category: 'Supplies',
      status: 'ACTIVE',
      openingBalance: 0
    }
  });
  console.log(`Created Test Vendor: ${vendor.name} (${vendor.id})`);

  const account = await prisma.account.create({
    data: {
      name: `Test Bank PR ${Date.now()}`,
      type: 'BANK',
      balance: 100000
    }
  });
  console.log(`Created Test Account: ${account.name} with Balance: ₹100,000`);

  // -------------------------------------------------------------
  // TEST SCENARIO A: Purchase = 1000, Payment = 1000, Return = 500
  // Expectation:
  // - Purchase: Credit 1000, Balance = 1000 Cr
  // - Payment: Debit 1000, Balance = 0
  // - Return: Debit 500, Balance = -500 (500 Dr / Advance Credit)
  // -------------------------------------------------------------
  console.log('\n--- Test Scenario A: Payment made, then Return ---');
  
  // 1. Create PO & Purchase Bill 1000
  const poA = await prisma.procurementOrder.create({
    data: {
      vendorId: vendor.id,
      poNumber: `TEST-PO-A-${Date.now()}`,
      totalAmount: 1000,
      status: 'APPROVED'
    }
  });

  const billA = await prisma.$transaction(async (tx) => {
    const inv = await tx.vendorInvoice.create({
      data: {
        vendorId: vendor.id,
        poId: poA.id,
        invoiceNumber: `TEST-BILL-A-${Date.now()}`,
        amount: 1000,
        subtotal: 1000,
        taxAmount: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        status: 'PENDING',
        billDate: new Date()
      }
    });
    await VendorInvoiceService.recognizeLiability(tx, inv.id);
    return inv;
  });
  console.log(`Created Bill A: ${billA.invoiceNumber}, Amount: ${billA.amount}`);

  // 2. Make Payment 1000
  const payA = await ProcurementService.recordPayment(vendor.id, {
    amount: 1000,
    note: `Payment for ${billA.invoiceNumber}`,
    accountId: account.id,
    type: 'PAYMENT',
    paymentMode: 'BANK_TRANSFER',
    vendorInvoiceId: billA.id
  });
  console.log(`Made Payment A: Amount: 1000, id: ${payA.id}`);

  // 3. Create & Complete Purchase Return 500
  const prA = await PurchaseService.createPurchaseReturn({
    vendorId: vendor.id,
    procurementOrderId: poA.id,
    reason: 'Damaged Goods in Batch A',
    status: 'COMPLETED',
    items: [
      { itemName: 'Item Alpha', quantity: 5, unit: 'kg', rate: 100 }
    ]
  });
  console.log(`Created Completed PR A: ${prA.returnNumber}, RefundAmount: ${prA.refundAmount}`);

  // 4. Test Idempotency (re-recognize PR A should not duplicate)
  await prisma.$transaction(async (tx) => {
    await PurchaseService.recognizeReturn(tx, prA.id);
  });

  // Verify Ledger for Vendor
  const ledgerA = await ProcurementService.getVendorLedger(vendor.id);
  console.log('Ledger after Scenario A (most recent first):');
  for (const row of ledgerA) {
    console.log(`  [${row.referenceType}] ${row.returnNumber || row.paymentNumber || row.referenceId} | Type: ${row.type} | Amount: ${row.amount} | Balance: ${row.runningBalance} | Note: ${row.note}`);
  }

  const vendorFinA = await ProcurementService.getVendorById(vendor.id);
  console.log(`Vendor Total Purchased: ${vendorFinA?.totalPurchased} (Expected: 1000)`);
  console.log(`Vendor Total Payments: ${vendorFinA?.totalPayments} (Expected: 1000)`);
  console.log(`Vendor Total Returns: ${vendorFinA?.totalReturns} (Expected: 500)`);
  console.log(`Vendor Balance: ${vendorFinA?.balance} (Expected: -500)`);
  console.log(`Vendor Advance Credit: ${vendorFinA?.advanceCredit} (Expected: 500)`);

  if (vendorFinA?.balance !== -500 || vendorFinA?.totalReturns !== 500) {
    throw new Error(`Scenario A Failed! Expected balance -500 and returns 500, got balance: ${vendorFinA?.balance}, returns: ${vendorFinA?.totalReturns}`);
  }

  // -------------------------------------------------------------
  // TEST SCENARIO B: Return before payment
  // New Vendor B: Purchase = 1000, Return = 500, Payment = 500
  // Expectation:
  // - Purchase: Credit 1000, Balance = 1000 Cr
  // - Return: Debit 500, Balance = 500 Cr
  // - Payment: Debit 500, Balance = 0
  // -------------------------------------------------------------
  console.log('\n--- Test Scenario B: Return before payment ---');
  const vendorB = await prisma.vendor.create({
    data: {
      name: `Test Vendor B ${Date.now()}`,
      contact: '9876543211',
      category: 'Supplies',
      status: 'ACTIVE',
      openingBalance: 0
    }
  });

  const poB = await prisma.procurementOrder.create({
    data: {
      vendorId: vendorB.id,
      poNumber: `TEST-PO-B-${Date.now()}`,
      totalAmount: 1000,
      status: 'APPROVED'
    }
  });

  // 1. Purchase 1000
  const billB = await prisma.$transaction(async (tx) => {
    const inv = await tx.vendorInvoice.create({
      data: {
        vendorId: vendorB.id,
        poId: poB.id,
        invoiceNumber: `TEST-BILL-B-${Date.now()}`,
        amount: 1000,
        subtotal: 1000,
        taxAmount: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        status: 'PENDING',
        billDate: new Date()
      }
    });
    await VendorInvoiceService.recognizeLiability(tx, inv.id);
    return inv;
  });

  // 2. Return 500 (transition from PENDING to COMPLETED via updatePurchaseReturn)
  const prB = await PurchaseService.createPurchaseReturn({
    vendorId: vendorB.id,
    procurementOrderId: poB.id,
    reason: 'Defect in Material B',
    status: 'PENDING',
    items: [
      { itemName: 'Material B', quantity: 10, unit: 'pcs', rate: 50 }
    ]
  });
  console.log(`Created PENDING PR B: ${prB.returnNumber}, refundAmount: ${prB.refundAmount}`);

  // Transition to COMPLETED
  await PurchaseService.updatePurchaseReturn(prB.id, { status: 'COMPLETED' });
  console.log(`Updated PR B to COMPLETED`);

  // 3. Payment 500
  const payB = await ProcurementService.recordPayment(vendorB.id, {
    amount: 500,
    note: `Payment for remaining balance of ${billB.invoiceNumber}`,
    accountId: account.id,
    type: 'PAYMENT',
    paymentMode: 'BANK_TRANSFER',
    vendorInvoiceId: billB.id
  });
  console.log(`Made Payment B: Amount 500`);

  const ledgerB = await ProcurementService.getVendorLedger(vendorB.id);
  console.log('Ledger after Scenario B (most recent first):');
  for (const row of ledgerB) {
    console.log(`  [${row.referenceType}] ${row.returnNumber || row.paymentNumber || row.referenceId} | Type: ${row.type} | Amount: ${row.amount} | Balance: ${row.runningBalance} | Note: ${row.note}`);
  }

  const vendorFinB = await ProcurementService.getVendorById(vendorB.id);
  console.log(`Vendor B Total Purchased: ${vendorFinB?.totalPurchased} (Expected: 1000)`);
  console.log(`Vendor B Total Returns: ${vendorFinB?.totalReturns} (Expected: 500)`);
  console.log(`Vendor B Total Payments: ${vendorFinB?.totalPayments} (Expected: 500)`);
  console.log(`Vendor B Balance: ${vendorFinB?.balance} (Expected: 0)`);

  if (vendorFinB?.balance !== 0) {
    throw new Error(`Scenario B Failed! Expected balance 0, got ${vendorFinB?.balance}`);
  }

  // -------------------------------------------------------------
  // TEST SCENARIO C: Verify S.R. Industries Enterprises Ltd. PR-2026-00001
  // -------------------------------------------------------------
  console.log('\n--- Test Scenario C: Verify S.R. Industries PR-2026-00001 ---');
  const srVendor = await prisma.vendor.findFirst({
    where: { name: { contains: 'S.R. Industries', mode: 'insensitive' } }
  });
  if (srVendor) {
    const srLedger = await ProcurementService.getVendorLedger(srVendor.id);
    const returnRow = srLedger.find(r => r.referenceType === 'RETURN' || (r.returnNumber && r.returnNumber.includes('PR-2026-00001')));
    console.log('S.R. Industries Return Row in Vendor Ledger:', returnRow ? {
      refType: returnRow.referenceType,
      refId: returnRow.referenceId,
      returnNumber: returnRow.returnNumber,
      amount: returnRow.amount,
      type: returnRow.type,
      note: returnRow.note
    } : 'NOT FOUND');

    if (!returnRow || returnRow.amount !== 100 || returnRow.type !== 'DEBIT') {
      throw new Error('S.R. Industries PR-2026-00001 missing or incorrect in Vendor Ledger!');
    }
  }

  // Clean up test vendors and account
  await prisma.vendorLedger.deleteMany({ where: { vendorId: { in: [vendor.id, vendorB.id] } } });
  await prisma.vendorInvoice.deleteMany({ where: { vendorId: { in: [vendor.id, vendorB.id] } } });
  await prisma.purchaseReturnItem.deleteMany({ where: { return: { vendorId: { in: [vendor.id, vendorB.id] } } } });
  await prisma.purchaseReturn.deleteMany({ where: { vendorId: { in: [vendor.id, vendorB.id] } } });
  await prisma.payment.deleteMany({ where: { entityId: { in: [vendor.id, vendorB.id] } } });
  await prisma.procurementOrder.deleteMany({ where: { vendorId: { in: [vendor.id, vendorB.id] } } });
  await prisma.vendor.deleteMany({ where: { id: { in: [vendor.id, vendorB.id] } } });
  await prisma.account.deleteMany({ where: { id: account.id } });
  console.log('\nCleaned up test entities.');

  console.log('\n=== ALL PURCHASE RETURN -> VENDOR LEDGER TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(e => {
  console.error('\n❌ TEST SUITE FAILED:', e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
