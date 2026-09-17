import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

function approx(actual: number, expected: number, label: string) {
  const diff = Math.abs(actual - expected);
  if (diff > 0.01) {
    throw new Error(`❌ FAIL [${label}]: expected ${expected}, got ${actual}`);
  }
  console.log(`   ✅ PASS [${label}]: ${actual}`);
}

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING ITEM WISE DISCOUNT REPORT REGRESSION SUITE');
  console.log('====================================================\n');

  const timestamp = Date.now();
  const testFranchiseA = await prisma.franchise.create({
    data: {
      name: `Test Franchise A ${timestamp}`,
      location: 'Test Location A',
      ownerName: 'Owner A',
      contactNum: `999${timestamp.toString().slice(-7)}`
    }
  });

  const testFranchiseB = await prisma.franchise.create({
    data: {
      name: `Test Franchise B ${timestamp}`,
      location: 'Test Location B',
      ownerName: 'Owner B',
      contactNum: `888${timestamp.toString().slice(-7)}`
    }
  });

  // Product 1 for Franchise A
  const product1 = await prisma.product.create({
    data: {
      name: `Special Appam Mix ${timestamp}`,
      sku: `SKU-APPAM-${timestamp}`,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 100,
      taxPercent: 5,
      isActive: true
    }
  });

  // Product 2 with IDENTICAL name to Product 1, but different ID
  const product2SameName = await prisma.product.create({
    data: {
      name: `Special Appam Mix ${timestamp}`,
      sku: `SKU-APPAM-ALT-${timestamp}`,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 100,
      taxPercent: 5,
      isActive: true
    }
  });

  // Product 3 for zero discount test
  const productNoDisc = await prisma.product.create({
    data: {
      name: `Zero Disc Item ${timestamp}`,
      sku: `SKU-ZERO-${timestamp}`,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 50,
      taxPercent: 5,
      isActive: true
    }
  });

  const testDateStr = '2026-09-15';
  const testDateObj = new Date('2026-09-15T12:00:00.000Z');

  try {
    // -------------------------------------------------------------
    // TEST 1: Order.discountAmount = 0, OrderItem.discountPct = 25
    // (Core reported bug)
    // -------------------------------------------------------------
    console.log('--- TEST 1: Line item discount (discountPct=25, order.discountAmount=0) ---');
    const order1 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T1-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 75,
        taxAmount: 3.75,
        discountAmount: 0, // Header discount is 0
        totalAmount: 78.75,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: product1.id,
            quantity: 1,
            price: 100,
            discountPct: 25, // 25% discount = ₹25
            taxAmount: 3.75,
            totalAmount: 78.75
          }]
        }
      }
    });

    const res1 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const item1Report = res1.data.find(r => r.itemId === product1.id);
    if (!item1Report) throw new Error(`TEST 1 FAIL: Product 1 with discountPct=25 was excluded!`);
    approx(item1Report.discountAmount, 25, 'Test 1 Item Discount Amount');
    approx(item1Report.discountPct, 25, 'Test 1 Item Discount Pct');
    approx(item1Report.totalSales, 100, 'Test 1 Item Total Sales');
    approx(item1Report.netAmount, 75, 'Test 1 Item Net Amount');
    console.log('   ✅ TEST 1 PASSED: Order with Order.discountAmount=0 & OrderItem.discountPct=25 correctly reported.\n');

    // -------------------------------------------------------------
    // TEST 2: OrderItem.discountPct = 0, Order.discountAmount = 0
    // (Item without discount must be excluded from detail table)
    // -------------------------------------------------------------
    console.log('--- TEST 2: Zero discount item (discountPct=0, order.discountAmount=0) ---');
    const order2 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T2-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 50,
        taxAmount: 2.5,
        discountAmount: 0,
        totalAmount: 52.5,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: productNoDisc.id,
            quantity: 1,
            price: 50,
            discountPct: 0,
            taxAmount: 2.5,
            totalAmount: 52.5
          }]
        }
      }
    });

    const res2 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const zeroItemReport = res2.data.find(r => r.itemId === productNoDisc.id);
    if (zeroItemReport) throw new Error(`TEST 2 FAIL: Zero discount item was included in table!`);
    console.log('   ✅ TEST 2 PASSED: Zero discount item is correctly excluded from table.\n');

    // -------------------------------------------------------------
    // TEST 3: Two items with SAME display name but DIFFERENT productId
    // (Must remain separate by productId identity)
    // -------------------------------------------------------------
    console.log('--- TEST 3: Two items with identical display name, distinct productId ---');
    const order3 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T3-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 80,
        taxAmount: 4,
        discountAmount: 0,
        totalAmount: 84,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: product2SameName.id,
            quantity: 1,
            price: 100,
            discountPct: 20, // ₹20 discount
            taxAmount: 4,
            totalAmount: 84
          }]
        }
      }
    });

    const res3 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const rowProd1 = res3.data.find(r => r.itemId === product1.id);
    const rowProd2 = res3.data.find(r => r.itemId === product2SameName.id);
    if (!rowProd1 || !rowProd2) throw new Error(`TEST 3 FAIL: Distinct product IDs were collapsed!`);
    approx(rowProd1.discountAmount, 25, 'Test 3 Product 1 Discount');
    approx(rowProd2.discountAmount, 20, 'Test 3 Product 2 Discount');
    console.log('   ✅ TEST 3 PASSED: Products with identical names kept separate by productId.\n');

    // -------------------------------------------------------------
    // TEST 4: Multiple discounts for same item (Weighted avg test)
    // Sale 1: ₹100 gross, 25% = ₹25 disc
    // Sale 4: ₹200 gross, 10% = ₹20 disc
    // Total Sales = ₹300, Total Disc = ₹45
    // Weighted % = 45 / 300 * 100 = 15.00%
    // -------------------------------------------------------------
    console.log('--- TEST 4: Weighted average discount percentage calculation ---');
    const order4 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T4-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 180,
        taxAmount: 9,
        discountAmount: 0,
        totalAmount: 189,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: product1.id,
            quantity: 2,
            price: 100,
            discountPct: 10, // 10% on ₹200 = ₹20
            taxAmount: 9,
            totalAmount: 189
          }]
        }
      }
    });

    const res4 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const prod1Combined = res4.data.find(r => r.itemId === product1.id);
    if (!prod1Combined) throw new Error(`TEST 4 FAIL: Product 1 combined record missing!`);
    approx(prod1Combined.totalSales, 300, 'Test 4 Total Sales');
    approx(prod1Combined.discountAmount, 45, 'Test 4 Total Discount Amount');
    approx(prod1Combined.discountPct, 15, 'Test 4 Weighted Discount %');
    approx(prod1Combined.netAmount, 255, 'Test 4 Net Amount');
    console.log('   ✅ TEST 4 PASSED: Weighted average discount percentage calculated correctly.\n');

    // -------------------------------------------------------------
    // TEST 5: Order-level manual discount (Order.discountAmount > 0)
    // Order: ₹100 gross, item.discountPct=0, order.discountAmount=30
    // Pro-rata allocation gives ₹30 discount to the item line.
    // -------------------------------------------------------------
    console.log('--- TEST 5: Order-level manual discount allocation ---');
    const order5 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T5-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 70,
        taxAmount: 3.5,
        discountAmount: 30, // Header manual discount = ₹30
        totalAmount: 73.5,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: productNoDisc.id,
            quantity: 2,
            price: 50,
            discountPct: 0, // Line disc = 0
            taxAmount: 3.5,
            totalAmount: 73.5
          }]
        }
      }
    });

    const res5 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const prodNoDiscRow = res5.data.find(r => r.itemId === productNoDisc.id);
    if (!prodNoDiscRow) throw new Error(`TEST 5 FAIL: Order-level discount not allocated to line!`);
    approx(prodNoDiscRow.discountAmount, 30, 'Test 5 Allocated Order Discount');
    console.log('   ✅ TEST 5 PASSED: Order-level discount correctly allocated pro-rata.\n');

    // -------------------------------------------------------------
    // TEST 6: TAX_INVOICE finalized sale inclusion (finalSaleWhere)
    // -------------------------------------------------------------
    console.log('--- TEST 6: TAX_INVOICE finalized sale inclusion ---');
    const order6 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T6-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'TAX_INVOICE',
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        subTotal: 80,
        taxAmount: 4,
        discountAmount: 0,
        totalAmount: 84,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: product1.id,
            quantity: 1,
            price: 100,
            discountPct: 20,
            taxAmount: 4,
            totalAmount: 84
          }]
        }
      }
    });

    const res6 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const prod1WithTaxInv = res6.data.find(r => r.itemId === product1.id);
    if (!prod1WithTaxInv) throw new Error(`TEST 6 FAIL: TAX_INVOICE sale excluded!`);
    approx(prod1WithTaxInv.discountAmount, 65, 'Test 6 Total Discount including TAX_INVOICE');
    console.log('   ✅ TEST 6 PASSED: TAX_INVOICE sale included via finalSaleWhere.\n');

    // -------------------------------------------------------------
    // TEST 7: DINE_IN / POS COMPLETED sale inclusion
    // -------------------------------------------------------------
    console.log('--- TEST 7: POS / DINE_IN COMPLETED sale inclusion ---');
    approx(res6.totalDiscount, 115, 'Test 7 Combined Total Discount across Franchise A');
    console.log('   ✅ TEST 7 PASSED: POS / DINE_IN sales properly included.\n');

    // -------------------------------------------------------------
    // TEST 8: End-date boundary (23:59:00 inclusion)
    // -------------------------------------------------------------
    console.log('--- TEST 8: End-date boundary inclusion (23:59:00) ---');
    const lateBoundaryObj = new Date('2026-09-15T23:59:00.000Z');
    const order8 = await prisma.order.create({
      data: {
        invoiceNum: `INV-T8-${timestamp}`,
        franchiseId: testFranchiseA.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 90,
        taxAmount: 4.5,
        discountAmount: 0,
        totalAmount: 94.5,
        createdAt: lateBoundaryObj,
        orderItems: {
          create: [{
            productId: product1.id,
            quantity: 1,
            price: 100,
            discountPct: 10, // ₹10 discount
            taxAmount: 4.5,
            totalAmount: 94.5
          }]
        }
      }
    });

    const res8 = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const prod1Late = res8.data.find(r => r.itemId === product1.id);
    if (!prod1Late) throw new Error(`TEST 8 FAIL: Late boundary order excluded!`);
    approx(prod1Late.discountAmount, 75, 'Test 8 Discount including late boundary');
    console.log('   ✅ TEST 8 PASSED: End-date boundary at 23:59:00 properly included.\n');

    // -------------------------------------------------------------
    // TEST 9: Franchise Isolation (Franchise A vs Franchise B vs SUPER_ADMIN)
    // -------------------------------------------------------------
    console.log('--- TEST 9: Franchise data isolation ---');
    const order9FranchiseB = await prisma.order.create({
      data: {
        invoiceNum: `INV-T9-${timestamp}`,
        franchiseId: testFranchiseB.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 50,
        taxAmount: 2.5,
        discountAmount: 0,
        totalAmount: 52.5,
        createdAt: testDateObj,
        orderItems: {
          create: [{
            productId: product1.id,
            quantity: 1,
            price: 100,
            discountPct: 50, // ₹50 discount on Franchise B
            taxAmount: 2.5,
            totalAmount: 52.5
          }]
        }
      }
    });

    const resFranchiseB = await FinanceService.getItemDiscountReportData(testFranchiseB.id, testDateStr, testDateStr);
    const prod1FranchiseB = resFranchiseB.data.find(r => r.itemId === product1.id);
    if (!prod1FranchiseB) throw new Error(`TEST 9 FAIL: Franchise B data missing!`);
    approx(prod1FranchiseB.discountAmount, 50, 'Test 9 Franchise B Discount');

    // Verify Franchise A report does NOT include Franchise B's ₹50 discount
    const resFranchiseA = await FinanceService.getItemDiscountReportData(testFranchiseA.id, testDateStr, testDateStr);
    const prod1FranchiseA = resFranchiseA.data.find(r => r.itemId === product1.id);
    approx(prod1FranchiseA?.discountAmount || 0, 75, 'Test 9 Franchise A Discount (uncontaminated)');

    console.log('   ✅ TEST 9 PASSED: Franchise data isolation verified.\n');

    // -------------------------------------------------------------
    // TEST 10: API Contract Schema
    // -------------------------------------------------------------
    console.log('--- TEST 10: API Response Keys Contract ---');
    const sampleRow = resFranchiseB.data[0];
    const requiredKeys = ['itemId', 'itemName', 'totalSales', 'discountAmount', 'discountPct', 'netAmount', 'totalQtySold'];
    for (const key of requiredKeys) {
      if (!(key in sampleRow)) {
        throw new Error(`TEST 10 FAIL: Missing API contract key "${key}"`);
      }
    }
    console.log('   ✅ TEST 10 PASSED: Response schema contains all expected contract keys.\n');

    // -------------------------------------------------------------
    // TEST 11: Frontend transformer logic check
    // -------------------------------------------------------------
    console.log('--- TEST 11: Frontend transformer contract validation ---');
    const totalSalesNum = sampleRow.totalSales;
    const discAmtNum = sampleRow.discountAmount;
    const netAmtNum = sampleRow.netAmount;
    approx(netAmtNum, totalSalesNum - discAmtNum, 'Test 11 Net Amount Identity');
    console.log('   ✅ TEST 11 PASSED: Frontend transformer identity holds.\n');

    console.log('====================================================');
    console.log('🎉 ALL 11 REGRESSION TESTS PASSED SUCCESSFULLY!');
    console.log('====================================================');

  } finally {
    // Cleanup temporary test records
    await prisma.orderItem.deleteMany({
      where: {
        order: {
          franchiseId: { in: [testFranchiseA.id, testFranchiseB.id] }
        }
      }
    });
    await prisma.order.deleteMany({
      where: {
        franchiseId: { in: [testFranchiseA.id, testFranchiseB.id] }
      }
    });
    await prisma.product.deleteMany({
      where: {
        id: { in: [product1.id, product2SameName.id, productNoDisc.id] }
      }
    });
    await prisma.franchise.deleteMany({
      where: {
        id: { in: [testFranchiseA.id, testFranchiseB.id] }
      }
    });
  }
}

main()
  .catch((err) => {
    console.error('❌ REGRESSION TEST FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
