// Regression test for the POS checkout inventory-deduction bug fixed in
// pos.service.ts: the "no recipe" fallback used to compare InventoryItem
// franchiseId directly against the Order's real Franchise id, which never
// matches an HQ-scoped (franchiseId=NULL) item — so the sale, payment, and
// account balance all silently completed while inventory_deducted got set
// true with zero stock actually deducted. Now that lookup goes through
// FranchiseService.toInventoryScopeId, and a missing InventoryItem throws
// (rolling back the whole $transaction) instead of silently no-op'ing.
//
// Uses disposable TEST-POS-DEDUCT* fixtures rather than a real catalog item
// — every deleteMany below is scoped to those exact ids, never a blanket
// wipe (see the FK-unsafe `deleteMany({})` pattern in some of the older
// test-*.ts scripts in this folder — deliberately not repeated here).
import { POSService } from '../modules/pos/pos.service';
import { FranchiseService } from '../modules/franchise/franchise.service';
import prisma from '../lib/prisma';

async function runTests() {
  console.log('=== POS Inventory Deduction Regression Test ===');

  const hq = await FranchiseService.getHqFranchise();
  console.log(`Using HQ franchise: ${hq.name} (${hq.id})`);

  let productWithStock: any;
  let itemWithStock: any;
  let productMissingItem: any;
  let successOrderId: string | undefined;

  try {
    // --- Fixtures ---
    productWithStock = await prisma.product.create({
      data: {
        name: 'TEST POS DEDUCT ITEM',
        sku: 'TEST-POS-DEDUCT',
        productType: 'FINISHED_GOOD',
        basePrice: 100,
        taxPercent: 5,
        isActive: true,
        is_menu_item: true,
      },
    });
    itemWithStock = await prisma.inventoryItem.create({
      data: {
        name: 'TEST POS DEDUCT ITEM',
        sku: 'TEST-POS-DEDUCT',
        category: 'FINISHED_GOOD',
        unit: 'PC',
        currentStock: 25,
        minimumStock: 5,
        franchiseId: null, // HQ-scoped, exactly the scenario that broke
        basePrice: 100,
      },
    });
    productMissingItem = await prisma.product.create({
      data: {
        name: 'TEST POS NO INVENTORY ITEM',
        sku: 'TEST-POS-NOITEM',
        productType: 'FINISHED_GOOD',
        basePrice: 50,
        taxPercent: 5,
        isActive: true,
        is_menu_item: true,
      },
    });
    // Deliberately no matching InventoryItem for productMissingItem.

    // --- Test 1: successful sale deducts stock, not just marks the flag ---
    console.log('\nTest 1: sale of an existing HQ-scoped item deducts real stock');
    const orderCountBefore = await prisma.order.count();

    const order = await POSService.checkout({
      franchiseId: hq.id,
      items: [{ productId: productWithStock.id, quantity: 1, price: 100 }],
      subTotal: 100,
      taxAmount: 5,
      discountAmount: 0,
      totalAmount: 105,
      paymentMode: 'CASH',
    });
    successOrderId = order.id;

    const itemAfter = await prisma.inventoryItem.findUnique({ where: { id: itemWithStock.id } });
    const movements = await prisma.stockMovement.findMany({ where: { itemId: itemWithStock.id } });

    console.log(`  Expected stock 24, actual: ${itemAfter?.currentStock}`);
    if (itemAfter?.currentStock !== 24) throw new Error('Test 1 FAILED: stock did not decrement to 24');

    console.log(`  Expected 1 StockMovement of -1, actual count: ${movements.length}, quantity: ${movements[0]?.quantity}`);
    if (movements.length !== 1 || movements[0].quantity !== -1) throw new Error('Test 1 FAILED: StockMovement missing or wrong quantity');

    console.log(`  order.inventory_deducted: ${order.inventory_deducted}`);
    if (!order.inventory_deducted) throw new Error('Test 1 FAILED: inventory_deducted should be true when deduction actually happened');

    const orderCountAfter = await prisma.order.count();
    console.log(`  Order count before/after: ${orderCountBefore} -> ${orderCountAfter} (expect +1)`);
    if (orderCountAfter !== orderCountBefore + 1) throw new Error('Test 1 FAILED: unexpected order count delta');

    console.log('Test 1 PASSED');

    // --- Test 2: missing InventoryItem must reject the whole sale, atomically ---
    console.log('\nTest 2: sale of a product with no matching InventoryItem is rejected, nothing committed');
    const orderCountBefore2 = await prisma.order.count();
    const paymentCountBefore2 = await prisma.payment.count();

    let threw = false;
    let errorMessage = '';
    try {
      await POSService.checkout({
        franchiseId: hq.id,
        items: [{ productId: productMissingItem.id, quantity: 1, price: 50 }],
        subTotal: 50,
        taxAmount: 2.5,
        discountAmount: 0,
        totalAmount: 52.5,
        paymentMode: 'CASH',
      });
    } catch (e: any) {
      threw = true;
      errorMessage = e.message;
    }

    console.log(`  Threw an error? ${threw} (${errorMessage})`);
    if (!threw) throw new Error('Test 2 FAILED: checkout should have thrown, not completed the sale');
    if (!/not found/i.test(errorMessage)) throw new Error(`Test 2 FAILED: unexpected error message: ${errorMessage}`);

    const orderCountAfter2 = await prisma.order.count();
    const paymentCountAfter2 = await prisma.payment.count();
    console.log(`  Order count before/after: ${orderCountBefore2} -> ${orderCountAfter2} (expect unchanged)`);
    console.log(`  Payment count before/after: ${paymentCountBefore2} -> ${paymentCountAfter2} (expect unchanged)`);
    if (orderCountAfter2 !== orderCountBefore2) throw new Error('Test 2 FAILED: an Order was committed despite the missing InventoryItem');
    if (paymentCountAfter2 !== paymentCountBefore2) throw new Error('Test 2 FAILED: a Payment was committed despite the missing InventoryItem');

    console.log('Test 2 PASSED');

    console.log('\n=== All Tests Passed ===');
  } finally {
    console.log('\nCleaning up test fixtures (scoped deletes only)...');
    if (successOrderId) {
      // createPayment() incremented a real Account's balance — reverse that
      // exact amount before removing the rows, so this test never leaves a
      // phantom balance behind on a real HQ account.
      const testPayment = await prisma.payment.findFirst({ where: { orderId: successOrderId } });
      if (testPayment?.accountId) {
        await prisma.account.update({
          where: { id: testPayment.accountId },
          data: { balance: { decrement: testPayment.paidAmount } },
        });
        console.log(`  Reversed ₹${testPayment.paidAmount} on account ${testPayment.accountId}`);
      }
      await prisma.payment.deleteMany({ where: { orderId: successOrderId } });
      await prisma.orderItem.deleteMany({ where: { orderId: successOrderId } });
      await prisma.invoice.deleteMany({ where: { orderId: successOrderId } });
      await prisma.order.deleteMany({ where: { id: successOrderId } });
    }
    if (itemWithStock) {
      await prisma.stockMovement.deleteMany({ where: { itemId: itemWithStock.id } });
      await prisma.inventoryItem.deleteMany({ where: { id: itemWithStock.id } });
    }
    if (productWithStock) await prisma.product.deleteMany({ where: { id: productWithStock.id } });
    if (productMissingItem) await prisma.product.deleteMany({ where: { id: productMissingItem.id } });
    await prisma.$disconnect();
  }
}

runTests().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
