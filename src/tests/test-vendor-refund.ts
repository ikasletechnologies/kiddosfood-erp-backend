import prisma from '../lib/prisma';
import { FinanceService } from '../modules/finance/finance.service';
import { ProcurementService } from '../modules/procurement/procurement.service';
import { AccountService } from '../modules/finance/account.service';

async function testVendorRefund() {
  console.log('--- STARTING VENDOR REFUND REGRESSION TEST ---');

  // Create test entities
  const testId = `refund-test-${Date.now()}`;
  
  const vendor = await prisma.vendor.create({
    data: {
      name: `Refund Test Vendor ${testId}`,
      vendorCode: `V-REF-${Date.now()}`,
      contact: '1234567890'
    }
  });

  const account = await prisma.account.create({
    data: {
      name: `Refund Test Bank ${testId}`,
      type: 'BANK',
      balance: 10000.00,
      status: 'ACTIVE'
    }
  });

  console.log(`Created test vendor: ${vendor.name} (${vendor.id})`);
  console.log(`Created test account: ${account.name} (${account.id}) with ₹10,000.00`);

  // Simulate an initial purchase return (creating a vendor debit balance)
  // We'll just manually inject a VendorLedger DEBIT for 100 to mock it quickly
  await prisma.vendorLedger.create({
    data: {
      vendorId: vendor.id,
      type: 'DEBIT',
      amount: 100.00,
      balanceAfterTransaction: -100.00,
      sourceModule: 'PROCUREMENT',
      referenceType: 'RETURN',
      referenceId: 'MOCK-RETURN',
      note: 'Mock Purchase Return',
      paymentMode: 'CASH'
    }
  });
  console.log(`Injected Mock Purchase Return: DEBIT ₹100.00`);

  // Verify Vendor Balance
  const vendorDetails = await ProcurementService.getVendorById(vendor.id);
  console.log(`Vendor Balance: ₹${vendorDetails!.balance} (Receivable: ${vendorDetails!.balance < 0})`);
  if (vendorDetails!.balance !== -100) {
    console.error(`❌ Expected balance -100, got ${vendorDetails!.balance}`);
    process.exit(1);
  }

  // 1. Over-refund attempt
  try {
    console.log(`Attempting to refund ₹101.00 (exceeding ₹100 receivable)...`);
    await ProcurementService.recordPayment(vendor.id, {
      amount: 101.00,
      note: 'Over-refund test',
      accountId: account.id,
      type: 'REFUND',
      paymentMode: 'BANK',
      transactionRef: 'TRX-122'
    });
    console.error(`❌ Over-refund should have been rejected!`);
    process.exit(1);
  } catch (err: any) {
    console.log(`✅ Over-refund correctly rejected: ${err.message}`);
  }

  // 2. Partial refund (₹60)
  console.log(`Recording Partial Refund of ₹60.00...`);
  await ProcurementService.recordPayment(vendor.id, {
    amount: 60.00,
    note: 'Partial Vendor Refund',
    accountId: account.id,
    type: 'REFUND',
    paymentMode: 'BANK',
    transactionRef: 'TRX-123'
  });

  // Verify After Partial Refund
  const vendorDetailsAfter60 = await ProcurementService.getVendorById(vendor.id);
  console.log(`Vendor Balance After ₹60 Refund: ₹${vendorDetailsAfter60!.balance}`);
  if (vendorDetailsAfter60!.balance !== -40) {
    console.error(`❌ Expected balance -40, got ${vendorDetailsAfter60!.balance}`);
    process.exit(1);
  }

  const accountAfter60 = await prisma.account.findUnique({ where: { id: account.id } });
  console.log(`Bank Account After ₹60 Refund: ₹${accountAfter60!.balance}`);
  if (accountAfter60!.balance !== 10060.00) {
    console.error(`❌ Expected bank balance 10060, got ${accountAfter60!.balance}`);
    process.exit(1);
  }

  // 3. Exact Remaining Refund (₹40)
  console.log(`Recording Remaining Refund of ₹40.00...`);
  await ProcurementService.recordPayment(vendor.id, {
    amount: 40.00,
    note: 'Remaining Vendor Refund',
    accountId: account.id,
    type: 'REFUND',
    paymentMode: 'BANK',
    transactionRef: 'TRX-124'
  });

  const vendorDetailsFinal = await ProcurementService.getVendorById(vendor.id);
  console.log(`Final Vendor Balance: ₹${vendorDetailsFinal!.balance}`);
  if (vendorDetailsFinal!.balance !== 0) {
    console.error(`❌ Expected balance 0, got ${vendorDetailsFinal!.balance}`);
    process.exit(1);
  }

  const accountFinal = await prisma.account.findUnique({ where: { id: account.id } });
  console.log(`Final Bank Account: ₹${accountFinal!.balance}`);
  if (accountFinal!.balance !== 10100.00) {
    console.error(`❌ Expected bank balance 10100, got ${accountFinal!.balance}`);
    process.exit(1);
  }

  // Verify VendorLedger entries
  const ledger = await ProcurementService.getVendorLedger(vendor.id);
  // Re-reverse the ledger to chron order (index 0 = first entry)
  const sortedLedger = ledger.reverse();

  console.log(`\n--- VERIFYING LEDGER RESULTS ---`);
  for (const entry of sortedLedger) {
    console.log(`[${entry.type}] ${entry.referenceType}: ₹${entry.amount} | Running Balance: ₹${entry.runningBalance}`);
  }

  const refundEntries = sortedLedger.filter((e: any) => e.referenceType === 'REFUND');
  if (refundEntries.length !== 2) {
    console.error(`❌ Expected 2 REFUND ledger entries, found ${refundEntries.length}`);
    process.exit(1);
  }
  if (refundEntries[0].type !== 'CREDIT' || refundEntries[1].type !== 'CREDIT') {
    console.error(`❌ REFUND ledger entries should be CREDIT`);
    process.exit(1);
  }

  // 4. Refund from 0 balance
  try {
    console.log(`\nAttempting to refund ₹10.00 from 0 balance...`);
    await ProcurementService.recordPayment(vendor.id, {
      amount: 10.00,
      note: 'Zero-balance refund test',
      accountId: account.id,
      type: 'REFUND',
      paymentMode: 'BANK',
      transactionRef: 'TRX-125'
    });
    console.error(`❌ Zero-balance refund should have been rejected!`);
    process.exit(1);
  } catch (err: any) {
    console.log(`✅ Zero-balance refund correctly rejected: ${err.message}`);
  }

  console.log(`\n✅ ALL VENDOR REFUND REGRESSION TESTS PASSED!`);
}

testVendorRefund()
  .catch(e => {
    console.error('Fatal Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
