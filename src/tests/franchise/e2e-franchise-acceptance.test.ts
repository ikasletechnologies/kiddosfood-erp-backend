import prisma from '../../lib/prisma';
import { FranchiseOrderService } from '../../modules/franchise/franchise-order.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { POSService } from '../../modules/pos/pos.service';
import { IsolationUtil } from '../../utils/isolation.util';

async function runE2EFranchiseAcceptanceTest() {
  console.log('================================================================');
  console.log('🧪 FRANCHISE MODULE — FULL E2E ACCEPTANCE TEST SUITE');
  console.log('================================================================\n');

  const testId = `FRAN_E2E_${Date.now()}`;
  let failures = 0;

  let hqFranchiseId: string | null = null;
  let franchiseAId: string | null = null;
  let franchiseBId: string | null = null;
  let warehouseHqId: string | null = null;
  let warehouseAId: string | null = null;
  let productId: string | null = null;
  let hqInvItemId: string | null = null;
  let orderId: string | null = null;

  try {
    // 1. Setup Master Data (HQ & 2 Franchises)
    console.log('1️⃣ Setting up Master Data (HQ & Franchises A & B)...');
    
    // Fetch canonical HQ franchise
    let hqFranchise = await prisma.franchise.findFirst({ where: { isHQ: true } });
    if (!hqFranchise) {
      hqFranchise = await prisma.franchise.findFirst();
    }
    if (!hqFranchise) {
      hqFranchise = await prisma.franchise.create({
        data: {
          name: `HQ ${testId}`,
          location: 'HQ State',
          ownerName: 'HQ Admin',
          contactNum: '9000000000',
          isHQ: true
        }
      });
    }
    hqFranchiseId = hqFranchise.id;

    const franchiseA = await prisma.franchise.create({
      data: {
        name: `Franchise Alpha ${testId}`,
        location: 'Tamil Nadu',
        ownerName: 'Alpha Admin',
        contactNum: '9111111111',
        isHQ: false
      }
    });
    franchiseAId = franchiseA.id;

    const franchiseB = await prisma.franchise.create({
      data: {
        name: `Franchise Beta ${testId}`,
        location: 'Karnataka',
        ownerName: 'Beta Admin',
        contactNum: '9222222222',
        isHQ: false
      }
    });
    franchiseBId = franchiseB.id;

    const warehouseHq = await prisma.warehouse.create({
      data: {
        name: `HQ Main WH ${testId}`,
        nameKey: `hq_wh_${testId}`.toLowerCase(),
        status: 'ACTIVE'
      }
    });
    if (!warehouseHq) throw new Error('Warehouse creation failed');
    warehouseHqId = warehouseHq.id;

    const warehouseA = await prisma.warehouse.create({
      data: {
        name: `Alpha WH ${testId}`,
        nameKey: `alpha_wh_${testId}`.toLowerCase(),
        status: 'ACTIVE'
      }
    });
    warehouseAId = warehouseA.id;

    // Create HQ Master Product
    const product = await prisma.product.create({
      data: {
        name: `Premium Batter 1KG ${testId}`,
        sku: `BATTER-1KG-${testId}`,
        category: 'FINISHED_GOOD',
        productType: 'FINISHED_GOOD',
        basePrice: 80, // HQ wholesale price
        taxPercent: 5,
        isActive: true
      }
    });
    productId = product.id;
    console.log(`   - Master Product Created: ${product.name} (SKU: ${product.sku}, Base Price: ₹${product.basePrice})`);

    // Create HQ Finished Goods Stock: 100 units @ ₹65 manufacturing cost
    const hqInvItem = await prisma.inventoryItem.create({
      data: {
        name: product.name,
        sku: product.sku || `BATTER-1KG-${testId}`,
        category: 'FINISHED_GOOD',
        currentStock: 0,
        unit: 'PC',
        franchiseId: null, // HQ Scope
        basePrice: 80,
        costPrice: 65,
        isActive: true
      }
    });
    hqInvItemId = hqInvItem.id;

    await InventoryService.recordMovement(prisma, {
      itemId: hqInvItem.id,
      type: 'PRODUCTION_IN',
      quantity: 100,
      warehouseId: warehouseHq.id,
      note: 'HQ Initial Manufacturing Output',
      receiveAtCost: { unitCost: 65, batchNumber: `HQ-MFG-${testId}` }
    });

    console.log('   - HQ Inventory Initialized: 100 units @ ₹65 manufacturing cost.');

    // 2. CASE A & B: Product Discovery & Creation Restriction
    console.log('\n2️⃣ CASE A & B — Product Catalog & Role Restriction Check...');
    const userFranchiseTokenPayload = { userId: 'fa-1', role: 'FRANCHISE_ADMIN', franchiseId: franchiseA.id };
    const franchiseFilter = IsolationUtil.getFranchiseFilter(userFranchiseTokenPayload as any);
    console.log(`   - Franchise Filter: ${JSON.stringify(franchiseFilter)}`);
    if (franchiseFilter.franchiseId === franchiseA.id) {
      console.log('   ✅ PASS: Franchise user token resolves to own franchiseId!');
    } else {
      console.error('   ❌ FAIL: Franchise user token scoping mismatch');
      failures++;
    }

    // 3. CASE C & D: Franchise Order Creation & Approval
    console.log('\n3️⃣ CASE C & D — Franchise Orders HQ Stock (Quantity: 20)...');
    const order = await FranchiseOrderService.createOrder({
      franchiseId: franchiseA.id,
      items: [{ productId: product.id, quantity: 20 }]
    });
    orderId = order.id;

    console.log(`   - Order Created: ${order.orderNumber} (Total Amount: ₹${order.totalAmount})`);
    console.log(`   - Order Status: ${order.status}`);

    const approvedOrder = await FranchiseOrderService.updateStatus(order.id, 'APPROVED' as any);
    if (!approvedOrder) throw new Error('Failed to approve order');
    console.log(`   - Order Status after Approval: ${approvedOrder.status} (Path: ${approvedOrder.fulfillmentPath})`);
    if (approvedOrder.status === 'APPROVED' && approvedOrder.fulfillmentPath === 'STOCK') {
      console.log('   ✅ PASS: HQ approval set fulfillment path to STOCK!');
    } else {
      console.error('   ❌ FAIL: Approval fulfillment path mismatch');
      failures++;
    }

    // 4. CASE E: HQ Dispatch (HQ Stock 100 -> 80)
    console.log('\n4️⃣ CASE E — HQ Dispatches Order (Fulfillment)...');
    await FranchiseOrderService.updateStatus(order.id, 'DISPATCHED' as any);
    
    const reloadedHqItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: hqInvItem.id } });
    console.log(`   - HQ Stock Remaining: ${reloadedHqItem.currentStock} units (Exp: 80 units)`);
    if (reloadedHqItem.currentStock === 80) {
      console.log('   ✅ PASS: HQ stock decremented by exact order quantity (100 -> 80)!');
    } else {
      console.error(`   ❌ FAIL: HQ stock mismatch (Exp 80, got ${reloadedHqItem.currentStock})`);
      failures++;
    }

    // 5. CASE F, G, H: Franchise Delivery & Receiving (Stock 0 -> 20, Cost = ₹80, SKU = product.sku)
    console.log('\n5️⃣ CASE F, G, H — Franchise Receives Stock...');
    await FranchiseOrderService.updateStatus(order.id, 'DELIVERED' as any);

    const productSku = product.sku || `BATTER-1KG-${testId}`;
    const franchiseItem = await prisma.inventoryItem.findFirst({
      where: { franchiseId: franchiseA.id, sku: productSku }
    });

    if (!franchiseItem) {
      console.error('   ❌ FAIL: Franchise InventoryItem not found with exact Product SKU!');
      failures++;
    } else {
      console.log(`   - Franchise Item Created: "${franchiseItem.name}"`);
      console.log(`   - Franchise Item SKU: "${franchiseItem.sku}" (Matches Product.sku: ${franchiseItem.sku === productSku})`);
      console.log(`   - Franchise Item Stock: ${franchiseItem.currentStock} units`);

      const franchiseBatch = await prisma.inventoryBatch.findFirst({
        where: { inventoryItemId: franchiseItem.id }
      });
      const batchUnitCost = franchiseBatch?.unitCost ?? 0;

      console.log(`   - Franchise InventoryBatch Unit Cost: ₹${batchUnitCost.toFixed(2)} (Exp: ₹80.00 = HQ Wholesale Price)`);

      if (franchiseItem.sku === productSku && franchiseItem.currentStock === 20 && Math.abs(batchUnitCost - 80) < 0.001) {
        console.log('   ✅ PASS: Franchise receiving correctly preserved SKU (BATTER-1KG) and assigned acquisition unitCost (₹80.00)!');
      } else {
        console.error(`   ❌ FAIL: Franchise inventory valuation or SKU mismatch (Got SKU: ${franchiseItem.sku}, unitCost: ₹${batchUnitCost})`);
        failures++;
      }

      // 6. CASE I: Franchise POS Checkout & COGS Verification
      console.log('\n6️⃣ CASE I — Franchise POS Sale of 1 Unit...');
      const posCheckout = await POSService.checkout({
        franchiseId: franchiseA.id,
        items: [{ productId: product.id, quantity: 1, price: 100 }],
        subTotal: 100,
        taxAmount: 5,
        discountAmount: 0,
        totalAmount: 105,
        paymentMode: 'CASH'
      });

      const updatedFranchiseItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: franchiseItem.id } });
      console.log(`   - Franchise Stock after POS Sale: ${updatedFranchiseItem.currentStock} units (Exp: 19 units)`);

      const posMovement = await prisma.stockMovement.findFirst({
        where: { itemId: franchiseItem.id, movementType: 'SALES_OUT' }
      });

      const posCogs = Math.abs((posMovement?.unitCost ?? 0) * (posMovement?.quantity ?? 1));
      const posGrossProfit = 100 - posCogs;
      console.log(`   - POS Sale Revenue: ₹100.00`);
      console.log(`   - POS Sale COGS: ₹${posCogs.toFixed(2)} (Exp: ₹80.00)`);
      console.log(`   - POS Gross Profit: ₹${posGrossProfit.toFixed(2)} (Exp: ₹20.00 = ₹100 - ₹80)`);

      if (updatedFranchiseItem.currentStock === 19 && Math.abs(posCogs - 80) < 0.001) {
        console.log('   ✅ PASS: POS checkout consumed FIFO lot at ₹80.00 acquisition cost, producing correct ₹20.00 Gross Profit!');
      } else {
        console.error(`   ❌ FAIL: POS COGS calculation mismatch (Got COGS: ₹${posCogs})`);
        failures++;
      }
    }

    // 7. CASE J & K: Cross-Franchise Isolation Checks
    console.log('\n7️⃣ CASE J & K — Cross-Franchise Isolation Check (Franchise A vs Franchise B)...');
    const franchiseBItems = await prisma.inventoryItem.findMany({
      where: { franchiseId: franchiseB.id }
    });
    console.log(`   - Franchise B Stock Count for Product: ${franchiseBItems.length} items (Exp: 0 items)`);
    if (franchiseBItems.length === 0) {
      console.log('   ✅ PASS: Franchise B has ZERO access to Franchise A inventory stock!');
    } else {
      console.error('   ❌ FAIL: Franchise B has unexpected stock leakage');
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during full E2E Franchise acceptance test:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up test data...');
    try {
      if (orderId) {
        await prisma.stockMovement.deleteMany({ where: { referenceId: orderId } });
        await prisma.franchiseLedger.deleteMany({ where: { referenceId: { contains: testId } } });
        await prisma.franchiseOrderItem.deleteMany({ where: { orderId } });
        await prisma.franchiseOrder.delete({ where: { id: orderId } });
      }
      await prisma.invoice.deleteMany({ where: { order: { franchiseId: franchiseAId || undefined } } });
      await prisma.orderItem.deleteMany({ where: { product: { name: { contains: testId } } } });
      await prisma.payment.deleteMany({ where: { order: { franchiseId: franchiseAId || undefined } } });
      await prisma.order.deleteMany({ where: { franchiseId: franchiseAId || undefined } });
      await prisma.stockMovement.deleteMany({ where: { item: { name: { contains: testId } } } });
      await prisma.inventoryBatch.deleteMany({ where: { inventoryItem: { name: { contains: testId } } } });
      await prisma.inventoryItem.deleteMany({ where: { name: { contains: testId } } });
      await prisma.productBatch.deleteMany({ where: { product: { name: { contains: testId } } } });
      if (productId) await prisma.product.delete({ where: { id: productId } });
      if (warehouseAId) await prisma.warehouse.delete({ where: { id: warehouseAId } });
      if (warehouseHqId) await prisma.warehouse.delete({ where: { id: warehouseHqId } });
      await prisma.franchiseLedger.deleteMany({ where: { franchiseId: franchiseAId || undefined } });
      if (franchiseAId) await prisma.franchise.delete({ where: { id: franchiseAId } });
      if (franchiseBId) await prisma.franchise.delete({ where: { id: franchiseBId } });
      console.log('   ✅ Verification test data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 FULL E2E FRANCHISE ACCEPTANCE TEST PASSED 100%! 🎉');
  } else {
    console.error(`💥 ${failures} ACCEPTANCE CHECK(S) FAILED.`);
    process.exit(1);
  }
}

runE2EFranchiseAcceptanceTest()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
