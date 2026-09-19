import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Regression coverage for the Sales Returns Customer/Dealer/Franchise
// classification fix. Before this fix:
//   - ReturnOrder had no `dealerId` field at all — a Dealer-sourced return
//     had its party identity silently dropped, and both Customer and
//     Dealer returns were lumped into one undifferentiated "PARTNER"
//     bucket in the frontend, both displayed/labeled as "Dealer".
//   - createReturnOrder unconditionally copied Order.franchiseId (the
//     OPERATING branch that processed the sale, present on virtually every
//     Order) into ReturnOrder.franchiseId — mislabeling every POS-sourced
//     Customer/Dealer return as a Franchise return.
// See: prisma/schema.prisma ReturnOrder.dealerId,
//      sales.service.ts createReturnOrder's party resolution,
//      app/sales/returns/page.tsx normalizeReturn/activeTab.
async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING RETURNS PARTY-CLASSIFICATION REGRESSION SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();

  const customer = await prisma.customer.create({
    data: { name: `Returns Test Customer ${Date.now()}`, franchiseId: hq.id }
  });
  const dealer = await prisma.dealer.create({
    data: { name: `Returns Test Dealer ${Date.now()}`, franchiseId: hq.id, status: 'ACTIVE' }
  });

  const createdOrderIds: string[] = [];
  const createdReturnIds: string[] = [];

  const step = async (label: string, fn: () => Promise<any>) => {
    try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
  };

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    await step('returnItem', () => prisma.returnItem.deleteMany({ where: { returnId: { in: createdReturnIds } } }));
    await step('returnOrder', () => prisma.returnOrder.deleteMany({ where: { id: { in: createdReturnIds } } }));
    await step('order', () => prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }));
    await step('customer', () => prisma.customer.delete({ where: { id: customer.id } }));
    await step('dealer', () => prisma.dealer.delete({ where: { id: dealer.id } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  };

  try {
    // ── 1. Customer POS order — return must NOT be tagged as Franchise ───
    console.log('--- 1. Customer-sourced POS return must resolve customerId, and franchiseId must stay null ---');
    const customerOrder = await prisma.order.create({
      data: {
        invoiceNum: `RET-TEST-CUST-${Date.now()}`,
        franchiseId: hq.id, // operating branch — must NOT leak into party identity
        customerId: customer.id,
        partyType: 'CUSTOMER',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subTotal: 100, taxAmount: 5, discountAmount: 0, totalAmount: 105,
      }
    });
    createdOrderIds.push(customerOrder.id);
    const returnC = await SalesService.createReturnOrder({
      posOrderId: customerOrder.id,
      reason: 'Test return - customer',
      items: [{ productName: 'Test Item', quantity: 1, rate: 100 }],
    } as any);
    createdReturnIds.push(returnC.id);
    if (returnC.customerId !== customer.id) throw new Error(`Expected customerId ${customer.id}, got ${returnC.customerId}`);
    if (returnC.dealerId) throw new Error(`Expected dealerId null, got ${returnC.dealerId}`);
    if (returnC.franchiseId) throw new Error(`Expected franchiseId null (operating branch must not leak into party identity), got ${returnC.franchiseId} — this is exactly the pre-fix bug`);
    console.log('   ✅ Customer return correctly resolves customerId; franchiseId stays null despite the order having an operating franchiseId\n');

    // ── 2. Dealer POS order — return must resolve dealerId, not vanish ───
    console.log('--- 2. Dealer-sourced POS return must resolve dealerId (previously silently dropped) ---');
    const dealerOrder = await prisma.order.create({
      data: {
        invoiceNum: `RET-TEST-DEALER-${Date.now()}`,
        franchiseId: hq.id,
        partyType: 'DEALER',
        partyId: dealer.id,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subTotal: 200, taxAmount: 10, discountAmount: 0, totalAmount: 210,
      }
    });
    createdOrderIds.push(dealerOrder.id);
    const returnD = await SalesService.createReturnOrder({
      posOrderId: dealerOrder.id,
      reason: 'Test return - dealer',
      items: [{ productName: 'Test Item', quantity: 1, rate: 200 }],
    } as any);
    createdReturnIds.push(returnD.id);
    if (returnD.dealerId !== dealer.id) throw new Error(`Expected dealerId ${dealer.id}, got ${returnD.dealerId}`);
    if (returnD.customerId) throw new Error(`Expected customerId null, got ${returnD.customerId}`);
    if (returnD.franchiseId) throw new Error(`Expected franchiseId null, got ${returnD.franchiseId}`);
    if (!returnD.dealer || returnD.dealer.name !== dealer.name) throw new Error('Expected dealer relation to be populated with the correct name');
    console.log(`   ✅ Dealer return correctly resolves dealerId=${returnD.dealerId} (dealer.name="${returnD.dealer.name}") — no longer silently dropped\n`);

    // ── 3. Franchise-party POS order — party id must be the FRANCHISE PARTY, not the operating branch ──
    console.log('--- 3. Franchise-party POS return must resolve the party franchise, not just the operating branch ---');
    const secondFranchise = await prisma.franchise.create({
      data: {
        name: `Returns Test Franchise Party ${Date.now()}`,
        isHQ: false,
        location: 'Test Location',
        ownerName: 'Test Owner',
        contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      }
    });
    const franchisePartyOrder = await prisma.order.create({
      data: {
        invoiceNum: `RET-TEST-FRAN-${Date.now()}`,
        franchiseId: hq.id, // still the operating branch (HQ processed it)
        partyType: 'FRANCHISE',
        partyId: secondFranchise.id, // the actual party being sold to
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subTotal: 300, taxAmount: 15, discountAmount: 0, totalAmount: 315,
      }
    });
    createdOrderIds.push(franchisePartyOrder.id);
    const returnF = await SalesService.createReturnOrder({
      posOrderId: franchisePartyOrder.id,
      reason: 'Test return - franchise party',
      items: [{ productName: 'Test Item', quantity: 1, rate: 300 }],
    } as any);
    createdReturnIds.push(returnF.id);
    if (returnF.franchiseId !== secondFranchise.id) throw new Error(`Expected franchiseId ${secondFranchise.id} (the party), got ${returnF.franchiseId}`);
    console.log(`   ✅ Franchise-party return correctly resolves the actual party franchise (${returnF.franchiseId}), not the operating HQ branch\n`);
    await step('secondFranchise', () => prisma.franchise.delete({ where: { id: secondFranchise.id } }));

    // ── 4. Direct dealerId (no linked order — walk-in-style direct return) ─
    console.log('--- 4. Direct dealerId (no linked order) is accepted and resolved ---');
    const returnDirectDealer = await SalesService.createReturnOrder({
      dealerId: dealer.id,
      reason: 'Test direct dealer return',
      items: [{ productName: 'Test Item', quantity: 1, rate: 50 }],
    } as any);
    createdReturnIds.push(returnDirectDealer.id);
    if (returnDirectDealer.dealerId !== dealer.id) throw new Error(`Expected dealerId ${dealer.id}, got ${returnDirectDealer.dealerId}`);
    console.log('   ✅ A direct dealerId (no posOrderId/salesOrderId) is correctly resolved\n');

    // ── 5. getReturnOrders includes the dealer relation and DEALER filter ─
    console.log('--- 5. getReturnOrders exposes dealer relation and supports source=DEALER filtering ---');
    const allReturns = await SalesService.getReturnOrders({});
    const foundDealerReturn = allReturns.find((r: any) => r.id === returnD.id);
    if (!foundDealerReturn || !foundDealerReturn.dealer) throw new Error('Expected getReturnOrders() to include the dealer relation');
    const dealerFiltered = await SalesService.getReturnOrders({ source: 'DEALER' });
    if (!dealerFiltered.some((r: any) => r.id === returnD.id)) throw new Error('Expected source=DEALER filter to include the dealer return');
    if (dealerFiltered.some((r: any) => r.id === returnC.id)) throw new Error('Expected source=DEALER filter to exclude the customer return');
    console.log('   ✅ getReturnOrders() includes dealer relation and source=DEALER filters correctly\n');

    console.log('====================================================');
    console.log('🎉 ALL RETURNS PARTY-CLASSIFICATION REGRESSION CHECKS PASSED');
    console.log('====================================================');
  } finally {
    await cleanup();
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
