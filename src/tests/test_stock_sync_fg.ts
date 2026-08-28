import prisma from '../lib/prisma';
import { FranchiseService } from '../modules/franchise/franchise.service';
import { FranchiseOrderService } from '../modules/franchise/franchise-order.service';
import { ProductService } from '../modules/product/product.service';
import { FranchiseOrderStatus, FranchiseOrderType, ItemCategory, ProductType } from '@prisma/client';

async function runTests() {
  console.log('🚀 Starting Stock Availability & Order Validation Tests...\n');

  // 1. Ensure HQ franchise exists
  let hq = await FranchiseService.getHqFranchiseOrNull();
  if (!hq) {
    hq = await prisma.franchise.create({
      data: {
        id: 'test-hq-franchise',
        name: 'Headquarters (HQ)',
        location: 'Central Plaza',
        ownerName: 'HQ Admin',
        contactNum: '9998887770',
        isHQ: true,
      }
    });
  }

  // Ensure a Branch franchise exists
  let branch = await prisma.franchise.findFirst({ where: { isHQ: false } });
  if (!branch) {
    branch = await prisma.franchise.create({
      data: {
        id: 'test-branch-franchise',
        name: 'Anna Nagar Branch',
        location: 'Chennai',
        ownerName: 'Branch Manager',
        contactNum: '9998887771',
        isHQ: false,
      }
    });
  }

  const productName = 'ALL IN ONE BLEND (40 INGREDIENTS)';
  const productSku = 'FG-ALLI-500G';

  // 2. Clean up test product & inventory items
  await prisma.franchiseOrderItem.deleteMany({ where: { OR: [{ product: { sku: productSku } }, { product: { name: productName } }] } });
  await prisma.stockMovement.deleteMany({ where: { item: { OR: [{ sku: { startsWith: productSku } }, { name: productName }] } } });
  await prisma.productBatch.deleteMany({ where: { product: { sku: productSku } } });
  await prisma.inventoryItem.deleteMany({ where: { OR: [{ sku: { startsWith: productSku } }, { name: productName }] } });
  await prisma.product.deleteMany({ where: { OR: [{ sku: productSku }, { name: productName }] } });

  // 3. Create canonical Product
  const product = await prisma.product.create({
    data: {
      name: productName,
      sku: productSku,
      basePrice: 250,
      category: 'Health Mix',
      productType: ProductType.FINISHED_GOOD,
      isActive: true,
    }
  });

  // 4. Create HQ InventoryItem with 99 units (canonical franchiseId: null)
  const hqInvItem = await prisma.inventoryItem.create({
    data: {
      name: productName,
      sku: productSku,
      category: ItemCategory.FINISHED_GOOD,
      currentStock: 99,
      unit: 'PC',
      franchiseId: null, // HQ convention
      basePrice: 250,
      isActive: true,
    }
  });

  console.log('✅ Setup complete:');
  console.log(`   Product: ${product.name} (SKU: ${product.sku}, ID: ${product.id})`);
  console.log(`   HQ InventoryItem: ${hqInvItem.name} (Stock: ${hqInvItem.currentStock}, franchiseId: ${hqInvItem.franchiseId})\n`);

  // =========================================================================
  // TEST 1: Product API Stock Display
  // =========================================================================
  console.log('--- TEST 1: Product Catalog Stock Resolution ---');
  const productsForHq = await ProductService.getAll({ id: product.id }, hq.id);
  console.log(`   ProductService.getAll for HQ: found ${productsForHq.length} product(s)`);
  if (productsForHq.length === 0 || productsForHq[0].currentStock !== 99) {
    throw new Error(`FAIL Test 1: Expected stock 99 for HQ, got: ${productsForHq[0]?.currentStock}`);
  }
  console.log(`   [PASS] Displayed Stock = ${productsForHq[0].currentStock} PC\n`);

  // =========================================================================
  // TEST 2: Order Creation for quantity = 15 (Stock = 99, Requested = 15)
  // =========================================================================
  console.log('--- TEST 2: Case 1: HQ available = 99, Request = 15 (Expected: SUCCESS) ---');
  const order1 = await FranchiseOrderService.createOrder({
    franchiseId: branch.id,
    orderType: FranchiseOrderType.STOCK,
    items: [{ productId: product.id, quantity: 15 }]
  });
  console.log(`   [PASS] Order created successfully: ${order1.orderNumber}, Items: ${order1.items.length}, Total: ₹${order1.totalAmount}\n`);

  // =========================================================================
  // TEST 3: Order Creation for quantity = 99 (Stock = 99, Requested = 99)
  // =========================================================================
  console.log('--- TEST 3: Case 2: HQ available = 99, Request = 99 (Expected: SUCCESS) ---');
  const order2 = await FranchiseOrderService.createOrder({
    franchiseId: branch.id,
    orderType: FranchiseOrderType.STOCK,
    items: [{ productId: product.id, quantity: 99 }]
  });
  console.log(`   [PASS] Exact stock order created successfully: ${order2.orderNumber}\n`);

  // =========================================================================
  // TEST 4: Order Creation for quantity = 100 (Stock = 99, Requested = 100)
  // =========================================================================
  console.log('--- TEST 4: Case 3: HQ available = 99, Request = 100 (Expected: REJECT with message) ---');
  let rejected100 = false;
  try {
    await FranchiseOrderService.createOrder({
      franchiseId: branch.id,
      orderType: FranchiseOrderType.STOCK,
      items: [{ productId: product.id, quantity: 100 }]
    });
  } catch (err: any) {
    rejected100 = true;
    console.log(`   Caught expected rejection: "${err.message}"`);
    if (!err.message.includes('Only 99 units available in HQ warehouse')) {
      throw new Error(`FAIL Test 4: Error message does not report 99 available units: "${err.message}"`);
    }
  }
  if (!rejected100) {
    throw new Error('FAIL Test 4: Expected order with quantity 100 to be rejected, but it succeeded!');
  }
  console.log('   [PASS] Correctly rejected with accurate available quantity (99)\n');

  // =========================================================================
  // TEST 5: Order Creation when HQ stock is 0 (Stock = 0, Requested = 15)
  // =========================================================================
  console.log('--- TEST 5: Case 4: HQ available = 0, Request = 15 (Expected: REJECT with message) ---');
  await prisma.inventoryItem.update({
    where: { id: hqInvItem.id },
    data: { currentStock: 0 }
  });

  let rejected0 = false;
  try {
    await FranchiseOrderService.createOrder({
      franchiseId: branch.id,
      orderType: FranchiseOrderType.STOCK,
      items: [{ productId: product.id, quantity: 15 }]
    });
  } catch (err: any) {
    rejected0 = true;
    console.log(`   Caught expected rejection: "${err.message}"`);
    if (!err.message.includes('Only 0 units available in HQ warehouse')) {
      throw new Error(`FAIL Test 5: Error message did not report 0 units available: "${err.message}"`);
    }
  }
  if (!rejected0) {
    throw new Error('FAIL Test 5: Expected order with 0 stock to be rejected, but it succeeded!');
  }
  console.log('   [PASS] Correctly rejected with 0 available units\n');

  // =========================================================================
  // TEST 6: Reset stock to 99 & Test Fulfillment Path & Status Transitions
  // =========================================================================
  console.log('--- TEST 6: Fulfillment Path & Dispatch Deduction ---');
  await prisma.inventoryItem.update({
    where: { id: hqInvItem.id },
    data: { currentStock: 99 }
  });

  // Approve order1
  const approvedOrder = await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.APPROVED);
  console.log(`   Order approved: fulfillmentPath = ${approvedOrder?.fulfillmentPath} (Expected: STOCK)`);
  if (approvedOrder?.fulfillmentPath !== 'STOCK') {
    throw new Error(`FAIL Test 6: Expected fulfillmentPath STOCK, got: ${approvedOrder?.fulfillmentPath}`);
  }

  // Dispatch order1
  await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.DISPATCHED);
  const hqItemAfterDispatch = await prisma.inventoryItem.findUnique({ where: { id: hqInvItem.id } });
  console.log(`   HQ InventoryItem stock after dispatch: ${hqItemAfterDispatch?.currentStock} (Expected: 84)`);
  if (hqItemAfterDispatch?.currentStock !== 84) {
    throw new Error(`FAIL Test 6: Expected HQ stock to be 84 after 15 units dispatched, got: ${hqItemAfterDispatch?.currentStock}`);
  }

  // Deliver order1
  await FranchiseOrderService.updateStatus(order1.id, FranchiseOrderStatus.DELIVERED);
  const branchItem = await prisma.inventoryItem.findFirst({
    where: { franchiseId: branch.id, name: productName }
  });
  console.log(`   Branch InventoryItem stock after delivery: ${branchItem?.currentStock} (Expected: 15)`);
  if (!branchItem || branchItem.currentStock !== 15) {
    throw new Error(`FAIL Test 6: Expected Branch stock to be 15 after delivery, got: ${branchItem?.currentStock}`);
  }
  console.log('   [PASS] Dispatch deducted 15 from HQ (99 -> 84) and Delivery credited 15 to Branch (0 -> 15)\n');

  // Clean up test records
  await prisma.franchiseOrderItem.deleteMany({ where: { product: { sku: productSku } } });
  await prisma.franchiseOrder.deleteMany({ where: { id: { in: [order1.id, order2.id] } } });
  await prisma.stockMovement.deleteMany({ where: { item: { sku: { in: [productSku, branchItem?.sku || ''] } } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: [hqInvItem.id, branchItem?.id || ''] } } });
  await prisma.product.deleteMany({ where: { sku: productSku } });

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runTests()
  .catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
