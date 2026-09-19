import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

async function main() {
  console.log('=================================================================');
  console.log('🧪 RUNNING DELIVERY CHALLAN STOCK RESTRICTION SUITE');
  console.log('=================================================================\n');

  const suffix = Date.now().toString();
  const createdCustomerIds: string[] = [];
  const createdChallanIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdInventoryItemIds: string[] = [];
  const createdFranchiseIds: string[] = [];

  const hq = await FranchiseService.getHqFranchise();

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    try {
      if (createdOrderIds.length > 0) {
        await prisma.stockMovement.deleteMany({ where: { referenceType: 'ORDER', referenceId: { in: createdOrderIds } } });
        await prisma.invoice.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdChallanIds.length > 0) {
        await prisma.deliveryChallanItem.deleteMany({ where: { challanId: { in: createdChallanIds } } });
        await prisma.deliveryChallan.deleteMany({ where: { id: { in: createdChallanIds } } });
      }
      if (createdCustomerIds.length > 0) {
        await prisma.customerLedger.deleteMany({ where: { customerId: { in: createdCustomerIds } } });
        await prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } });
      }
      if (createdInventoryItemIds.length > 0) {
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: createdInventoryItemIds } } });
        await prisma.stockMovement.deleteMany({ where: { itemId: { in: createdInventoryItemIds } } });
        await prisma.inventoryItem.deleteMany({ where: { id: { in: createdInventoryItemIds } } });
      }
      if (createdProductIds.length > 0) {
        await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
      }
      if (createdFranchiseIds.length > 0) {
        await prisma.franchise.deleteMany({ where: { id: { in: createdFranchiseIds } } });
      }
      console.log('   ✅ Cleanup completed successfully');
    } catch (e: any) {
      console.warn('   ⚠️ Cleanup warning:', e.message);
    }
  };

  try {
    // -------------------------------------------------------------------------
    // TEST CASE 1: Delivery Challan with 0 Available Stock
    // -------------------------------------------------------------------------
    console.log('--- TEST CASE 1: Delivery Challan with 0 Stock (Save works, Sale Invoice blocked) ---');
    const prod1Sku = `FG-APPA-450G-${suffix}`;
    const prod1 = await prisma.product.create({
      data: {
        name: `APPAM 450G ${suffix}`,
        sku: prod1Sku,
        basePrice: 50,
        taxPercent: 5,
      }
    });
    createdProductIds.push(prod1.id);

    // Inventory item with 0 stock in HQ
    const inv1 = await prisma.inventoryItem.create({
      data: {
        name: prod1.name,
        sku: prod1Sku,
        category: 'FINISHED_GOOD',
        unit: 'PCS',
        currentStock: 0,
        basePrice: 50,
        franchiseId: null, // HQ
      }
    });
    createdInventoryItemIds.push(inv1.id);

    const cust1 = await prisma.customer.create({
      data: {
        name: `Customer TC1 ${suffix}`,
        phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
        franchiseId: hq.id,
      }
    });
    createdCustomerIds.push(cust1.id);

    // 1. Create Delivery Challan with 10 PCS (status: IN_TRANSIT)
    const dc1 = await SalesService.createDeliveryChallan({
      customerId: cust1.id,
      sourceFranchiseId: hq.id,
      status: 'IN_TRANSIT',
      items: [{
        productId: prod1.id,
        productName: prod1.name,
        quantity: 10,
        unit: 'PCS',
        rate: 50,
        taxPercent: 5,
      }]
    } as any, 'tester');
    createdChallanIds.push(dc1.id);

    console.log(`   ✅ DC saved successfully with ID: ${dc1.id}, challanNumber: ${dc1.challanNumber}`);
    if (dc1.status !== 'IN_TRANSIT') throw new Error(`Expected status IN_TRANSIT, got ${dc1.status}`);

    // Verify stock is still 0 (no negative stock, no stock movement)
    const checkInv1 = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inv1.id } });
    if (checkInv1.currentStock !== 0) throw new Error(`Expected currentStock to remain 0, got ${checkInv1.currentStock}`);
    console.log(`   ✅ Available stock remained 0 (no premature deduction on challan save)`);

    // 2. Mark Challan as Delivered (status: CLOSED)
    const deliveredDc1 = await SalesService.markChallanDelivered(dc1.id, {
      receivedBy: 'Receiver',
      podReference: 'POD-123'
    }, 'tester');
    if (deliveredDc1.status !== 'CLOSED') throw new Error(`Expected status CLOSED, got ${deliveredDc1.status}`);
    console.log(`   ✅ Challan marked as Delivered (CLOSED) without error`);

    // 3. Attempt to convert to Sale Invoice when stock is 0 -> MUST BE BLOCKED
    let tc1Blocked = false;
    try {
      await FinanceService.createInvoice({
        franchiseId: hq.id,
        customerId: cust1.id,
        partyType: 'CUSTOMER',
        partyId: cust1.id,
        sourceDeliveryChallanId: dc1.id,
        items: [{
          productId: prod1.id,
          productName: prod1.name,
          quantity: 10,
          unit: 'PCS',
          rate: 50,
          gst: 5,
        }]
      });
    } catch (err: any) {
      tc1Blocked = true;
      console.log(`   ✅ Sale Invoice creation correctly BLOCKED: "${err.message}"`);
      if (!err.message.includes('Insufficient stock')) {
        throw new Error(`Expected "Insufficient stock" error message, got "${err.message}"`);
      }
    }
    if (!tc1Blocked) {
      throw new Error('FAIL: Sale Invoice creation was allowed when available stock was 0!');
    }

    // Also verify direct conversion SalesService.convertDeliveryChallanToSale blocks
    let directConvertBlocked = false;
    try {
      await SalesService.convertDeliveryChallanToSale(dc1.id, 'tester');
    } catch (err: any) {
      directConvertBlocked = true;
      console.log(`   ✅ Direct convertDeliveryChallanToSale correctly BLOCKED: "${err.message}"`);
      if (!err.message.includes('Insufficient stock')) {
        throw new Error(`Expected "Insufficient stock" error message, got "${err.message}"`);
      }
    }
    if (!directConvertBlocked) {
      throw new Error('FAIL: Direct conversion was allowed when available stock was 0!');
    }

    // -------------------------------------------------------------------------
    // TEST CASE 2: Delivery Challan with Stock 10, Qty 5 (Single Deduction)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 2: Sufficient Stock & Single Deduction ---');
    const prod2Sku = `FG-APPA-450G-S2-${suffix}`;
    const prod2 = await prisma.product.create({
      data: {
        name: `APPAM 450G TC2 ${suffix}`,
        sku: prod2Sku,
        basePrice: 50,
        taxPercent: 5,
      }
    });
    createdProductIds.push(prod2.id);

    // Initial stock = 10 PCS in HQ
    const inv2 = await prisma.inventoryItem.create({
      data: {
        name: prod2.name,
        sku: prod2Sku,
        category: 'FINISHED_GOOD',
        unit: 'PCS',
        currentStock: 0,
        basePrice: 50,
        franchiseId: null, // HQ
      }
    });
    createdInventoryItemIds.push(inv2.id);

    // Add 10 PCS via stockIn
    await InventoryService.stockIn({
      itemId: inv2.id,
      quantity: 10,
      note: 'Initial stock for TC2',
      userId: 'tester'
    });

    const checkStockBeforeDc = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inv2.id } })).currentStock;
    if (checkStockBeforeDc !== 10) throw new Error(`Expected initial stock 10, got ${checkStockBeforeDc}`);
    console.log(`   Initial available stock: ${checkStockBeforeDc} PCS`);

    // 1. Create Delivery Challan for 5 PCS
    const dc2 = await SalesService.createDeliveryChallan({
      customerId: cust1.id,
      sourceFranchiseId: hq.id,
      status: 'IN_TRANSIT',
      items: [{
        productId: prod2.id,
        productName: prod2.name,
        quantity: 5,
        unit: 'PCS',
        rate: 50,
        taxPercent: 5,
      }]
    } as any, 'tester');
    createdChallanIds.push(dc2.id);
    console.log(`   ✅ DC saved for 5 PCS (Challan #${dc2.challanNumber})`);

    // 2. Verify stock is STILL 10 PCS after Challan save
    const stockAfterDc = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inv2.id } })).currentStock;
    if (stockAfterDc !== 10) throw new Error(`Expected stock to remain 10 after DC save, but got ${stockAfterDc}`);
    console.log(`   ✅ Stock remained 10 PCS after DC save (no premature deduction)`);

    // 3. Mark as Delivered
    await SalesService.markChallanDelivered(dc2.id, { receivedBy: 'Receiver 2' }, 'tester');
    const stockAfterDelivered = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inv2.id } })).currentStock;
    if (stockAfterDelivered !== 10) throw new Error(`Expected stock to remain 10 after Delivered, got ${stockAfterDelivered}`);
    console.log(`   ✅ Stock remained 10 PCS after Mark Delivered`);

    // 4. Convert to Sale Invoice (5 PCS)
    const saleInvoice2: any = await FinanceService.createInvoice({
      franchiseId: hq.id,
      customerId: cust1.id,
      partyType: 'CUSTOMER',
      partyId: cust1.id,
      sourceDeliveryChallanId: dc2.id,
      items: [{
        productId: prod2.id,
        productName: prod2.name,
        quantity: 5,
        unit: 'PCS',
        rate: 50,
        gst: 5,
      }]
    });
    createdOrderIds.push(saleInvoice2.order.id);
    console.log(`   ✅ Sale Invoice created successfully #${saleInvoice2.order.invoiceNum}`);

    // 5. Verify stock decreased by exactly 5 PCS (10 -> 5)
    const stockAfterSale = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inv2.id } })).currentStock;
    if (stockAfterSale !== 5) throw new Error(`Expected stock to be exactly 5 after sale, got ${stockAfterSale}`);
    console.log(`   ✅ Stock decreased correctly from 10 to 5 (no duplicate deduction)`);

    // Verify stock movements: exactly ONE sales deduction movement exists
    const movements = await prisma.stockMovement.findMany({
      where: { itemId: inv2.id, movementType: 'SALES_OUT' }
    });
    if (movements.length !== 1) throw new Error(`Expected exactly 1 SALES_OUT movement, got ${movements.length}`);
    if (Math.abs(movements[0].quantity) !== 5) throw new Error(`Expected deduction qty 5, got ${movements[0].quantity}`);
    console.log(`   ✅ Verified exactly 1 stock movement exists for this sale`);

    // -------------------------------------------------------------------------
    // TEST CASE 3: Strict SKU Validation (APPAM 450G vs APPAM 900G)
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 3: Strict SKU Validation (Never cross-borrow variants) ---');
    const sku450 = `FG-APPA-450G-V3-${suffix}`;
    const sku900 = `FG-APPA-900G-V3-${suffix}`;

    const prod450 = await prisma.product.create({
      data: { name: `APPAM 450G ${suffix}`, sku: sku450, basePrice: 40, taxPercent: 5 }
    });
    createdProductIds.push(prod450.id);

    const prod900 = await prisma.product.create({
      data: { name: `APPAM 900G ${suffix}`, sku: sku900, basePrice: 75, taxPercent: 5 }
    });
    createdProductIds.push(prod900.id);

    // APPAM 450G has 0 stock
    const inv450 = await prisma.inventoryItem.create({
      data: { name: prod450.name, sku: sku450, category: 'FINISHED_GOOD', unit: 'PCS', currentStock: 0, franchiseId: null }
    });
    createdInventoryItemIds.push(inv450.id);

    // APPAM 900G has 50 stock
    const inv900 = await prisma.inventoryItem.create({
      data: { name: prod900.name, sku: sku900, category: 'FINISHED_GOOD', unit: 'PCS', currentStock: 0, franchiseId: null }
    });
    createdInventoryItemIds.push(inv900.id);
    await InventoryService.stockIn({ itemId: inv900.id, quantity: 50, note: 'Stock for 900G', userId: 'tester' });

    // Create DC for APPAM 450G x 5
    const dc3 = await SalesService.createDeliveryChallan({
      customerId: cust1.id,
      sourceFranchiseId: hq.id,
      status: 'IN_TRANSIT',
      items: [{ productId: prod450.id, productName: prod450.name, quantity: 5, rate: 40 }]
    } as any, 'tester');
    createdChallanIds.push(dc3.id);
    await SalesService.markChallanDelivered(dc3.id, { receivedBy: 'Receiver 3' }, 'tester');
    console.log(`   ✅ DC for APPAM 450G created and marked delivered`);

    // Convert to Sale Invoice for APPAM 450G -> MUST FAIL even though APPAM 900G has 50 stock!
    let tc3Blocked = false;
    try {
      await FinanceService.createInvoice({
        franchiseId: hq.id,
        customerId: cust1.id,
        partyType: 'CUSTOMER',
        partyId: cust1.id,
        sourceDeliveryChallanId: dc3.id,
        items: [{ productId: prod450.id, productName: prod450.name, quantity: 5, rate: 40 }]
      });
    } catch (err: any) {
      tc3Blocked = true;
      console.log(`   ✅ Correctly blocked: "${err.message}"`);
      if (!err.message.includes(sku450)) {
        throw new Error(`Expected error message to mention SKU ${sku450}, got "${err.message}"`);
      }
    }
    if (!tc3Blocked) {
      throw new Error('FAIL: APPAM 450G was able to borrow stock from APPAM 900G!');
    }
    console.log(`   ✅ Strict SKU identity verified: APPAM 450G did not borrow stock from APPAM 900G`);

    // -------------------------------------------------------------------------
    // TEST CASE 4: Scope Isolation: Super Admin vs Franchise
    // -------------------------------------------------------------------------
    console.log('\n--- TEST CASE 4: Scope Isolation (Super Admin / HQ vs Franchise) ---');
    const franchiseBranch = await prisma.franchise.create({
      data: {
        name: `Test Branch ${suffix}`,
        isHQ: false,
        location: 'Branch City',
        ownerName: 'Branch Owner',
        contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      }
    });
    createdFranchiseIds.push(franchiseBranch.id);

    const custBranch = await prisma.customer.create({
      data: {
        name: `Branch Customer ${suffix}`,
        phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
        franchiseId: franchiseBranch.id,
      }
    });
    createdCustomerIds.push(custBranch.id);

    const prodIsoSku = `FG-ISO-${suffix}`;
    const prodIso = await prisma.product.create({
      data: { name: `Isolated Product ${suffix}`, sku: prodIsoSku, basePrice: 100, taxPercent: 5 }
    });
    createdProductIds.push(prodIso.id);

    // HQ has 20 in stock
    const invHq = await prisma.inventoryItem.create({
      data: { name: prodIso.name, sku: prodIsoSku, category: 'FINISHED_GOOD', unit: 'PCS', currentStock: 0, franchiseId: null }
    });
    createdInventoryItemIds.push(invHq.id);
    await InventoryService.stockIn({ itemId: invHq.id, quantity: 20, note: 'HQ stock', userId: 'tester' });

    // Franchise has 0 in stock
    const invFranchise = await prisma.inventoryItem.create({
      data: { name: prodIso.name, sku: prodIsoSku, category: 'FINISHED_GOOD', unit: 'PCS', currentStock: 0, franchiseId: franchiseBranch.id }
    });
    createdInventoryItemIds.push(invFranchise.id);

    // Create DC in Franchise branch for 5 PCS -> MUST SUCCEED with 0 stock
    const dcBranch = await SalesService.createDeliveryChallan({
      customerId: custBranch.id,
      sourceFranchiseId: franchiseBranch.id,
      status: 'IN_TRANSIT',
      items: [{ productId: prodIso.id, productName: prodIso.name, quantity: 5, rate: 100 }]
    } as any, 'tester');
    createdChallanIds.push(dcBranch.id);
    await SalesService.markChallanDelivered(dcBranch.id, { receivedBy: 'Branch Receiver' }, 'tester');
    console.log(`   ✅ Franchise Delivery Challan created and delivered successfully`);

    // Convert to Sale Invoice in Franchise -> MUST FAIL because Franchise has 0 stock, even though HQ has 20!
    let tc4Blocked = false;
    try {
      await FinanceService.createInvoice({
        franchiseId: franchiseBranch.id,
        customerId: custBranch.id,
        partyType: 'CUSTOMER',
        partyId: custBranch.id,
        sourceDeliveryChallanId: dcBranch.id,
        items: [{ productId: prodIso.id, productName: prodIso.name, quantity: 5, rate: 100 }]
      });
    } catch (err: any) {
      tc4Blocked = true;
      console.log(`   ✅ Franchise sale correctly BLOCKED despite HQ having stock: "${err.message}"`);
    }
    if (!tc4Blocked) {
      throw new Error('FAIL: Franchise was able to use Super Admin / HQ stock!');
    }
    console.log(`   ✅ Scope isolation verified: Franchise inventory remains completely separate from HQ`);

    // =========================================================================
    // TEST CASE 5: Available Stock Formula (currentStock - blockedStock)
    // =========================================================================
    console.log('\n--- TEST CASE 5: Available Stock Formula with Blocked/Quarantined Stock ---');
    const skuFormula = `FG-FORMULA-${suffix}`;
    const prodFormula = await prisma.product.create({
      data: {
        name: `Formula Product ${suffix}`,
        sku: skuFormula,
        basePrice: 120,
        taxPercent: 5,
        productType: 'FINISHED_GOOD'
      }
    });
    createdProductIds.push(prodFormula.id);

    // Create item with currentStock = 10
    const invFormula = await prisma.inventoryItem.create({
      data: {
        name: prodFormula.name,
        sku: skuFormula,
        category: 'FINISHED_GOOD',
        currentStock: 10,
        unit: 'PCS',
        franchiseId: null
      }
    });
    createdInventoryItemIds.push(invFormula.id);

    // Add an APPROVED batch of 6 units
    const batchApproved = await prisma.inventoryBatch.create({
      data: {
        inventoryItemId: invFormula.id,
        batchNumber: `LOT-APPROVED-${suffix}`,
        initialQty: 6,
        currentQty: 6,
        status: 'APPROVED'
      }
    });

    // Add a BLOCKED batch of 4 units (Total 6 approved + 4 blocked = 10 stock)
    const batchBlocked = await prisma.inventoryBatch.create({
      data: {
        inventoryItemId: invFormula.id,
        batchNumber: `LOT-BLOCKED-${suffix}`,
        initialQty: 4,
        currentQty: 4,
        status: 'BLOCKED'
      }
    });

    // DC for 8 units is created and delivered successfully (DC does not block on stock)
    const dcFormula = await SalesService.createDeliveryChallan({
      customerId: cust1.id,
      status: 'IN_TRANSIT',
      items: [{ productId: prodFormula.id, productName: prodFormula.name, quantity: 8, rate: 120 }]
    } as any, 'tester');
    createdChallanIds.push(dcFormula.id);
    await SalesService.markChallanDelivered(dcFormula.id, { receivedBy: 'Receiver' }, 'tester');
    console.log('   ✅ DC created and delivered for 8 PCS with 0 error');

    // Sale Invoice for 8 units: Available is 10 - 4 = 6 units -> MUST BLOCK!
    let tc5Blocked = false;
    try {
      await FinanceService.createInvoice({
        franchiseId: hq.id,
        customerId: cust1.id,
        partyType: 'CUSTOMER',
        partyId: cust1.id,
        sourceDeliveryChallanId: dcFormula.id,
        items: [{ productId: prodFormula.id, productName: prodFormula.name, quantity: 8, rate: 120 }]
      });
    } catch (err: any) {
      tc5Blocked = true;
      console.log(`   ✅ Correctly blocked sale for 8 PCS when available is 6 (10 current - 4 blocked): "${err.message}"`);
      if (!err.message.includes('Available: 6') || !err.message.includes('Required: 8')) {
        throw new Error(`Expected error to state Available: 6 PCS, Required: 8 PCS, but got: "${err.message}"`);
      }
    }
    if (!tc5Blocked) {
      throw new Error('FAIL: Sale invoice should have been blocked because 4 units were blocked/quarantined!');
    }

    // Sale Invoice for 5 units: Available is 6 -> MUST SUCCEED!
    const saleFormula: any = await FinanceService.createInvoice({
      franchiseId: hq.id,
      customerId: cust1.id,
      partyType: 'CUSTOMER',
      partyId: cust1.id,
      items: [{ productId: prodFormula.id, productName: prodFormula.name, quantity: 5, rate: 120 }]
    });
    createdOrderIds.push(saleFormula.orderId || saleFormula.order?.id);

    const invAfterFormula = await prisma.inventoryItem.findUnique({ where: { id: invFormula.id } });
    console.log(`   ✅ Sale Invoice for 5 PCS succeeded. Stock correctly decremented from 10 to ${invAfterFormula?.currentStock}`);
    if (invAfterFormula?.currentStock !== 5) {
      throw new Error(`FAIL: Expected currentStock to be 5, but got: ${invAfterFormula?.currentStock}`);
    }

    // Clean up the batches
    await prisma.inventoryBatch.deleteMany({ where: { id: { in: [batchBlocked.id, batchApproved.id] } } });

    console.log('\n=================================================================');
    console.log('🎉 ALL 5 DELIVERY CHALLAN & INVENTORY FLOW TEST CASES PASSED!');
    console.log('=================================================================');

  } catch (e: any) {
    console.error('\n❌ TEST FAILED:', e);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main().then(() => {
  if (process.exitCode) process.exit(process.exitCode);
});
