import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { areUnitsEquivalent, normalizeUnit, convertUnit } from '../../lib/conversion';

async function runValidation() {
  console.log('====================================================');
  console.log('🧪 RUNNING END-TO-END DC -> SALE INVOICE UNIT VALIDATION');
  console.log('====================================================\n');

  // 1. Test Unit Normalization helpers directly
  console.log('--- 1. Testing Unit Normalization & Equivalence Engine ---');
  if (!areUnitsEquivalent('PC', 'PCS')) throw new Error('FAIL: PC and PCS must be equivalent');
  if (!areUnitsEquivalent('Pcs', 'pc')) throw new Error('FAIL: Pcs and pc must be equivalent');
  if (!areUnitsEquivalent('pcs', 'PIECES')) throw new Error('FAIL: pcs and PIECES must be equivalent');
  if (!areUnitsEquivalent('kg', 'KGS')) throw new Error('FAIL: kg and KGS must be equivalent');
  if (!areUnitsEquivalent('g', 'GRM')) throw new Error('FAIL: g and GRM must be equivalent');
  if (!areUnitsEquivalent('packet', 'PKT')) throw new Error('FAIL: packet and PKT must be equivalent');
  if (areUnitsEquivalent('PCS', 'KG')) throw new Error('FAIL: PCS and KG must NOT be equivalent');
  if (convertUnit(5, 'PC', 'PCS') !== 5) throw new Error('FAIL: 1:1 conversion between PC and PCS expected');
  if (convertUnit(2, 'KG', 'g') !== 2000) throw new Error('FAIL: 2 KG should be 2000 g');
  console.log('   ✅ All unit normalization and equivalence checks passed!\n');

  // 2. Real DB test for APPAM (SKU: FG-APPA-450G)
  console.log('--- 2. Testing with REAL APPAM record from Database ---');
  const appamProd = await prisma.product.findFirst({
    where: { sku: 'FG-APPA-450G' }
  });
  if (!appamProd) throw new Error('APPAM product not found in DB');

  const appamInv = await prisma.inventoryItem.findFirst({
    where: { sku: 'FG-APPA-450G', franchiseId: null }
  });
  if (!appamInv) throw new Error('APPAM HQ inventory item not found in DB');

  console.log(`   Product: ${appamProd.name} (SKU: ${appamProd.sku})`);
  console.log(`   Inventory Item ID: ${appamInv.id}, Stock Unit: "${appamInv.unit}", Current Stock: ${appamInv.currentStock}`);

  // Test convertUnitToBase with "PCS" against item that has unit "PC"
  const convResult = await InventoryService.convertUnitToBase(appamInv.id, 'PCS', 1);
  console.log('   convertUnitToBase("PCS", 1) result:', convResult);
  if (convResult.requiredBaseQty !== 1) throw new Error('FAIL: requiredBaseQty should be 1');
  console.log('   ✅ convertUnitToBase cleanly resolved "PCS" to "PC" with 1:1 multiplier!\n');

  // 3. Test real Sale Invoice creation with APPAM using unit: "PCS"
  console.log('--- 3. Testing Sale Invoice Creation with APPAM (Stock Unit: PC, Invoice Unit: PCS) ---');
  const customer = await prisma.customer.findFirst({
    where: { OR: [{ franchiseId: null }, { franchise: { isHQ: true } }] }
  }) || await prisma.customer.create({
    data: { name: 'Test DC Customer', phone: '9998887770', state: 'Mizoram', franchiseId: null }
  });

  const stockBefore = appamInv.currentStock;
  const testQty = 1;

  const saleInvoice = await FinanceService.createInvoice({
    customerId: customer.id,
    partyType: 'CUSTOMER',
    partyId: customer.id,
    franchiseId: 'root-franchise',
    paymentType: 'CASH',
    receivedAmount: 0,
    items: [{
      productId: appamProd.id,
      productName: appamProd.name,
      quantity: testQty,
      unit: 'PCS', // Mismatched unit from UI dropdown / Delivery Challan
      price: 35,
      taxPercent: 5
    }]
  });

  console.log(`   Created Sale Invoice: ${saleInvoice.invoiceNumber}`);
  const appamInvAfter = await prisma.inventoryItem.findUnique({ where: { id: appamInv.id } });
  console.log(`   Stock Before: ${stockBefore} ${appamInv.unit}, Stock After: ${appamInvAfter?.currentStock} ${appamInv.unit}`);
  if ((appamInvAfter?.currentStock ?? 0) !== stockBefore - testQty) {
    throw new Error(`FAIL: Expected stock to decrement by ${testQty}, got ${appamInvAfter?.currentStock}`);
  }
  console.log('   ✅ Sale Invoice successfully created and exactly 1 unit deducted!\n');

  // 4. Test Over-quantity Stock Blocking (Stock Validation STILL WORKS)
  console.log('--- 4. Testing Over-quantity Stock Blocking (Stock Validation Intact) ---');
  let blocked = false;
  try {
    await FinanceService.createInvoice({
      customerId: customer.id,
      partyType: 'CUSTOMER',
      partyId: customer.id,
      franchiseId: 'root-franchise',
      paymentType: 'CASH',
      receivedAmount: 0,
      items: [{
        productId: appamProd.id,
        productName: appamProd.name,
        quantity: 999999, // Way more than available stock
        unit: 'PCS',
        price: 35,
        taxPercent: 5
      }]
    });
  } catch (err: any) {
    blocked = true;
    console.log(`   Successfully caught expected stock block error: "${err.message}"`);
    if (!err.message.includes('Insufficient stock')) {
      throw new Error(`FAIL: Unexpected error message: ${err.message}`);
    }
  }
  if (!blocked) throw new Error('FAIL: Over-quantity sale was not blocked!');
  console.log('   ✅ Stock validation correctly blocked invoice creation when requested > available!\n');

  // 5. Test another product: ALL IN ONE BLEND (SKU: FG-ALLI-250G, unit: PC)
  console.log('--- 5. Testing Generic Validation with ALL IN ONE BLEND ---');
  const blendProd = await prisma.product.findFirst({ where: { sku: 'FG-ALLI-250G' } });
  const blendInv = await prisma.inventoryItem.findFirst({ where: { sku: 'FG-ALLI-250G', franchiseId: null } });
  if (blendProd && blendInv) {
    console.log(`   Product: ${blendProd.name}, Stock Unit: "${blendInv.unit}", Stock: ${blendInv.currentStock}`);
    const blendConv = await InventoryService.convertUnitToBase(blendInv.id, 'PCS', 2);
    if (blendConv.requiredBaseQty !== 2) throw new Error('FAIL: ALL IN ONE BLEND requiredBaseQty should be 2');
    console.log('   ✅ ALL IN ONE BLEND successfully converted "PCS" to "PC" with 1:1 factor!\n');
  }

  // 6. Test Delivery Challan -> Convert to Sale Flow
  console.log('--- 6. Testing Full Delivery Challan -> Convert to Sale Flow ---');
  // Create a Delivery Challan with APPAM (unit: PCS)
  const dc = await prisma.deliveryChallan.create({
    data: {
      challanNumber: `DC-TEST-${Date.now()}`,
      customerId: customer.id,
      sourceFranchiseId: 'root-franchise',
      status: 'CLOSED', // Marked delivered
      stateOfSupply: 'Mizoram',
      subTotal: 35,
      taxAmount: 1.75,
      totalAmount: 36.75,
      items: {
        create: [{
          productId: appamProd.id,
          productName: appamProd.name,
          quantity: 2,
          unit: 'PCS',
          rate: 35,
          taxPercent: 5,
          taxAmount: 1.75,
          totalAmount: 36.75
        }]
      }
    },
    include: { items: true }
  });

  console.log(`   Created test Delivery Challan: ${dc.challanNumber} (Status: ${dc.status}, Item: APPAM, Qty: 2 PCS)`);

  // Direct conversion test via SalesService.convertDeliveryChallanToSale
  const convSaleResult = await SalesService.convertDeliveryChallanToSale(dc.id);
  console.log(`   Converted DC to Sale Order #${convSaleResult.sale.invoiceNum}`);
  if (!convSaleResult.success) throw new Error('FAIL: convertDeliveryChallanToSale failed');
  console.log('   ✅ Direct DC -> Sale conversion succeeded with 0 errors!\n');

  console.log('🎉 ALL END-TO-END TESTS PASSED SUCCESSFULLY!');
}

runValidation()
  .catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
