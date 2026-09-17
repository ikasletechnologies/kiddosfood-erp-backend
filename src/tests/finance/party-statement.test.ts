import prisma from '../../lib/prisma';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { FinanceService } from '../../modules/finance/finance.service';

// Regression coverage for the Party Statement fix. Before this fix:
//   - The service always loaded every customer/dealer/vendor and scanned them
//     with Array.find() instead of a direct id+type lookup.
//   - No party resolved -> NOT_FOUND / FORBIDDEN / no-party-supplied were all
//     indistinguishable from "party found, zero transactions" (all returned
//     `transactions: []` with HTTP 200).
//   - Customer opening balance was only applied when the CustomerLedger table
//     had zero rows IN THE REQUESTED PERIOD, so any pre-period history was
//     silently dropped whenever in-period ledger rows existed.
//   - Dealer running balance was seeded from the opening balance, then reset
//     to 0 immediately before being recomputed, so the opening balance was
//     effectively discarded unless a synthetic row happened to be pushed.
//   - VendorLedger/CustomerLedger referenceId values were always sliced to 8
//     chars, truncating real business reference numbers (e.g.
//     "PR-2026-00003" -> "PR-2026-").
// See: finance.service.ts FinanceService.getPartyStatement,
//      finance.controller.ts FinanceController.getPartyStatement.
async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING PARTY STATEMENT REGRESSION SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();
  const stamp = Date.now();

  const franchiseB = await prisma.franchise.create({
    data: {
      name: `Party Statement Test Franchise B ${stamp}`,
      isHQ: false,
      location: 'Test Location',
      ownerName: 'Test Owner',
      contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    }
  });

  // Period used throughout: 2020-01-10 -> 2020-01-20 (fixed, unrelated to live data).
  const periodStart = new Date('2020-01-10');
  const periodEnd = new Date('2020-01-20');
  const before = new Date('2020-01-05');
  const midInRange = new Date('2020-01-12');
  const laterInRange = new Date('2020-01-16');
  const startBoundary = new Date('2020-01-10T00:00:00.000Z');
  const endBoundary = new Date('2020-01-20T23:59:59.000Z');

  const cleanupIds = {
    orders: [] as string[], payments: [] as string[], challans: [] as string[],
    customerLedgers: [] as string[], vendorLedgers: [] as string[],
    customers: [] as string[], dealers: [] as string[], vendors: [] as string[],
  };

  const assertEqual = (actual: any, expected: any, label: string) => {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  const countAllLedgerRows = () => Promise.all([
    prisma.order.count(), prisma.payment.count(), prisma.customerLedger.count(),
    prisma.vendorLedger.count(), prisma.deliveryChallan.count()
  ]);

  try {
    // ── Fixture: Customer A (HQ) — no CustomerLedger rows -> order-synthesis path ──
    const customerA = await prisma.customer.create({ data: { name: `PS Test Customer A ${stamp}`, franchiseId: hq.id, openingBalance: 0 } });
    cleanupIds.customers.push(customerA.id);
    const custOrderBefore = await prisma.order.create({ data: { invoiceNum: `PS-CUST-A-BEFORE-${stamp}`, franchiseId: hq.id, customerId: customerA.id, partyType: 'CUSTOMER', createdAt: before, subTotal: 100, taxAmount: 0, totalAmount: 100 } });
    const custOrderIn = await prisma.order.create({ data: { invoiceNum: `PS-CUST-A-IN-${stamp}`, franchiseId: hq.id, customerId: customerA.id, partyType: 'CUSTOMER', createdAt: midInRange, subTotal: 250, taxAmount: 0, totalAmount: 250 } });
    cleanupIds.orders.push(custOrderBefore.id, custOrderIn.id);

    // ── Fixture: Customer B (franchise B) — for scope isolation ──
    const customerB = await prisma.customer.create({ data: { name: `PS Test Customer B ${stamp}`, franchiseId: franchiseB.id, openingBalance: 0 } });
    cleanupIds.customers.push(customerB.id);
    const custBOrder = await prisma.order.create({ data: { invoiceNum: `PS-CUST-B-${stamp}`, franchiseId: franchiseB.id, customerId: customerB.id, partyType: 'CUSTOMER', createdAt: midInRange, subTotal: 77, taxAmount: 0, totalAmount: 77 } });
    cleanupIds.orders.push(custBOrder.id);

    // ── Fixture: Dealer A (HQ) ──
    const dealerA = await prisma.dealer.create({ data: { name: `PS Test Dealer A ${stamp}`, franchiseId: hq.id, status: 'ACTIVE', openingBalance: 500 } });
    cleanupIds.dealers.push(dealerA.id);
    const dealerOrderBefore = await prisma.order.create({ data: { invoiceNum: `PS-DEALER-A-BEFORE-${stamp}`, franchiseId: hq.id, partyType: 'DEALER', partyId: dealerA.id, createdAt: before, subTotal: 50, taxAmount: 0, totalAmount: 50 } });
    const dealerOrderIn = await prisma.order.create({ data: { invoiceNum: `PS-DEALER-A-IN-${stamp}`, franchiseId: hq.id, partyType: 'DEALER', partyId: dealerA.id, createdAt: midInRange, subTotal: 200, taxAmount: 0, totalAmount: 200 } });
    cleanupIds.orders.push(dealerOrderBefore.id, dealerOrderIn.id);
    const dealerPayment = await prisma.payment.create({ data: { entityType: 'DEALER', entityId: dealerA.id, orderId: null, paidAmount: 80, createdAt: laterInRange, status: 'SUCCESS', isCancelled: false } });
    cleanupIds.payments.push(dealerPayment.id);
    const dealerChallan = await prisma.deliveryChallan.create({ data: { challanNumber: `PS-CHALLAN-${stamp}`, dealerId: dealerA.id, challanDate: midInRange, totalAmount: 999 } });
    cleanupIds.challans.push(dealerChallan.id);

    // ── Fixture: Vendor A (company-wide) ──
    const vendorA = await prisma.vendor.create({ data: { name: `PS Test Vendor A ${stamp}`, contact: '9000000000', openingBalance: 1000 } });
    cleanupIds.vendors.push(vendorA.id);
    const vlBefore = await prisma.vendorLedger.create({ data: { vendorId: vendorA.id, amount: 300, referenceType: 'PO', referenceId: 'BILL-TEST-BEFORE', type: 'CREDIT', paymentMode: 'CASH', createdAt: before } });
    const vlStartBoundary = await prisma.vendorLedger.create({ data: { vendorId: vendorA.id, amount: 20, referenceType: 'PO', referenceId: 'BILL-TEST-START', type: 'CREDIT', paymentMode: 'CASH', createdAt: startBoundary } });
    const vlIn1 = await prisma.vendorLedger.create({ data: { vendorId: vendorA.id, amount: 150, referenceType: 'PO', referenceId: 'BILL-TEST-0001', type: 'CREDIT', paymentMode: 'CASH', createdAt: midInRange } });
    const vlIn2 = await prisma.vendorLedger.create({ data: { vendorId: vendorA.id, amount: 40, referenceType: 'PAYMENT', referenceId: 'PAY-TEST-0001', type: 'DEBIT', paymentMode: 'CASH', createdAt: laterInRange } });
    const vlDecimal = await prisma.vendorLedger.create({ data: { vendorId: vendorA.id, amount: 51.5, referenceType: 'PO', referenceId: 'BILL-TEST-DECIMAL', type: 'CREDIT', paymentMode: 'CASH', createdAt: new Date('2020-01-18') } });
    const vlEndBoundary = await prisma.vendorLedger.create({ data: { vendorId: vendorA.id, amount: 5, referenceType: 'PO', referenceId: 'BILL-TEST-END', type: 'CREDIT', paymentMode: 'CASH', createdAt: endBoundary } });
    cleanupIds.vendorLedgers.push(vlBefore.id, vlStartBoundary.id, vlIn1.id, vlIn2.id, vlDecimal.id, vlEndBoundary.id);

    const [ordersBefore0, paymentsBefore0, custLedgerBefore0, vendorLedgerBefore0, challansBefore0] = await countAllLedgerRows();

    // ── 1. CUSTOMER — order-synthesis, opening balance includes pre-period order ──
    console.log('--- 1. Customer opening balance includes pre-period activity (not just in-range rows) ---');
    const r1: any = await FinanceService.getPartyStatement({ franchiseId: hq.id, partyId: customerA.id, partyType: 'CUSTOMER', startDate: periodStart, endDate: periodEnd });
    assertEqual(r1.status, 'OK', 'r1.status');
    assertEqual(r1.openingBalance, 100, 'r1.openingBalance');
    assertEqual(r1.totalEntries, 1, 'r1.totalEntries');
    assertEqual(r1.closingBalance, 350, 'r1.closingBalance');
    assertEqual(r1.entries[0].voucherNo, `PS-CUST-A-IN-${stamp}`, 'r1.entries[0].voucherNo (full, not truncated)');
    console.log(`   ✅ opening=${r1.openingBalance} entries=${r1.totalEntries} closing=${r1.closingBalance}\n`);

    // ── 2. Franchise scope isolation ──
    console.log('--- 2. Franchise-scoped request cannot read another franchise\'s customer ---');
    const r2: any = await FinanceService.getPartyStatement({ franchiseId: hq.id, partyId: customerB.id, partyType: 'CUSTOMER', startDate: periodStart, endDate: periodEnd });
    assertEqual(r2.status, 'FORBIDDEN', 'r2.status (HQ-scoped request against franchise-B customer)');
    const r2b: any = await FinanceService.getPartyStatement({ partyId: customerB.id, partyType: 'CUSTOMER', startDate: periodStart, endDate: periodEnd });
    assertEqual(r2b.status, 'OK', 'r2b.status (unscoped/SUPER_ADMIN request)');
    assertEqual(r2b.totalEntries, 1, 'r2b.totalEntries');
    console.log('   ✅ scoped request forbidden; unscoped (SUPER_ADMIN) request succeeds\n');

    // ── 3. DEALER — opening balance fix, challan present but balance-neutral ──
    console.log('--- 3. Dealer opening balance = static + pre-period orders; challan does not move balance ---');
    const r3: any = await FinanceService.getPartyStatement({ franchiseId: hq.id, partyId: dealerA.id, partyType: 'DEALER', startDate: periodStart, endDate: periodEnd });
    assertEqual(r3.status, 'OK', 'r3.status');
    assertEqual(r3.openingBalance, 550, 'r3.openingBalance (500 static + 50 pre-period order)');
    assertEqual(r3.totalEntries, 3, 'r3.totalEntries (order + payment + challan)');
    assertEqual(r3.closingBalance, 670, 'r3.closingBalance (550 + 200 debit - 80 credit)');
    const challanEntry = r3.entries.find((e: any) => e.txnType === 'Delivery Challan');
    if (!challanEntry) throw new Error('Expected a Delivery Challan entry');
    assertEqual(challanEntry.debit, 0, 'challan debit');
    assertEqual(challanEntry.credit, 0, 'challan credit');
    console.log(`   ✅ opening=${r3.openingBalance} entries=${r3.totalEntries} closing=${r3.closingBalance}\n`);

    // ── 4. VENDOR — opening balance logic untouched (pre-period ledger excluded), full voucher refs, decimals, date boundaries ──
    console.log('--- 4. Vendor opening balance stays static-only (unchanged); full voucher refs; decimal precision; inclusive date boundaries ---');
    const r4: any = await FinanceService.getPartyStatement({ partyId: vendorA.id, partyType: 'VENDOR', startDate: periodStart, endDate: periodEnd });
    assertEqual(r4.status, 'OK', 'r4.status');
    assertEqual(r4.openingBalance, 1000, 'r4.openingBalance (static field only — pre-period VendorLedger row must NOT be aggregated in)');
    assertEqual(r4.totalEntries, 5, 'r4.totalEntries (start-boundary + 2 mid + decimal + end-boundary; pre-period row excluded)');
    assertEqual(r4.closingBalance, 1000 + 20 + 150 - 40 + 51.5 + 5, 'r4.closingBalance');
    const fullRefEntry = r4.entries.find((e: any) => e.referenceId === 'BILL-TEST-0001');
    if (!fullRefEntry) throw new Error('Expected entry with referenceId BILL-TEST-0001');
    assertEqual(fullRefEntry.voucherNo, 'BILL-TEST-0001', 'voucherNo must be the full business reference, not sliced to 8 chars');
    const decimalEntry = r4.entries.find((e: any) => e.referenceId === 'BILL-TEST-DECIMAL');
    if (!decimalEntry) throw new Error('Expected decimal entry');
    assertEqual(decimalEntry.credit, 51.5, 'decimal precision preserved (51.5, not 51 or 52)');
    if (!r4.entries.some((e: any) => e.referenceId === 'BILL-TEST-START')) throw new Error('Start-of-range boundary transaction must be included (inclusive gte)');
    if (!r4.entries.some((e: any) => e.referenceId === 'BILL-TEST-END')) throw new Error('End-of-range boundary transaction (23:59:59) must be included (inclusive lte)');
    console.log(`   ✅ opening=${r4.openingBalance} entries=${r4.totalEntries} closing=${r4.closingBalance}, voucherNo="${fullRefEntry.voucherNo}", decimal=${decimalEntry.credit}\n`);

    // ── 5. No party supplied -> browse mode, not a failure ──
    console.log('--- 5. No party supplied returns a browse/picker response, not an error ---');
    const r5: any = await FinanceService.getPartyStatement({});
    assertEqual(r5.status, 'NO_PARTY', 'r5.status');
    if (!Array.isArray(r5.customers)) throw new Error('Expected customers array for the party picker');
    console.log(`   ✅ status=NO_PARTY, customers available for picker (${r5.customers.length})\n`);

    // ── 6. Invalid party id -> NOT_FOUND ──
    console.log('--- 6. Non-existent partyId returns NOT_FOUND ---');
    const r6: any = await FinanceService.getPartyStatement({ partyId: '00000000-0000-0000-0000-000000000000', partyType: 'VENDOR' });
    assertEqual(r6.status, 'NOT_FOUND', 'r6.status');
    console.log('   ✅ status=NOT_FOUND\n');

    // ── 7. Invalid party type -> BAD_PARTY_TYPE ──
    console.log('--- 7. Invalid partyType is rejected ---');
    const r7: any = await FinanceService.getPartyStatement({ partyId: vendorA.id, partyType: 'FRANCHISE' as any });
    assertEqual(r7.status, 'BAD_PARTY_TYPE', 'r7.status');
    console.log('   ✅ status=BAD_PARTY_TYPE\n');

    // ── 8. Read-only guarantee ──
    console.log('--- 8. Party Statement never writes Order/Payment/Ledger/Challan rows ---');
    const [ordersAfter, paymentsAfter, custLedgerAfter, vendorLedgerAfter, challansAfter] = await countAllLedgerRows();
    assertEqual(ordersAfter, ordersBefore0, 'Order count unchanged');
    assertEqual(paymentsAfter, paymentsBefore0, 'Payment count unchanged');
    assertEqual(custLedgerAfter, custLedgerBefore0, 'CustomerLedger count unchanged');
    assertEqual(vendorLedgerAfter, vendorLedgerBefore0, 'VendorLedger count unchanged');
    assertEqual(challansAfter, challansBefore0, 'DeliveryChallan count unchanged');
    console.log('   ✅ no rows created by any of the above calls\n');

    console.log('====================================================');
    console.log('🎉 ALL PARTY STATEMENT REGRESSION CHECKS PASSED');
    console.log('====================================================');
  } finally {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    const step = async (label: string, fn: () => Promise<any>) => {
      try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
    };
    await step('payments', () => prisma.payment.deleteMany({ where: { id: { in: cleanupIds.payments } } }));
    await step('challans', () => prisma.deliveryChallan.deleteMany({ where: { id: { in: cleanupIds.challans } } }));
    await step('orders', () => prisma.order.deleteMany({ where: { id: { in: cleanupIds.orders } } }));
    await step('vendorLedgers', () => prisma.vendorLedger.deleteMany({ where: { id: { in: cleanupIds.vendorLedgers } } }));
    await step('vendors', () => prisma.vendor.deleteMany({ where: { id: { in: cleanupIds.vendors } } }));
    await step('dealers', () => prisma.dealer.deleteMany({ where: { id: { in: cleanupIds.dealers } } }));
    await step('customers', () => prisma.customer.deleteMany({ where: { id: { in: cleanupIds.customers } } }));
    await step('franchiseB', () => prisma.franchise.delete({ where: { id: franchiseB.id } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  }
}

main()
  .catch((e) => {
    console.error('❌ Test failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
