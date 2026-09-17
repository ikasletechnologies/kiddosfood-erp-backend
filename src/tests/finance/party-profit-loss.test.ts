import prisma from '../../lib/prisma';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { FinanceService } from '../../modules/finance/finance.service';

// Regression coverage for the Party Wise Profit & Loss fix. Before this fix:
//   - Every order with no `customerId` (Dealer orders, Franchise-party orders,
//     genuine walk-ins) collapsed into one shared 'CASH_CUSTOMER' bucket,
//     labeled by whichever order the loop reached first — a real, unrelated
//     "ak"-named franchise order and a "Walk-in Customer" order were reported
//     as a single fabricated party.
//   - COGS fell back to `Product.basePrice` (a selling-price field) whenever
//     an item had no frozen `OrderItem.totalCost` and no recipe, silently
//     erasing real margin (cost ends up ~= price for every such item).
//   - Sales returns were never netted, so a fully-reversed sale kept
//     contributing "profit" forever.
//   - The API never returned `totalCost`/`margin`, and returned revenue under
//     `totalSaleAmount` while the frontend column config expected `totalSales`.
// See: finance.service.ts FinanceService.getPartyProfitLoss, resolveOrderItemCost.
async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING PARTY WISE P&L REGRESSION SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();
  const stamp = Date.now();

  const franchiseParty = await prisma.franchise.create({
    data: {
      name: `PL Test Franchise Party ${stamp}`, isHQ: false, location: 'Test Location',
      ownerName: 'Test Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
    }
  });

  const start = new Date('2020-02-10');
  const end = new Date('2020-02-20');
  const mid = new Date('2020-02-14');

  const cleanup = {
    orders: [] as string[], returns: [] as string[], returnItems: [] as string[],
    products: [] as string[], inventoryItems: [] as string[],
    customers: [] as string[], dealers: [] as string[],
  };
  const step = async (label: string, fn: () => Promise<any>) => {
    try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
  };
  const assertEqual = (actual: any, expected: any, label: string) => {
    if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const countOrdersAndReturns = () => Promise.all([prisma.order.count(), prisma.returnOrder.count()]);

  try {
    // ── Fixture product: real cost (InventoryItem.costPrice=20) deliberately
    // different from a much higher basePrice (100), to prove basePrice is
    // never used as COGS.
    const sku = `PL-TEST-SKU-${stamp}`;
    const product = await prisma.product.create({ data: { name: `PL Test Product ${stamp}`, sku, basePrice: 100 } });
    cleanup.products.push(product.id);
    const invItem = await prisma.inventoryItem.create({
      data: { name: `PL Test Inventory ${stamp}`, sku, category: 'FINISHED_GOOD', currentStock: 100, unit: 'PC', costPrice: 20 }
    });
    cleanup.inventoryItems.push(invItem.id);

    // Product with no recipe AND no matching InventoryItem row — cost must be
    // reported as UNAVAILABLE, never silently 0 or basePrice.
    const orphanSku = `PL-ORPHAN-SKU-${stamp}`;
    const orphanProduct = await prisma.product.create({ data: { name: `PL Orphan Product ${stamp}`, sku: orphanSku, basePrice: 50 } });
    cleanup.products.push(orphanProduct.id);

    // ── Customer A ──
    const customerA = await prisma.customer.create({ data: { name: `PL Test Customer A ${stamp}`, franchiseId: hq.id } });
    cleanup.customers.push(customerA.id);
    const custOrder = await prisma.order.create({
      data: {
        invoiceNum: `PL-CUST-A-${stamp}`, franchiseId: hq.id, customerId: customerA.id, partyType: 'CUSTOMER',
        status: 'COMPLETED', createdAt: mid, subTotal: 200, taxAmount: 10, totalAmount: 210,
        orderItems: { create: [{ productId: product.id, quantity: 4, price: 50, totalAmount: 200 }] }
      }
    });
    cleanup.orders.push(custOrder.id);

    // ── Dealer A (no customerId — old code would merge this into CASH_CUSTOMER) ──
    const dealerA = await prisma.dealer.create({ data: { name: `PL Test Dealer A ${stamp}`, franchiseId: hq.id, status: 'ACTIVE' } });
    cleanup.dealers.push(dealerA.id);
    const dealerOrder = await prisma.order.create({
      data: {
        invoiceNum: `PL-DEALER-A-${stamp}`, franchiseId: hq.id, partyType: 'DEALER', partyId: dealerA.id,
        status: 'COMPLETED', createdAt: mid, subTotal: 100, taxAmount: 5, totalAmount: 105,
        orderItems: { create: [{ productId: product.id, quantity: 2, price: 50, totalAmount: 100 }] }
      }
    });
    cleanup.orders.push(dealerOrder.id);

    // ── Franchise-as-party (no customerId — old code would ALSO merge this into the same CASH_CUSTOMER bucket as Dealer A and the walk-in below) ──
    const franchiseOrder = await prisma.order.create({
      data: {
        invoiceNum: `PL-FRANCHISE-${stamp}`, franchiseId: hq.id, partyType: 'FRANCHISE', partyId: franchiseParty.id,
        status: 'COMPLETED', createdAt: mid, subTotal: 60, taxAmount: 3, totalAmount: 63,
        orderItems: { create: [{ productId: product.id, quantity: 3, price: 20, totalAmount: 60 }] }
      }
    });
    cleanup.orders.push(franchiseOrder.id);

    // ── Genuine walk-in (no customerId, no partyId — the true "no identity" case) ──
    const walkInOrder = await prisma.order.create({
      data: {
        invoiceNum: `PL-WALKIN-${stamp}`, franchiseId: hq.id, partyType: 'CUSTOMER', customerName: 'Walk-in Customer',
        status: 'COMPLETED', createdAt: mid, subTotal: 40, taxAmount: 2, totalAmount: 42,
        orderItems: { create: [{ productId: product.id, quantity: 2, price: 20, totalAmount: 40 }] }
      }
    });
    cleanup.orders.push(walkInOrder.id);

    // ── Zero-sale order with real cost (like the real "web 1 G" case) — margin must be null, not Infinity/NaN, and the row must still appear (not be silently dropped) ──
    const zeroSaleCustomer = await prisma.customer.create({ data: { name: `PL Test Zero Sale Customer ${stamp}`, franchiseId: hq.id } });
    cleanup.customers.push(zeroSaleCustomer.id);
    const zeroSaleOrder = await prisma.order.create({
      data: {
        invoiceNum: `PL-ZEROSALE-${stamp}`, franchiseId: hq.id, customerId: zeroSaleCustomer.id, partyType: 'CUSTOMER',
        status: 'COMPLETED', createdAt: mid, subTotal: 0, taxAmount: 0, totalAmount: 0,
        orderItems: { create: [{ productId: product.id, quantity: 1, price: 0, totalAmount: 0 }] }
      }
    });
    cleanup.orders.push(zeroSaleOrder.id);

    // ── Orphan-cost order (no recipe, no InventoryItem match) — costUnavailable must be true, cost must NOT be product.basePrice(50) ──
    const orphanCustomer = await prisma.customer.create({ data: { name: `PL Test Orphan Cost Customer ${stamp}`, franchiseId: hq.id } });
    cleanup.customers.push(orphanCustomer.id);
    const orphanOrder = await prisma.order.create({
      data: {
        invoiceNum: `PL-ORPHAN-${stamp}`, franchiseId: hq.id, customerId: orphanCustomer.id, partyType: 'CUSTOMER',
        status: 'COMPLETED', createdAt: mid, subTotal: 80, taxAmount: 4, totalAmount: 84,
        orderItems: { create: [{ productId: orphanProduct.id, quantity: 1, price: 80, totalAmount: 80 }] }
      }
    });
    cleanup.orders.push(orphanOrder.id);

    const [ordersBefore, returnsBefore] = await countOrdersAndReturns();

    // ── 1-6: grouping correctness ──
    console.log('--- 1-6. Customer / Dealer / Franchise / Walk-in never merge, even though several share customerId: null ---');
    const results: any[] = await FinanceService.getPartyProfitLoss({ startDate: start, endDate: end });
    const byName = (n: string) => results.find(r => r.partyName === n);

    const custRow = byName(`PL Test Customer A ${stamp}`);
    if (!custRow) throw new Error('Customer A row missing');
    assertEqual(custRow.partyType, 'CUSTOMER', 'custRow.partyType');
    assertEqual(custRow.totalSales, 200, 'custRow.totalSales'); // 210 - 10 tax
    assertEqual(custRow.totalCost, 80, 'custRow.totalCost'); // 4 * costPrice(20), NOT 4*basePrice(100)=400
    assertEqual(custRow.profit, 120, 'custRow.profit');

    const dealerRow = byName(`PL Test Dealer A ${stamp}`);
    if (!dealerRow) throw new Error('Dealer A row missing');
    assertEqual(dealerRow.partyType, 'DEALER', 'dealerRow.partyType');
    assertEqual(dealerRow.totalSales, 100, 'dealerRow.totalSales');
    assertEqual(dealerRow.totalCost, 40, 'dealerRow.totalCost'); // 2*20

    const franchiseRow = byName(`PL Test Franchise Party ${stamp}`);
    if (!franchiseRow) throw new Error('Franchise-party row missing');
    assertEqual(franchiseRow.partyType, 'FRANCHISE', 'franchiseRow.partyType');
    assertEqual(franchiseRow.totalSales, 60, 'franchiseRow.totalSales');
    assertEqual(franchiseRow.totalCost, 60, 'franchiseRow.totalCost'); // 3*20

    const walkInRow = byName('Walk-in / Unattributed');
    if (!walkInRow) throw new Error('Walk-in row missing');
    assertEqual(walkInRow.partyType, 'WALK_IN', 'walkInRow.partyType');
    assertEqual(walkInRow.totalSales, 40, 'walkInRow.totalSales');
    assertEqual(walkInRow.totalCost, 40, 'walkInRow.totalCost'); // 2*20

    // The critical assertion: 4 separate rows, not one merged CASH_CUSTOMER row.
    const distinctParties = new Set([custRow, dealerRow, franchiseRow, walkInRow].map(r => `${r.partyType}:${r.partyId}`));
    assertEqual(distinctParties.size, 4, 'four genuinely distinct party rows');
    console.log('   ✅ Customer, Dealer, Franchise-party and Walk-in all resolved as four separate rows\n');

    // ── 7. Zero-sale order: margin null, row still present, no Infinity/NaN ──
    console.log('--- 7. Zero-sale order: margin is null (not Infinity/NaN), row is not silently dropped ---');
    const zeroRow = byName(`PL Test Zero Sale Customer ${stamp}`);
    if (!zeroRow) throw new Error('Zero-sale row missing — must not be dropped just because sales is 0 while cost is nonzero');
    assertEqual(zeroRow.totalSales, 0, 'zeroRow.totalSales');
    assertEqual(zeroRow.totalCost, 20, 'zeroRow.totalCost'); // 1*20
    assertEqual(zeroRow.margin, null, 'zeroRow.margin (must be null, not Infinity/NaN)');
    if (!Number.isFinite(zeroRow.profit)) throw new Error('profit must be a finite number');
    console.log(`   ✅ margin=${zeroRow.margin}, profit=${zeroRow.profit}\n`);

    // ── 8. Orphan cost: costUnavailable true, cost is 0 not basePrice(50) ──
    console.log('--- 8. Item with no recipe and no matching InventoryItem: cost is UNAVAILABLE, never falls back to basePrice ---');
    const orphanRow = byName(`PL Test Orphan Cost Customer ${stamp}`);
    if (!orphanRow) throw new Error('Orphan-cost row missing');
    assertEqual(orphanRow.totalCost, 0, 'orphanRow.totalCost (no cost data — must not silently use basePrice(50))');
    assertEqual(orphanRow.costUnavailable, true, 'orphanRow.costUnavailable');
    console.log('   ✅ costUnavailable=true, cost reported as 0 rather than a fabricated basePrice-derived number\n');

    // ── 9. Sales return nets revenue and COGS for the correct party only ──
    console.log('--- 9. Approved sales return reduces revenue and reverses COGS for the originating party ---');
    const ret = await prisma.returnOrder.create({
      data: {
        returnNumber: `PL-RET-${stamp}`, posOrderId: custOrder.id, reason: 'test return',
        status: 'COMPLETED', refundAmount: 52.5, createdAt: mid,
        items: { create: [{ productId: product.id, productName: product.name, quantity: 1, rate: 50, taxableValue: 50, costReversal: 20, totalAmount: 52.5 }] }
      }
    });
    cleanup.returns.push(ret.id);
    const afterReturn: any[] = await FinanceService.getPartyProfitLoss({ startDate: start, endDate: end });
    const custRowAfterReturn = afterReturn.find(r => r.partyName === `PL Test Customer A ${stamp}`);
    if (!custRowAfterReturn) throw new Error('Customer A row missing after return');
    assertEqual(custRowAfterReturn.totalSales, 150, 'custRowAfterReturn.totalSales (200 - 50 returned)');
    assertEqual(custRowAfterReturn.totalCost, 60, 'custRowAfterReturn.totalCost (80 - 20 reversed)');
    assertEqual(custRowAfterReturn.profit, 90, 'custRowAfterReturn.profit');
    // Dealer/Franchise/Walk-in rows must be completely unaffected by a return on Customer A's sale.
    const dealerRowAfterReturn = afterReturn.find(r => r.partyName === `PL Test Dealer A ${stamp}`);
    assertEqual(dealerRowAfterReturn.totalSales, 100, 'dealerRow unaffected by unrelated return');
    console.log(`   ✅ Customer A net sales=${custRowAfterReturn.totalSales}, net cost=${custRowAfterReturn.totalCost}, profit=${custRowAfterReturn.profit}; other parties unaffected\n`);

    // ── 10. Search ──
    console.log('--- 10. Search filters by party name ---');
    const searched: any[] = await FinanceService.getPartyProfitLoss({ startDate: start, endDate: end, search: 'Dealer A' });
    if (!searched.every(r => r.partyName.includes('Dealer A'))) throw new Error('Search did not filter correctly');
    if (searched.length === 0) throw new Error('Search should have matched Dealer A');
    console.log(`   ✅ search="Dealer A" -> ${searched.length} row(s), all matching\n`);

    // ── 11. Read-only guarantee ──
    console.log('--- 11. Party Wise P&L never writes Order/ReturnOrder rows ---');
    const [ordersAfter, returnsAfter] = await countOrdersAndReturns();
    assertEqual(ordersAfter, ordersBefore, 'Order count unchanged by read calls above (fixture creation already accounted for)');
    assertEqual(returnsAfter, returnsBefore + 1, 'ReturnOrder count reflects only the one fixture return created in step 9, not any created by the service itself');
    console.log('   ✅ no extra rows created by any getPartyProfitLoss call\n');

    console.log('====================================================');
    console.log('🎉 ALL PARTY WISE P&L REGRESSION CHECKS PASSED');
    console.log('====================================================');
  } finally {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    await step('returnItems', () => prisma.returnItem.deleteMany({ where: { returnId: { in: cleanup.returns } } }));
    await step('returns', () => prisma.returnOrder.deleteMany({ where: { id: { in: cleanup.returns } } }));
    await step('orderItems', () => prisma.orderItem.deleteMany({ where: { orderId: { in: cleanup.orders } } }));
    await step('orders', () => prisma.order.deleteMany({ where: { id: { in: cleanup.orders } } }));
    await step('inventoryItems', () => prisma.inventoryItem.deleteMany({ where: { id: { in: cleanup.inventoryItems } } }));
    await step('products', () => prisma.product.deleteMany({ where: { id: { in: cleanup.products } } }));
    await step('dealers', () => prisma.dealer.deleteMany({ where: { id: { in: cleanup.dealers } } }));
    await step('customers', () => prisma.customer.deleteMany({ where: { id: { in: cleanup.customers } } }));
    await step('franchiseParty', () => prisma.franchise.delete({ where: { id: franchiseParty.id } }));
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
