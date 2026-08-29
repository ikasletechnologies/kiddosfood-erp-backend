import prisma from '../../lib/prisma';
import { FranchiseOrderService } from '../../modules/franchise/franchise-order.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { POSService } from '../../modules/pos/pos.service';
import { IsolationUtil } from '../../utils/isolation.util';
import { GSTInvoiceService } from '../../modules/finance/gst-invoice.service';

async function runDualFranchiseBusinessSimulation() {
  console.log('================================================================');
  console.log('🏬 DUAL-FRANCHISE COMPLETE BUSINESS SIMULATION & AUDIT');
  console.log('================================================================\n');

  const simId = `SIM_${Date.now()}`;
  let failures = 0;

  let hqFranchiseId: string | null = null;
  let franchiseAId: string | null = null;
  let franchiseBId: string | null = null;
  let warehouseHqId: string | null = null;
  let warehouseAId: string | null = null;
  let warehouseBId: string | null = null;
  let productId: string | null = null;
  let hqInvItemId: string | null = null;
  let orderAId: string | null = null;
  let orderBId: string | null = null;

  try {
    // ----------------------------------------------------------------
    // 1️⃣ Setup Master Data (HQ + Franchise A + Franchise B)
    // ----------------------------------------------------------------
    console.log('1️⃣ Setting up Master Data (HQ, Franchise A, Franchise B)...');

    let hqFranchise = await prisma.franchise.findFirst({ where: { isHQ: true } });
    if (!hqFranchise) hqFranchise = await prisma.franchise.findFirst();
    if (!hqFranchise) {
      hqFranchise = await prisma.franchise.create({
        data: { name: `HQ ${simId}`, location: 'HQ State', ownerName: 'HQ Admin', contactNum: '9000000000', isHQ: true }
      });
    }
    hqFranchiseId = hqFranchise.id;

    const franchiseA = await prisma.franchise.create({
      data: { name: `Franchise Alpha ${simId}`, location: 'Tamil Nadu', ownerName: 'Alpha Admin', contactNum: '9111111111', isHQ: false }
    });
    franchiseAId = franchiseA.id;

    const franchiseB = await prisma.franchise.create({
      data: { name: `Franchise Beta ${simId}`, location: 'Karnataka', ownerName: 'Beta Admin', contactNum: '9222222222', isHQ: false }
    });
    franchiseBId = franchiseB.id;

    const warehouseHq = await prisma.warehouse.create({
      data: { name: `HQ Main WH ${simId}`, nameKey: `hq_wh_${simId}`.toLowerCase(), status: 'ACTIVE' }
    });
    warehouseHqId = warehouseHq.id;

    const warehouseA = await prisma.warehouse.create({
      data: { name: `Alpha WH ${simId}`, nameKey: `alpha_wh_${simId}`.toLowerCase(), status: 'ACTIVE' }
    });
    warehouseAId = warehouseA.id;

    const warehouseB = await prisma.warehouse.create({
      data: { name: `Beta WH ${simId}`, nameKey: `beta_wh_${simId}`.toLowerCase(), status: 'ACTIVE' }
    });
    warehouseBId = warehouseB.id;

    // Create Master Product IDB-1KG (Transfer Price = ₹80.00)
    const product = await prisma.product.create({
      data: {
        name: `IDB Batter 1KG ${simId}`,
        sku: `IDB-1KG-${simId}`,
        category: 'FINISHED_GOOD',
        productType: 'FINISHED_GOOD',
        basePrice: 80, // Wholesale transfer price to franchise
        taxPercent: 5,
        isActive: true
      }
    });
    productId = product.id;
    console.log(`   - Master Product Created: ${product.name} (SKU: ${product.sku}, Transfer Price: ₹80.00)`);

    // Create HQ Finished Goods Inventory: 100 units @ ₹65 manufacturing cost
    const hqInvItem = await prisma.inventoryItem.create({
      data: {
        name: product.name,
        sku: product.sku || `IDB-1KG-${simId}`,
        category: 'FINISHED_GOOD',
        currentStock: 0,
        unit: 'PC',
        franchiseId: null,
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
      receiveAtCost: { unitCost: 65, batchNumber: `HQ-MFG-${simId}` }
    });
    console.log('   - HQ Inventory Initialized: 100 units @ ₹65.00 manufacturing cost.');

    const productSku = product.sku || `IDB-1KG-${simId}`;

    // ----------------------------------------------------------------
    // 2️⃣ Franchise A Workflow (Orders 20 units)
    // ----------------------------------------------------------------
    console.log('\n2️⃣ Franchise A Order & Receiving (Quantity: 20)...');
    const orderA = await FranchiseOrderService.createOrder({
      franchiseId: franchiseA.id,
      items: [{ productId: product.id, quantity: 20 }]
    });
    orderAId = orderA.id;

    await FranchiseOrderService.updateStatus(orderA.id, 'APPROVED' as any);
    await FranchiseOrderService.updateStatus(orderA.id, 'DISPATCHED' as any);
    await FranchiseOrderService.updateStatus(orderA.id, 'DELIVERED' as any);

    // Auto-generate intercompany GST invoice for Franchise A
    const invoiceA = await GSTInvoiceService.generateFranchiseInvoice(orderA.id, false);
    console.log(`   - Franchise A GST Invoice Generated: Total ₹${invoiceA.grandTotal.toFixed(2)} (Taxable: ₹${invoiceA.subtotal.toFixed(2)})`);

    const itemA = await prisma.inventoryItem.findFirst({
      where: { franchiseId: franchiseA.id, sku: productSku }
    });
    const batchA = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: itemA?.id } });
    console.log(`   - Franchise A Received Stock: ${itemA?.currentStock} units @ ₹${batchA?.unitCost?.toFixed(2)} unitCost`);

    if (itemA?.currentStock === 20 && Math.abs((batchA?.unitCost ?? 0) - 80) < 0.001) {
      console.log('   ✅ PASS: Franchise A received 20 units at exact ₹80.00 acquisition price!');
    } else {
      console.error(`   ❌ FAIL: Franchise A receiving mismatch (Stock: ${itemA?.currentStock}, Cost: ₹${batchA?.unitCost})`);
      failures++;
    }

    // ----------------------------------------------------------------
    // 3️⃣ Franchise B Workflow (Orders 10 units)
    // ----------------------------------------------------------------
    console.log('\n3️⃣ Franchise B Order & Receiving (Quantity: 10)...');
    const orderB = await FranchiseOrderService.createOrder({
      franchiseId: franchiseB.id,
      items: [{ productId: product.id, quantity: 10 }]
    });
    orderBId = orderB.id;

    await FranchiseOrderService.updateStatus(orderB.id, 'APPROVED' as any);
    await FranchiseOrderService.updateStatus(orderB.id, 'DISPATCHED' as any);
    await FranchiseOrderService.updateStatus(orderB.id, 'DELIVERED' as any);

    const invoiceB = await GSTInvoiceService.generateFranchiseInvoice(orderB.id, true); // Inter-state
    console.log(`   - Franchise B GST Inter-State Invoice Generated: IGST ₹${invoiceB.igst.toFixed(2)}, Total ₹${invoiceB.grandTotal.toFixed(2)}`);

    const itemB = await prisma.inventoryItem.findFirst({
      where: { franchiseId: franchiseB.id, sku: productSku }
    });
    const batchB = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: itemB?.id } });
    console.log(`   - Franchise B Received Stock: ${itemB?.currentStock} units @ ₹${batchB?.unitCost?.toFixed(2)} unitCost`);

    if (itemB?.currentStock === 10 && Math.abs((batchB?.unitCost ?? 0) - 80) < 0.001) {
      console.log('   ✅ PASS: Franchise B received 10 units at exact ₹80.00 acquisition price!');
    } else {
      console.error(`   ❌ FAIL: Franchise B receiving mismatch (Stock: ${itemB?.currentStock}, Cost: ₹${batchB?.unitCost})`);
      failures++;
    }

    // ----------------------------------------------------------------
    // 4️⃣ HQ Stock Audit (100 - 30 = 70 units)
    // ----------------------------------------------------------------
    console.log('\n4️⃣ HQ Stock Audit after Dispatches...');
    const reloadedHqItem = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: hqInvItem.id } });
    console.log(`   - HQ Stock Remaining: ${reloadedHqItem.currentStock} units (Expected: 70 = 100 - 20 - 10)`);
    if (reloadedHqItem.currentStock === 70) {
      console.log('   ✅ PASS: HQ stock decremented by exact combined dispatch quantity (70 remaining)!');
    } else {
      console.error(`   ❌ FAIL: HQ stock mismatch (Got ${reloadedHqItem.currentStock})`);
      failures++;
    }

    // ----------------------------------------------------------------
    // 5️⃣ Franchise A POS Sales (Sells 5 units @ ₹100 each)
    // ----------------------------------------------------------------
    console.log('\n5️⃣ Franchise A POS Checkout (5 units @ ₹100)...');
    await POSService.checkout({
      franchiseId: franchiseA.id,
      items: [{ productId: product.id, quantity: 5, price: 100 }],
      subTotal: 500, taxAmount: 25, discountAmount: 0, totalAmount: 525, paymentMode: 'CASH'
    });

    const updatedItemA = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemA!.id } });
    const movA = await prisma.stockMovement.findFirst({ where: { itemId: itemA!.id, movementType: 'SALES_OUT' } });
    const cogsA = Math.abs((movA?.unitCost ?? 0) * (movA?.quantity ?? 5));
    const revA = 5 * 100;
    const profitA = revA - cogsA;

    console.log(`   - Franchise A Stock Remaining: ${updatedItemA.currentStock} units (Exp: 15)`);
    console.log(`   - Franchise A POS Revenue: ₹${revA.toFixed(2)}`);
    console.log(`   - Franchise A POS COGS: ₹${cogsA.toFixed(2)} (Exp: ₹400.00 = 5 × ₹80)`);
    console.log(`   - Franchise A Gross Profit: ₹${profitA.toFixed(2)} (Exp: ₹100.00 = ₹500 - ₹400)`);

    if (updatedItemA.currentStock === 15 && Math.abs(cogsA - 400) < 0.001 && Math.abs(profitA - 100) < 0.001) {
      console.log('   ✅ PASS: Franchise A POS sales, COGS, and Gross Profit match target metrics exactly!');
    } else {
      console.error(`   ❌ FAIL: Franchise A POS metrics mismatch (Stock: ${updatedItemA.currentStock}, COGS: ₹${cogsA}, Profit: ₹${profitA})`);
      failures++;
    }

    // ----------------------------------------------------------------
    // 6️⃣ Franchise B POS Sales (Sells 3 units @ ₹100 each)
    // ----------------------------------------------------------------
    console.log('\n6️⃣ Franchise B POS Checkout (3 units @ ₹100)...');
    await POSService.checkout({
      franchiseId: franchiseB.id,
      items: [{ productId: product.id, quantity: 3, price: 100 }],
      subTotal: 300, taxAmount: 15, discountAmount: 0, totalAmount: 315, paymentMode: 'CASH'
    });

    const updatedItemB = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemB!.id } });
    const movB = await prisma.stockMovement.findFirst({ where: { itemId: itemB!.id, movementType: 'SALES_OUT' } });
    const cogsB = Math.abs((movB?.unitCost ?? 0) * (movB?.quantity ?? 3));
    const revB = 3 * 100;
    const profitB = revB - cogsB;

    console.log(`   - Franchise B Stock Remaining: ${updatedItemB.currentStock} units (Exp: 7)`);
    console.log(`   - Franchise B POS Revenue: ₹${revB.toFixed(2)}`);
    console.log(`   - Franchise B POS COGS: ₹${cogsB.toFixed(2)} (Exp: ₹240.00 = 3 × ₹80)`);
    console.log(`   - Franchise B Gross Profit: ₹${profitB.toFixed(2)} (Exp: ₹60.00 = ₹300 - ₹240)`);

    if (updatedItemB.currentStock === 7 && Math.abs(cogsB - 240) < 0.001 && Math.abs(profitB - 60) < 0.001) {
      console.log('   ✅ PASS: Franchise B POS sales, COGS, and Gross Profit match target metrics exactly!');
    } else {
      console.error(`   ❌ FAIL: Franchise B POS metrics mismatch (Stock: ${updatedItemB.currentStock}, COGS: ₹${cogsB}, Profit: ₹${profitB})`);
      failures++;
    }

    // ----------------------------------------------------------------
    // 7️⃣ Consolidated Business Metrics
    // ----------------------------------------------------------------
    console.log('\n7️⃣ Consolidated Commercial Totals Verification...');
    const combinedRev = revA + revB;
    const combinedCogs = cogsA + cogsB;
    const combinedProfit = profitA + profitB;

    console.log(`   - Combined Revenue: ₹${combinedRev.toFixed(2)} (Exp: ₹800.00 = ₹500 + ₹300)`);
    console.log(`   - Combined COGS: ₹${combinedCogs.toFixed(2)} (Exp: ₹640.00 = ₹400 + ₹240)`);
    console.log(`   - Combined Gross Profit: ₹${combinedProfit.toFixed(2)} (Exp: ₹160.00 = ₹100 + ₹60)`);

    if (Math.abs(combinedRev - 800) < 0.001 && Math.abs(combinedCogs - 640) < 0.001 && Math.abs(combinedProfit - 160) < 0.001) {
      console.log('   ✅ PASS: Consolidated commercial metrics match expected target values 100%!');
    } else {
      console.error('   ❌ FAIL: Consolidated commercial metrics mismatch');
      failures++;
    }

    // ----------------------------------------------------------------
    // 8️⃣ Security & Cross-Tenant Data Isolation Checks
    // ----------------------------------------------------------------
    console.log('\n8️⃣ Security & Cross-Tenant Data Isolation Checks...');

    // Check Franchise A query scoping
    const filterA = IsolationUtil.getFranchiseFilter({ userId: 'uA', role: 'FRANCHISE_ADMIN', franchiseId: franchiseA.id } as any);
    const filterB = IsolationUtil.getFranchiseFilter({ userId: 'uB', role: 'FRANCHISE_ADMIN', franchiseId: franchiseB.id } as any);

    const stockAItems = await prisma.inventoryItem.findMany({ where: { ...filterA, sku: productSku } });
    const stockBItems = await prisma.inventoryItem.findMany({ where: { ...filterB, sku: productSku } });

    console.log(`   - Franchise A Filter Stock Output: ${stockAItems.length} item(s) (Stock: ${stockAItems[0]?.currentStock})`);
    console.log(`   - Franchise B Filter Stock Output: ${stockBItems.length} item(s) (Stock: ${stockBItems[0]?.currentStock})`);

    if (stockAItems.length === 1 && stockAItems[0].currentStock === 15 && stockBItems.length === 1 && stockBItems[0].currentStock === 7) {
      console.log('   ✅ PASS: Multi-branch inventory queries return strictly own franchise records!');
    } else {
      console.error('   ❌ FAIL: Multi-branch inventory query scoping failed');
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during dual franchise simulation:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up simulation data...');
    try {
      if (orderAId) {
        await prisma.stockMovement.deleteMany({ where: { referenceId: orderAId } });
        await prisma.franchiseLedger.deleteMany({ where: { referenceId: { contains: simId } } });
        await prisma.franchiseOrderItem.deleteMany({ where: { orderId: orderAId } });
        await prisma.franchiseOrder.delete({ where: { id: orderAId } });
      }
      if (orderBId) {
        await prisma.stockMovement.deleteMany({ where: { referenceId: orderBId } });
        await prisma.franchiseLedger.deleteMany({ where: { referenceId: { contains: simId } } });
        await prisma.franchiseOrderItem.deleteMany({ where: { orderId: orderBId } });
        await prisma.franchiseOrder.delete({ where: { id: orderBId } });
      }
      await prisma.invoice.deleteMany({ where: { order: { franchiseId: { in: [franchiseAId || '', franchiseBId || ''] } } } });
      await prisma.orderItem.deleteMany({ where: { product: { name: { contains: simId } } } });
      await prisma.payment.deleteMany({ where: { order: { franchiseId: { in: [franchiseAId || '', franchiseBId || ''] } } } });
      await prisma.order.deleteMany({ where: { franchiseId: { in: [franchiseAId || '', franchiseBId || ''] } } });
      await prisma.stockMovement.deleteMany({ where: { item: { name: { contains: simId } } } });
      await prisma.inventoryBatch.deleteMany({ where: { inventoryItem: { name: { contains: simId } } } });
      await prisma.inventoryItem.deleteMany({ where: { name: { contains: simId } } });
      await prisma.productBatch.deleteMany({ where: { product: { name: { contains: simId } } } });
      if (productId) await prisma.product.delete({ where: { id: productId } });
      if (warehouseAId) await prisma.warehouse.delete({ where: { id: warehouseAId } });
      if (warehouseBId) await prisma.warehouse.delete({ where: { id: warehouseBId } });
      if (warehouseHqId) await prisma.warehouse.delete({ where: { id: warehouseHqId } });
      await prisma.franchiseLedger.deleteMany({ where: { franchiseId: { in: [franchiseAId || '', franchiseBId || ''] } } });
      if (franchiseAId) await prisma.franchise.delete({ where: { id: franchiseAId } });
      if (franchiseBId) await prisma.franchise.delete({ where: { id: franchiseBId } });
      console.log('   ✅ Verification test data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 DUAL-FRANCHISE BUSINESS SIMULATION PASSED 100%! 🎉');
  } else {
    console.error(`💥 ${failures} SIMULATION ASSERTION(S) FAILED.`);
    process.exit(1);
  }
}

runDualFranchiseBusinessSimulation()
  .catch(err => {
    console.error('Fatal simulation error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
