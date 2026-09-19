import prisma from '../lib/prisma';
import { ProcurementService } from '../modules/procurement/procurement.service';

async function testVendorLedgerDecimals() {
  console.log('--- STARTING VENDOR LEDGER DECIMAL REGRESSION TEST ---');

  // 1. Create a dummy vendor
  const vendorCode = 'V-TEST-DEC-' + Date.now();
  const vendor = await prisma.vendor.create({
    data: {
      name: 'Decimal Test Vendor',
      vendorCode,
      contact: '9999999999',
      address: 'Test Address',
      openingBalance: 0,
      status: 'ACTIVE'
    }
  });
  console.log(`Created test vendor: ${vendor.name} (${vendor.id})`);

  try {
    // 2. Add an opening balance with decimals directly via service to simulate decimal entry
    await ProcurementService.updateVendor(vendor.id, {
      openingBalance: -690.50, // Credit ₹690.50
    });
    console.log('Added opening balance: Credit ₹690.50');

    // 3. Add a payment out (Debit) with decimals
    await ProcurementService.recordPayment(vendor.id, {
      amount: 488.25,
      note: 'Payment out with decimals',
      accountId: 'test-account',
      type: 'PAYMENT',
      paymentMode: 'CASH',
    });
    console.log('Recorded Payment Out: Debit ₹488.25');

    // 4. Manually insert a Purchase Return ledger entry to simulate exactly the requested test amount
    await prisma.vendorLedger.create({
      data: {
        vendorId: vendor.id,
        amount: 51.50,
        type: 'DEBIT',
        referenceType: 'RETURN',
        referenceId: 'PR-TEST-123',
        paymentMode: 'CASH',
        sourceModule: 'PROCUREMENT',
        balanceAfterTransaction: -690.50 + 488.25 + 51.50, // Calculate manually here just to bypass normal flow for this exact test
        note: 'Purchase Return 51.50'
      }
    });
    console.log('Manually inserted Purchase Return: Debit ₹51.50');

    // 5. Test another value
    await prisma.vendorLedger.create({
      data: {
        vendorId: vendor.id,
        amount: 51.00,
        type: 'DEBIT',
        referenceType: 'RETURN',
        referenceId: 'PR-TEST-124',
        paymentMode: 'CASH',
        sourceModule: 'PROCUREMENT',
        balanceAfterTransaction: -690.50 + 488.25 + 51.50 + 51.00,
        note: 'Purchase Return 51.00'
      }
    });
    console.log('Manually inserted Purchase Return: Debit ₹51.00');


    // Fetch ledger using the service
    const ledger = await ProcurementService.getVendorLedger(vendor.id);
    
    console.log('\n--- VERIFYING LEDGER RESULTS ---');
    let allPassed = true;

    for (const entry of ledger) {
      console.log(`[${entry.type}] ${entry.referenceType}: ₹${entry.amount} | Running Balance: ₹${entry.runningBalance}`);
      
      // Verify precise decimal matching
      if (entry.referenceType === 'OPENING_BALANCE' && entry.amount !== 690.50) {
        console.error(`❌ OPENING_BALANCE failed: Expected 690.50, got ${entry.amount}`);
        allPassed = false;
      }
      if (entry.referenceType === 'PAYMENT' && entry.amount !== 488.25) {
        console.error(`❌ PAYMENT failed: Expected 488.25, got ${entry.amount}`);
        allPassed = false;
      }
      if (entry.note === 'Purchase Return 51.50' && entry.amount !== 51.50) {
        console.error(`❌ RETURN (51.50) failed: Expected 51.50, got ${entry.amount}`);
        allPassed = false;
      }
      if (entry.note === 'Purchase Return 51.50' && entry.type !== 'DEBIT') {
        console.error(`❌ RETURN (51.50) failed: Expected DEBIT accounting direction, got ${entry.type}`);
        allPassed = false;
      }
      if (entry.note === 'Purchase Return 51.00' && entry.amount !== 51.00) {
        console.error(`❌ RETURN (51.00) failed: Expected 51.00, got ${entry.amount}`);
        allPassed = false;
      }
    }

    const finalBalance = ledger[0].runningBalance;
    const expectedBalance = -690.50 + 488.25 + 51.50 + 51.00;
    
    // JS float arithmetic safety check
    if (Math.abs(finalBalance - expectedBalance) > 0.001) {
       console.error(`❌ Running Balance failed: Expected ${expectedBalance}, got ${finalBalance}`);
       allPassed = false;
    } else {
       console.log(`✅ Running Balance matched: ${finalBalance}`);
    }

    if (allPassed) {
      console.log('\n✅ ALL DECIMAL REGRESSION TESTS PASSED!');
    } else {
      console.log('\n❌ SOME TESTS FAILED.');
      process.exit(1);
    }

  } finally {
    // Cleanup
    await prisma.vendorLedger.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.vendor.delete({ where: { id: vendor.id } });
  }
}

testVendorLedgerDecimals().catch(e => {
  console.error(e);
  process.exit(1);
});
