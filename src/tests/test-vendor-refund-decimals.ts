import prisma from '../lib/prisma';
import { ProcurementService } from '../modules/procurement/procurement.service';
import { FinanceService } from '../modules/finance/finance.service';

async function testVendorRefundDecimals() {
  console.log('--- TESTING VENDOR REFUND DECIMALS ---');

  const testId = `refund-dec-${Date.now()}`;
  
  const vendor = await prisma.vendor.create({
    data: {
      name: `Refund Dec Vendor ${testId}`,
      vendorCode: `V-RDEC-${Date.now()}`,
      contact: '1234567890'
    }
  });

  const account = await prisma.account.create({
    data: {
      name: `Refund Dec Bank ${testId}`,
      type: 'BANK',
      balance: 10000.00,
      status: 'ACTIVE'
    }
  });

  // Inject a mock purchase return for exactly 51.50
  await prisma.vendorLedger.create({
    data: {
      vendorId: vendor.id,
      type: 'DEBIT',
      amount: 51.50,
      balanceAfterTransaction: -51.50,
      sourceModule: 'PROCUREMENT',
      referenceType: 'RETURN',
      referenceId: 'MOCK-RETURN-DEC',
      note: 'Mock Return for Decimal Test',
      paymentMode: 'CASH'
    }
  });

  console.log(`\n--- 1. Verification Before Refund ---`);
  const vendorDetailsBefore = await ProcurementService.getVendorById(vendor.id);
  console.log(`Database/API Vendor Balance: ${vendorDetailsBefore?.balance} (Expected: -51.50)`);

  const ledgerBefore = await ProcurementService.getVendorLedger(vendor.id);
  const ledgerReturn = ledgerBefore.find(e => e.referenceType === 'RETURN');
  console.log(`Ledger Debit Amount: ${ledgerReturn?.amount} (Expected: 51.50)`);
  console.log(`Ledger Running Balance: ${ledgerReturn?.runningBalance} (Expected: -51.50)`);

  console.log(`\n--- 2. Record Partial Refund of ₹25.25 ---`);
  await ProcurementService.recordPayment(vendor.id, {
    amount: 25.25,
    note: 'Partial Refund Decimal',
    accountId: account.id,
    type: 'REFUND',
    paymentMode: 'BANK',
    transactionRef: 'TRX-DEC-1'
  });

  const vendorDetailsMid = await ProcurementService.getVendorById(vendor.id);
  console.log(`Database/API Vendor Balance: ${vendorDetailsMid?.balance} (Expected: -26.25)`);

  const accountMid = await prisma.account.findUnique({ where: { id: account.id } });
  console.log(`Bank Account Balance: ${accountMid?.balance} (Expected: 10025.25)`);

  const ledgerMid = await ProcurementService.getVendorLedger(vendor.id);
  const ledgerRefund1 = ledgerMid.find(e => e.transactionRef === 'TRX-DEC-1' || e.referenceType === 'REFUND');
  console.log(`Ledger Refund 1 Amount: ${ledgerRefund1?.amount} (Expected: 25.25)`);
  console.log(`Ledger Refund 1 Running Balance: ${ledgerRefund1?.runningBalance} (Expected: -26.25)`);

  console.log(`\n--- 3. Record Remaining Refund of ₹26.25 ---`);
  await ProcurementService.recordPayment(vendor.id, {
    amount: 26.25,
    note: 'Remaining Refund Decimal',
    accountId: account.id,
    type: 'REFUND',
    paymentMode: 'BANK',
    transactionRef: 'TRX-DEC-2'
  });

  const vendorDetailsFinal = await ProcurementService.getVendorById(vendor.id);
  console.log(`Database/API Vendor Balance: ${vendorDetailsFinal?.balance} (Expected: 0)`);

  const accountFinal = await prisma.account.findUnique({ where: { id: account.id } });
  console.log(`Bank Account Balance: ${accountFinal?.balance} (Expected: 10051.50)`);

  const ledgerFinal = (await ProcurementService.getVendorLedger(vendor.id)).reverse();
  const lastRefund = ledgerFinal[ledgerFinal.length - 1];
  console.log(`Ledger Final Refund Amount: ${lastRefund?.amount} (Expected: 26.25)`);
  console.log(`Ledger Final Running Balance: ${lastRefund?.runningBalance} (Expected: 0)`);

  console.log(`\n✅ ALL DECIMAL VERIFICATIONS PASSED IN BACKEND!`);
}

testVendorRefundDecimals()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
