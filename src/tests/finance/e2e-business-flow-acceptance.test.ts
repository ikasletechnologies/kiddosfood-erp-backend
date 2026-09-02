import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { IsolationUtil } from '../../utils/isolation.util';
import { SettingsService } from '../../modules/settings/settings.service';

async function runEndToEndAcceptanceTest() {
  console.log('====================================================');
  console.log('🚀 REPORTS MODULE — END-TO-END BUSINESS ACCEPTANCE TEST');
  console.log('====================================================\n');

  const testId = `TEST_E2E_${Date.now()}`;
  let failures = 0;

  // Track created entities for cleanup
  let createdFranchiseId: string | null = null;
  let createdVendorId: string | null = null;
  let createdProductAId: string | null = null;
  let createdProductBId: string | null = null;
  let createdRawMaterialId: string | null = null;
  let createdItemAId: string | null = null;
  let createdItemRMId: string | null = null;
  const createdOrderIds: string[] = [];
  const createdPoIds: string[] = [];
  const createdVendorInvoiceIds: string[] = [];

  // Seller-state jurisdiction (CGST+SGST vs IGST) resolves from the single
  // real SettingsService.getCompanyProfile().state, NOT from Franchise.location
  // — Franchise has no structured state/GSTIN field, by design (one GST
  // registration serving all franchises). This test used to hardcode
  // 'Maharashtra'/'Gujarat' stateOfSupply values as if the test franchise's
  // free-text `location` were the seller state, while the real company
  // profile could be configured to any other state (e.g. 'Tamil Nadu') —
  // which made every transaction here classify as inter-state (all IGST)
  // regardless of intent. Temporarily pointing the real company profile at
  // 'Maharashtra' for the duration of this test — and restoring it
  // afterwards — is the same pattern already used correctly in
  // gstr3b-regression.script.ts / gstr9-regression.script.ts.
  const originalCompanyProfileSetting = await prisma.systemSetting.findUnique({ where: { key: 'COMPANY_PROFILE' } });

  try {
    await SettingsService.updateCompanyProfile({
      ...(JSON.parse(originalCompanyProfileSetting?.value || '{}')),
      state: 'Maharashtra'
    });

    // 1. SETUP: Create Test Franchise
    console.log('1️⃣ Setting up controlled test master data...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `E2E Test HQ ${testId}`,
        location: 'Maharashtra',
        ownerName: 'Test Owner',
        contactNum: '9999999999',
        isHQ: false
      }
    });
    createdFranchiseId = franchise.id;
    console.log(`   - Created Franchise: ${franchise.name} (Location: ${franchise.location})`);

    // Create Test Vendor
    const vendor = await prisma.vendor.create({
      data: {
        name: `E2E Test Vendor ${testId}`,
        contact: '8888888888',
        state: 'Gujarat',
        address: 'Ahmedabad, Gujarat'
      }
    });
    createdVendorId = vendor.id;
    console.log(`   - Created Vendor: ${vendor.name} (State: Gujarat)`);

    // Create Test Products
    const productA = await prisma.product.create({
      data: {
        name: `E2E Prod A ${testId}`,
        hsnCode: 'HSN-1001',
        basePrice: 100,
        taxPercent: 5,
        category: 'FINISHED_GOOD'
      }
    });
    createdProductAId = productA.id;

    const productB = await prisma.product.create({
      data: {
        name: `E2E Prod B ${testId}`,
        hsnCode: 'HSN-1002',
        basePrice: 200,
        taxPercent: 12,
        category: 'FINISHED_GOOD'
      }
    });
    createdProductBId = productB.id;

    // Create Test Inventory Items
    const itemA = await prisma.inventoryItem.create({
      data: {
        name: productA.name,
        sku: `SKU-A-${testId}`,
        category: 'FINISHED_GOOD',
        unit: 'KG',
        hsnCode: productA.hsnCode,
        gstRate: 5,
        currentStock: 50,
        minimumStock: 10,
        franchiseId: franchise.id,
        costPrice: 60,
        customerPrice: 100
      }
    });
    createdItemAId = itemA.id;

    const itemRM = await prisma.inventoryItem.create({
      data: {
        name: `Raw Material X ${testId}`,
        sku: `SKU-RM-${testId}`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        hsnCode: 'HSN-2001',
        gstRate: 5,
        currentStock: 0,
        minimumStock: 20,
        franchiseId: franchise.id,
        costPrice: 50,
        customerPrice: 80
      }
    });
    createdItemRMId = itemRM.id;

    console.log('   - Created 2 Finished Goods & 1 Raw Material Item.');

    // 2. TRANSACTIONS CREATION
    console.log('\n2️⃣ Creating Controlled Source Transactions...');

    const today = new Date();
    const startDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    // --- Transaction A: Intrastate Sale (Maharashtra -> Maharashtra) ---
    // Item A: 2 @ ₹100 = ₹200 (Tax @ 5% = ₹10)
    // Item B: 1 @ ₹200 = ₹200 (Tax @ 12% = ₹24)
    // Total Subtotal = ₹400, Total Tax = ₹34, Total Amount = ₹434
    // Jurisdiction Split: CGST = ₹17, SGST = ₹17, IGST = ₹0
    const orderIntra = await prisma.order.create({
      data: {
        invoiceNum: `INV-INTRA-${testId}`,
        franchiseId: franchise.id,
        orderType: 'POS',
        status: 'COMPLETED',
        subTotal: 400,
        taxAmount: 34,
        discountAmount: 0,
        totalAmount: 434,
        paymentStatus: 'PAID',
        paymentType: 'CASH',
        stateOfSupply: 'Maharashtra',
        createdAt: new Date(),
        orderItems: {
          create: [
            {
              productId: productA.id,
              quantity: 2,
              price: 100,
              taxAmount: 10,
              totalAmount: 210
            },
            {
              productId: productB.id,
              quantity: 1,
              price: 200,
              taxAmount: 24,
              totalAmount: 224
            }
          ]
        }
      }
    });
    createdOrderIds.push(orderIntra.id);

    // Add stock movement for OrderIntra
    await prisma.stockMovement.create({
      data: {
        itemId: itemA.id,
        movementType: 'SALES_OUT',
        quantity: -2,
        referenceType: 'POS_ORDER',
        referenceId: orderIntra.id,
        note: 'Intrastate POS Sale'
      }
    });

    console.log(`   - Transaction A (Intrastate Sale): Order ${orderIntra.invoiceNum} (Subtotal: ₹400, CGST: ₹17, SGST: ₹17, IGST: ₹0)`);

    // --- Transaction B: Interstate Sale (Maharashtra -> Gujarat) ---
    // Item A: 1 @ ₹100 = ₹100 (Tax @ 5% = ₹5)
    // Item B: 2 @ ₹200 = ₹400 (Tax @ 12% = ₹48)
    // Total Subtotal = ₹500, Total Tax = ₹53, Total Amount = ₹553
    // Jurisdiction Split: CGST = ₹0, SGST = ₹0, IGST = ₹53
    const orderInter = await prisma.order.create({
      data: {
        invoiceNum: `INV-INTER-${testId}`,
        franchiseId: franchise.id,
        orderType: 'DINE_IN',
        status: 'COMPLETED',
        subTotal: 500,
        taxAmount: 53,
        discountAmount: 0,
        totalAmount: 553,
        paymentStatus: 'PAID',
        paymentType: 'UPI',
        stateOfSupply: 'Gujarat',
        createdAt: new Date(),
        orderItems: {
          create: [
            {
              productId: productA.id,
              quantity: 1,
              price: 100,
              taxAmount: 5,
              totalAmount: 105
            },
            {
              productId: productB.id,
              quantity: 2,
              price: 200,
              taxAmount: 48,
              totalAmount: 448
            }
          ]
        }
      }
    });
    createdOrderIds.push(orderInter.id);

    // Add stock movement for OrderInter
    await prisma.stockMovement.create({
      data: {
        itemId: itemA.id,
        movementType: 'SALES_OUT',
        quantity: -1,
        referenceType: 'POS_ORDER',
        referenceId: orderInter.id,
        note: 'Interstate Sale'
      }
    });

    console.log(`   - Transaction B (Interstate Sale): Order ${orderInter.invoiceNum} (Subtotal: ₹500, CGST: ₹0, SGST: ₹0, IGST: ₹53)`);

    // --- Transaction C: Purchase Order / Procurement ---
    // Raw Material X: 100 units @ ₹50 = Subtotal ₹5,000, IGST = ₹250, Total = ₹5,250
    const po = await prisma.procurementOrder.create({
      data: {
        poNumber: `PO-${testId}`,
        vendorId: vendor.id,
        franchiseId: franchise.id,
        status: 'APPROVED',
        subtotal: 5000,
        cgst: 0,
        sgst: 0,
        igst: 250,
        totalAmount: 5250,
        paid: 5250,
        paymentStatus: 'PAID',
        received: true
      }
    });
    createdPoIds.push(po.id);

    // GSTR-2/GSTR-3B ITC is sourced from VendorInvoice (the Purchase Bill),
    // never from ProcurementOrder directly — a PO/GRN with no bill against
    // it must not create GST entries (see gstr3b-regression.script.ts CASE
    // 8/9). A ProcurementOrder alone here previously left Input Tax at a
    // correct-but-unexpected ₹0; a real Purchase Bill is required to
    // exercise the ₹250 ITC this transaction is meant to represent.
    const vendorInvoice = await prisma.vendorInvoice.create({
      data: {
        vendorId: vendor.id,
        poId: po.id,
        invoiceNumber: `VINV-${testId}`,
        amount: 5250,
        status: 'PAID',
        billDate: new Date(),
        subtotal: 5000,
        taxAmount: 250,
        cgst: 0,
        sgst: 0,
        igst: 250
      }
    });
    createdVendorInvoiceIds.push(vendorInvoice.id);

    // Stock Movement for Purchase In
    await prisma.stockMovement.create({
      data: {
        itemId: itemRM.id,
        movementType: 'PURCHASE_IN',
        quantity: 100,
        referenceType: 'PROCUREMENT_PO',
        referenceId: po.id,
        note: 'Raw Material Receipt'
      }
    });

    console.log(`   - Transaction C (Procurement Purchase): PO ${po.poNumber} (Subtotal: ₹5,000, Input IGST: ₹250)`);

    // Update itemRM currentStock to match receipt
    await prisma.inventoryItem.update({
      where: { id: itemRM.id },
      data: { currentStock: 100 }
    });

    // Update itemA currentStock to match sales (50 - 3 = 47)
    await prisma.inventoryItem.update({
      where: { id: itemA.id },
      data: { currentStock: 47 }
    });

    // 3. RECONCILIATION VERIFICATION
    console.log('\n3️⃣ RECONCILING REPORTS AGAINST SOURCE TRANSACTIONS...\n');

    // A. GSTR-3B Verification
    console.log('--- A. GSTR-3B Tax Report Verification ---');
    const gstr3b = await FinanceService.getGSTR3BData(franchise.id, startDate.toISOString(), endDate.toISOString());
    const outward = gstr3b.outwardSupplies[0];

    console.log('   Expected Output Taxable: ₹900.00 | Actual: ₹' + outward.taxableValue);
    console.log('   Expected Output IGST:    ₹53.00  | Actual: ₹' + outward.igst);
    console.log('   Expected Output CGST:    ₹17.00  | Actual: ₹' + outward.cgst);
    console.log('   Expected Output SGST:    ₹17.00  | Actual: ₹' + outward.sgst);
    console.log('   Expected Total Input Tax: ₹250.00 | Actual: ₹' + gstr3b.summary.totalInputTax);

    if (
      outward.taxableValue === 900 &&
      outward.igst === 53 &&
      outward.cgst === 17 &&
      outward.sgst === 17 &&
      gstr3b.summary.totalInputTax === 250
    ) {
      console.log('   ✅ PASS: GSTR-3B Tax Breakdown perfectly matches source transactions!');
    } else {
      console.error('   ❌ FAIL: GSTR-3B totals do not match expected transaction values!');
      failures++;
    }

    // B. HSN Summary Verification
    console.log('\n--- B. HSN Summary Report Verification ---');
    const hsnData = await FinanceService.getHsnSummaryData(franchise.id, startDate.toISOString(), endDate.toISOString());
    
    const hsn1001 = hsnData.find(h => h.hsn === 'HSN-1001');
    const hsn1002 = hsnData.find(h => h.hsn === 'HSN-1002');

    console.log('   HSN-1001 -> Taxable: ₹' + hsn1001?.taxableValue + ' (Exp: ₹300), IGST: ₹' + hsn1001?.igstAmount + ' (Exp: ₹5), CGST: ₹' + hsn1001?.cgstAmount + ' (Exp: ₹5), SGST: ₹' + hsn1001?.sgstAmount + ' (Exp: ₹5)');
    console.log('   HSN-1002 -> Taxable: ₹' + hsn1002?.taxableValue + ' (Exp: ₹600), IGST: ₹' + hsn1002?.igstAmount + ' (Exp: ₹48), CGST: ₹' + hsn1002?.cgstAmount + ' (Exp: ₹12), SGST: ₹' + hsn1002?.sgstAmount + ' (Exp: ₹12)');

    if (
      hsn1001 && hsn1001.taxableValue === 300 && hsn1001.igstAmount === 5 && hsn1001.cgstAmount === 5 && hsn1001.sgstAmount === 5 &&
      hsn1002 && hsn1002.taxableValue === 600 && hsn1002.igstAmount === 48 && hsn1002.cgstAmount === 12 && hsn1002.sgstAmount === 12
    ) {
      console.log('   ✅ PASS: HSN Summary per-line tax allocation & jurisdiction splits perfectly match source transactions!');
    } else {
      console.error('   ❌ FAIL: HSN Summary calculations do not match expected line values!');
      failures++;
    }

    // C. Stock Detail Reconciliation
    console.log('\n--- C. Stock Detail Reconciliation Verification ---');
    const stockDetail = await FinanceService.getStockDetailData(franchise.id, startDate.toISOString(), endDate.toISOString());
    const stockItemA = stockDetail.find(s => s.itemName === itemA.name);
    const stockItemRM = stockDetail.find(s => s.itemName === itemRM.name);

    console.log(`   Item A -> Beginning: ${stockItemA?.beginningQuantity} (Exp: 50), In: ${stockItemA?.quantityIn} (Exp: 0), Out: ${stockItemA?.quantityOut} (Exp: 3), Closing: ${stockItemA?.closingQuantity} (Exp: 47)`);
    console.log(`   Item RM -> Beginning: ${stockItemRM?.beginningQuantity} (Exp: 0), In: ${stockItemRM?.quantityIn} (Exp: 100), Out: ${stockItemRM?.quantityOut} (Exp: 0), Closing: ${stockItemRM?.closingQuantity} (Exp: 100)`);

    if (
      stockItemA && stockItemA.beginningQuantity + stockItemA.quantityIn - stockItemA.quantityOut === stockItemA.closingQuantity &&
      stockItemRM && stockItemRM.beginningQuantity + stockItemRM.quantityIn - stockItemRM.quantityOut === stockItemRM.closingQuantity
    ) {
      console.log('   ✅ PASS: Stock Detail Opening + In - Out = Closing identity verified!');
    } else {
      console.error('   ❌ FAIL: Stock Detail opening/closing reconciliation identity failed!');
      failures++;
    }

    // D. GSTR-1 Sales Register Verification
    console.log('\n--- D. GSTR-1 Outward Sales Register Verification ---');
    const gstr1 = await FinanceService.getGSTR1Data(franchise.id, startDate.toISOString(), endDate.toISOString());
    console.log(`   Retrieved ${gstr1.sale.length} invoices in GSTR-1 (Exp: 2 invoices).`);

    const invIntra = gstr1.sale.find(i => i.invoiceNo === orderIntra.invoiceNum);
    const invInter = gstr1.sale.find(i => i.invoiceNo === orderInter.invoiceNum);

    if (invIntra && invIntra.cgst === 17 && invIntra.sgst === 17 && invIntra.igst === 0 &&
        invInter && invInter.cgst === 0 && invInter.sgst === 0 && invInter.igst === 53) {
      console.log('   ✅ PASS: GSTR-1 Invoice-level jurisdiction tax amounts match source sales!');
    } else {
      console.error('   ❌ FAIL: GSTR-1 invoice breakdown mismatch!');
      failures++;
    }

    // E. HQ Scoping & Isolation Utility Test
    console.log('\n--- E. HQ Scoping & Role Access Test ---');
    const hqUserPayload = { role: 'SUPER_ADMIN', userId: 'test-hq-user' } as any;
    const franchiseUserPayload = { role: 'FRANCHISE_ADMIN', franchiseId: franchise.id, userId: 'test-branch-user' } as any;

    const hqFilter = IsolationUtil.getFranchiseFilter(hqUserPayload);
    const branchFilter = IsolationUtil.getFranchiseFilter(franchiseUserPayload);

    if (Object.keys(hqFilter).length === 0 && branchFilter.franchiseId === franchise.id) {
      console.log('   ✅ PASS: SUPER_ADMIN bypasses franchise filter while FRANCHISE_ADMIN remains isolated!');
    } else {
      console.error('   ❌ FAIL: Role filter isolation mismatch!');
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during acceptance test:', err);
    failures++;
  } finally {
    // 4. CLEANUP
    console.log('\n4️⃣ Cleaning up controlled test data...');
    try {
      if (createdOrderIds.length > 0) {
        await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      }
      if (createdVendorInvoiceIds.length > 0) {
        await prisma.vendorInvoice.deleteMany({ where: { id: { in: createdVendorInvoiceIds } } });
      }
      if (createdPoIds.length > 0) {
        await prisma.procurementOrder.deleteMany({ where: { id: { in: createdPoIds } } });
      }
      if (originalCompanyProfileSetting) {
        await prisma.systemSetting.update({ where: { key: 'COMPANY_PROFILE' }, data: { value: originalCompanyProfileSetting.value } }).catch(() => {});
      } else {
        await prisma.systemSetting.deleteMany({ where: { key: 'COMPANY_PROFILE' } }).catch(() => {});
      }
      if (createdItemAId || createdItemRMId) {
        await prisma.stockMovement.deleteMany({ where: { itemId: { in: [createdItemAId!, createdItemRMId!].filter(Boolean) } } });
        await prisma.inventoryItem.deleteMany({ where: { id: { in: [createdItemAId!, createdItemRMId!].filter(Boolean) } } });
      }
      if (createdProductAId || createdProductBId) {
        await prisma.product.deleteMany({ where: { id: { in: [createdProductAId!, createdProductBId!].filter(Boolean) } } });
      }
      if (createdVendorId) {
        await prisma.vendor.delete({ where: { id: createdVendorId } });
      }
      if (createdFranchiseId) {
        await prisma.franchise.delete({ where: { id: createdFranchiseId } });
      }
      console.log('   ✅ Test master data cleaned up cleanly.');
    } catch (cleanErr: any) {
      console.error('   ⚠️ Cleanup warning:', cleanErr.message);
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('🎉 FINAL E2E ACCEPTANCE GATE PASSED! 🎉');
    console.log('Source Transaction = Database = API = Report = PASS');
  } else {
    console.error(`💥 ${failures} E2E ACCEPTANCE TEST(S) FAILED.`);
    process.exit(1);
  }
}

runEndToEndAcceptanceTest()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
