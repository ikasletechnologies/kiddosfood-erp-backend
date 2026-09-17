import prisma from '../../lib/prisma';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { FinanceService } from '../../modules/finance/finance.service';

// Regression coverage for the cross-report Party Reporting fix. Before this
// fix:
//   - getPartyReportByItem (finance.service.ts) only ever returned one
//     aggregated row per Customer (saleQuantity/saleAmount), never a
//     per-item row, never joined Product, and never supported Dealer/
//     Franchise parties at all — so item/quantity/amount/date always
//     rendered blank on the frontend regardless of real data.
//   - getSalePurchaseByParty keyed its aggregation Map by the raw
//     `partyName` string, with no id or type check. A Vendor's purchase
//     total and an unrelated Customer/Dealer/Franchise's sales total
//     silently merged into one row whenever they happened to share a name
//     (confirmed in production with two real records both named "ak").
//   - getSalePurchaseByPartyGroupData inherited that corruption one level
//     up when bucketing by the (also name-derived) partyType label.
// See: finance.service.ts resolveOrderParty/resolveVendorParty/
// resolveReturnParty/batchResolvePartyNames (shared party identity, reused
// from the same fix already applied to getPartyProfitLoss).
async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING PARTY REPORTING CROSS-REPORT REGRESSION SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();
  const stamp = Date.now();

  const vendorParty = await prisma.vendor.create({ data: { name: `PRX Shared Name ${stamp}`, contact: '9000000001' } });
  const customerParty = await prisma.customer.create({ data: { name: `PRX Shared Name ${stamp}`, franchiseId: hq.id } });

  const start = new Date('2020-03-10');
  const end = new Date('2020-03-20');
  const mid = new Date('2020-03-14');

  const product = await prisma.product.create({ data: { name: `PRX Test Product ${stamp}`, sku: `PRX-SKU-${stamp}`, basePrice: 100 } });

  const cleanup = { orders: [] as string[], vendorInvoices: [] as string[], procurementOrders: [] as string[], products: [id => id][0] ? [product.id] as string[] : [] };

  const assertEqual = (actual: any, expected: any, label: string) => {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  try {
    // ── Fixture: Customer with the SAME name as a real Vendor — the exact ──
    // ── "ak" collision, reproduced deliberately.                          ──
    const custOrder = await prisma.order.create({
      data: {
        invoiceNum: `PRX-CUST-${stamp}`, franchiseId: hq.id, customerId: customerParty.id, partyType: 'CUSTOMER',
        status: 'COMPLETED', createdAt: mid, subTotal: 100, taxAmount: 5, totalAmount: 105,
        orderItems: { create: [{ productId: product.id, quantity: 2, price: 50, totalAmount: 100 }] }
      }
    });
    cleanup.orders.push(custOrder.id);

    const po = await prisma.procurementOrder.create({
      data: { poNumber: `PRX-PO-${stamp}`, vendorId: vendorParty.id, franchiseId: hq.id, status: 'RECEIVED', totalAmount: 500 }
    });
    cleanup.procurementOrders.push(po.id);
    const vendorInvoice = await prisma.vendorInvoice.create({
      data: { invoiceNumber: `PRX-VINV-${stamp}`, poId: po.id, vendorId: vendorParty.id, amount: 500, billDate: mid, status: 'PENDING' }
    });
    cleanup.vendorInvoices.push(vendorInvoice.id);

    // ── 1-2. Sale & Purchase By Party: Vendor and Customer sharing a name never merge ──
    console.log('--- 1-2. Vendor and Customer sharing the exact same name never merge (the confirmed "ak" mechanism) ---');
    const salePurchase: any[] = await FinanceService.getSalePurchaseByParty({ startDate: start, endDate: end });
    const rowsForSharedName = salePurchase.filter(r => r.partyName === `PRX Shared Name ${stamp}`);
    assertEqual(rowsForSharedName.length, 2, 'two separate rows for the shared name, not one merged row');
    const custRow = rowsForSharedName.find(r => r.partyType === 'CUSTOMER');
    const vendorRow = rowsForSharedName.find(r => r.partyType === 'VENDOR');
    if (!custRow || !vendorRow) throw new Error('Expected one CUSTOMER row and one VENDOR row');
    assertEqual(custRow.totalSale, 100, 'customer totalSale (tax-exclusive)');
    assertEqual(custRow.totalPurchase, 0, 'customer totalPurchase must NOT include the vendor\'s bill');
    assertEqual(vendorRow.totalPurchase, 500, 'vendor totalPurchase');
    assertEqual(vendorRow.totalSale, 0, 'vendor totalSale must NOT include the customer\'s order');
    console.log(`   ✅ Customer row: sale=${custRow.totalSale}, purchase=${custRow.totalPurchase}; Vendor row: sale=${vendorRow.totalSale}, purchase=${vendorRow.totalPurchase}\n`);

    // ── 3. Sale & Purchase By Party Group: purchase lands in "Vendors", not "Customers" ──
    console.log('--- 3. Sale & Purchase By Party Group: vendor purchase lands in the Vendors bucket, not Customers ---');
    const grouped: any[] = await FinanceService.getSalePurchaseByPartyGroupData(undefined as any, '2020-03-10', '2020-03-20');
    const vendorsGroup = grouped.find(g => g.groupName === 'Vendors');
    const customersGroup = grouped.find(g => g.groupName === 'Customers');
    if (!vendorsGroup) throw new Error('Vendors group missing');
    if (vendorsGroup.totalPurchase < 500) throw new Error(`Expected Vendors group totalPurchase to include the 500 fixture bill, got ${vendorsGroup.totalPurchase}`);
    if (customersGroup && customersGroup.totalPurchase !== 0) throw new Error(`Customers group must not include any vendor purchase, got totalPurchase=${customersGroup.totalPurchase}`);
    console.log(`   ✅ Vendors group totalPurchase=${vendorsGroup.totalPurchase} (includes fixture); Customers group totalPurchase=${customersGroup?.totalPurchase ?? 0}\n`);

    // ── 4. Sale & Purchase By Party: sales-return netting ──
    console.log('--- 4. Sale & Purchase By Party: approved return nets revenue for the correct party ---');
    const ret = await prisma.returnOrder.create({
      data: {
        returnNumber: `PRX-RET-${stamp}`, posOrderId: custOrder.id, reason: 'test return',
        status: 'COMPLETED', refundAmount: 52.5, createdAt: mid,
        items: { create: [{ productId: product.id, productName: product.name, quantity: 1, rate: 50, taxableValue: 50, costReversal: 20, totalAmount: 52.5 }] }
      }
    });
    const afterReturn: any[] = await FinanceService.getSalePurchaseByParty({ startDate: start, endDate: end });
    const custRowAfterReturn = afterReturn.find(r => r.partyName === `PRX Shared Name ${stamp}` && r.partyType === 'CUSTOMER');
    if (!custRowAfterReturn) throw new Error('Customer row missing after return');
    assertEqual(custRowAfterReturn.totalSale, 50, 'customer totalSale after 50 is returned (100 - 50)');
    console.log(`   ✅ Customer net sale after return = ${custRowAfterReturn.totalSale}\n`);
    await prisma.returnItem.deleteMany({ where: { returnId: ret.id } });
    await prisma.returnOrder.delete({ where: { id: ret.id } });

    // ── 5. Party Report By Item: real per-item rows ──
    console.log('--- 5. Party Report By Item: returns one row per item, with real itemName/quantity/amount/date ---');
    const byItem: any[] = await FinanceService.getPartyReportByItem({ startDate: start, endDate: end });
    const itemRow = byItem.find(r => r.partyName === `PRX Shared Name ${stamp}` && r.partyType === 'CUSTOMER');
    if (!itemRow) throw new Error('Expected a per-item row for the fixture customer');
    assertEqual(itemRow.itemName, product.name, 'itemRow.itemName');
    assertEqual(itemRow.quantity, 2, 'itemRow.quantity');
    assertEqual(itemRow.amount, 100, 'itemRow.amount (price 50 x quantity 2, tax-exclusive)');
    assertEqual(itemRow.date, '2020-03-14', 'itemRow.date');
    console.log(`   ✅ itemName=${itemRow.itemName}, quantity=${itemRow.quantity}, amount=${itemRow.amount}, date=${itemRow.date}\n`);

    // ── 6. Search ──
    console.log('--- 6. Search filters correctly on both reports ---');
    const searchedItem: any[] = await FinanceService.getPartyReportByItem({ startDate: start, endDate: end, search: 'PRX Shared Name' });
    if (searchedItem.length === 0) throw new Error('Expected search to match the fixture party');
    const searchedSP: any[] = await FinanceService.getSalePurchaseByParty({ startDate: start, endDate: end, search: 'vendor' });
    if (!searchedSP.every(r => r.partyType === 'VENDOR')) throw new Error('Expected search "vendor" to match only VENDOR-type rows');
    console.log(`   ✅ item search matched ${searchedItem.length} row(s); party-type search matched only VENDOR rows\n`);

    console.log('====================================================');
    console.log('🎉 ALL PARTY REPORTING CROSS-REPORT REGRESSION CHECKS PASSED');
    console.log('====================================================');
  } finally {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    const step = async (label: string, fn: () => Promise<any>) => {
      try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
    };
    await step('returnItems (safety net)', () => prisma.returnItem.deleteMany({ where: { return: { returnNumber: `PRX-RET-${stamp}` } } }));
    await step('returns (safety net)', () => prisma.returnOrder.deleteMany({ where: { returnNumber: `PRX-RET-${stamp}` } }));
    await step('orderItems', () => prisma.orderItem.deleteMany({ where: { orderId: { in: cleanup.orders } } }));
    await step('orders', () => prisma.order.deleteMany({ where: { id: { in: cleanup.orders } } }));
    await step('vendorInvoices', () => prisma.vendorInvoice.deleteMany({ where: { id: { in: cleanup.vendorInvoices } } }));
    await step('procurementOrders', () => prisma.procurementOrder.deleteMany({ where: { id: { in: cleanup.procurementOrders } } }));
    await step('products', () => prisma.product.deleteMany({ where: { id: { in: cleanup.products } } }));
    await step('customerParty', () => prisma.customer.delete({ where: { id: customerParty.id } }));
    await step('vendorParty', () => prisma.vendor.delete({ where: { id: vendorParty.id } }));
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
