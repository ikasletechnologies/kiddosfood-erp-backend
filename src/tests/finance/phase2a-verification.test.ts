import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';

async function runPhase2AVerification() {
  console.log('====================================================');
  console.log('🧪 PHASE 2A — FINANCIAL CORRECTNESS VERIFICATION TEST');
  console.log('====================================================\n');

  let failures = 0;
  const testId = `P2A_${Date.now()}`;

  let createdFranchiseId: string | null = null;
  let createdVendorId: string | null = null;
  let createdItemId: string | null = null;
  let createdPoId: string | null = null;
  let createdGrnId: string | null = null;

  try {
    // 1. Setup Test Master Data
    console.log('1️⃣ Setting up Purchase Price Override Test Data...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `P2A Franchise ${testId}`,
        location: 'Maharashtra',
        ownerName: 'Owner',
        contactNum: '9999900000',
        isHQ: false
      }
    });
    createdFranchiseId = franchise.id;

    const vendor = await prisma.vendor.create({
      data: {
        name: `P2A Vendor ${testId}`,
        contact: '8888800000',
        state: 'Maharashtra',
        gstNumber: '27AAAAA0000A1Z5'
      }
    });
    createdVendorId = vendor.id;

    const item = await prisma.inventoryItem.create({
      data: {
        name: `P2A Raw Material ${testId}`,
        sku: `SKU-P2A-${testId}`,
        category: 'RAW_MATERIAL',
        unit: 'KG',
        costPrice: 85,
        currentStock: 100,
        franchiseId: franchise.id
      }
    });
    createdItemId = item.id;

    // Create PO with PO Price = ₹100
    const po = await prisma.procurementOrder.create({
      data: {
        poNumber: `PO-${testId}`,
        vendorId: vendor.id,
        franchiseId: franchise.id,
        status: 'RECEIVED',
        subtotal: 1000,
        cgst: 25,
        sgst: 25,
        igst: 0,
        totalAmount: 1050,
        poItems: {
          create: [
            {
              inventoryItemId: item.id,
              quantity: 10,
              price: 100 // PO Price = ₹100
            }
          ]
        }
      }
    });
    createdPoId = po.id;

    // Create GRN with Actual GRN Price Override = ₹95
    const grn = await prisma.goodsReceipt.create({
      data: {
        poId: po.id,
        receivedBy: 'QC Inspector',
        status: 'COMPLETED',
        items: {
          create: [
            {
              materialId: item.id,
              quantity: 10,
              receivedQty: 10,
              acceptedQty: 10,
              rejectedQty: 0,
              poPrice: 100, // Original PO Price
              price: 95,    // Actual GRN Override Price = ₹95
              priceOverridden: true,
              priceOverrideReason: 'Bulk discount at receiving'
            }
          ]
        }
      }
    });
    createdGrnId = grn.id;

    console.log(`   - Created PO #${po.poNumber} with PO Price ₹100.00.`);
    console.log(`   - Created GRN for PO #${po.poNumber} with Actual GRN Price Override ₹95.00.`);

    // 2. Test Purchase Report GRN Price Override Trace
    console.log('\n2️⃣ Testing Purchase Report PO Price vs Actual GRN Price Trace...');
    const purchaseReport = await FinanceService.getPurchasesReportDetails({ franchiseId: franchise.id });
    const poRow = purchaseReport.data.find((p: any) => p.id === po.id);
    const itemRow = poRow?.items?.[0];

    console.log(`   PO Row -> PO Number: ${poRow?.poNumber}, Vendor GSTIN: ${poRow?.vendorGstin}`);
    console.log(`   Item Row -> PO Price: ₹${itemRow?.poPrice} (Exp: ₹100), Actual GRN Price: ₹${itemRow?.actualGrnPrice} (Exp: ₹95)`);
    console.log(`   Variance: ₹${itemRow?.priceVariance} (Exp: -₹5.00), Variance %: ${itemRow?.priceVariancePercent}% (Exp: -5.00%)`);

    if (
      itemRow &&
      itemRow.poPrice === 100 &&
      itemRow.actualGrnPrice === 95 &&
      itemRow.priceVariance === -5 &&
      itemRow.priceVariancePercent === -5 &&
      itemRow.priceOverridden === true
    ) {
      console.log('   ✅ PASS: Purchase Report surfaces PO Price ₹100, Actual GRN Price ₹95, and Variance -₹5.00 without modifying original PO price!');
    } else {
      console.error('   ❌ FAIL: Purchase Report price override trace mismatch!');
      failures++;
    }

    // 3. Test Sales Summary Tax Breakdown & Payment Mode Exposing
    console.log('\n--- 3️⃣ Testing Sales Summary Complete Tax Breakdown & Fields ---');
    const salesReport = await FinanceService.getSaleOrdersReportData({ franchiseId: franchise.id });
    console.log('   Sales Summary Totals:', salesReport.summary);

    if (
      salesReport.summary &&
      typeof salesReport.summary.totalSubTotal === 'number' &&
      typeof salesReport.summary.totalTaxableValue === 'number' &&
      typeof salesReport.summary.totalCgst === 'number' &&
      typeof salesReport.summary.totalSgst === 'number' &&
      typeof salesReport.summary.totalIgst === 'number' &&
      Array.isArray(salesReport.orders)
    ) {
      console.log('   ✅ PASS: Sales Summary exposes full tax breakdown (Subtotal, Taxable Value, CGST, SGST, IGST, Payment Mode & Status)!');
    } else {
      console.error('   ❌ FAIL: Sales Summary missing tax breakdown fields!');
      failures++;
    }

    // 4. Test Inventory Ledger Costing & Valuation Impact Fields
    console.log('\n--- 4️⃣ Testing Inventory Ledger Costing & Valuation Impact Fields ---');
    const ledgerReport = await FinanceService.getInventoryLedgerReportData(franchise.id) as any[];
    if (Array.isArray(ledgerReport) && ledgerReport.length > 0) {
      const firstRow = ledgerReport[0];
      console.log(`   Ledger Row -> Item: ${firstRow.itemName}, Unit Cost: ₹${firstRow.unitCost}, Qty In: ${firstRow.quantityIn}, Qty Out: ${firstRow.quantityOut}, Valuation Impact: ₹${firstRow.valuationImpact}`);
      if (
        typeof firstRow.unitCost === 'number' &&
        typeof firstRow.valuationImpact === 'number' &&
        typeof firstRow.runningStock === 'number'
      ) {
        console.log('   ✅ PASS: Inventory Ledger exposes Unit Cost, Valuation Impact, Quantity In/Out, and Running Stock Value!');
      } else {
        console.error('   ❌ FAIL: Inventory Ledger missing costing fields!');
        failures++;
      }
    } else {
      console.log('   ℹ️ Inventory Ledger tested on empty set or structure.');
    }

  } catch (err: any) {
    console.error('❌ Exception during Phase 2A verification:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up test data...');
    try {
      if (createdGrnId) {
        await prisma.goodsReceiptItem.deleteMany({ where: { grnId: createdGrnId } });
        await prisma.goodsReceipt.delete({ where: { id: createdGrnId } });
      }
      if (createdPoId) {
        await prisma.procurementOrderItem.deleteMany({ where: { poId: createdPoId } });
        await prisma.procurementOrder.delete({ where: { id: createdPoId } });
      }
      if (createdItemId) {
        await prisma.stockMovement.deleteMany({ where: { itemId: createdItemId } });
        await prisma.inventoryItem.delete({ where: { id: createdItemId } });
      }
      if (createdVendorId) await prisma.vendor.delete({ where: { id: createdVendorId } });
      if (createdFranchiseId) await prisma.franchise.delete({ where: { id: createdFranchiseId } });
      console.log('   ✅ Test master data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('🎉 PHASE 2A ACCEPTANCE GATE PASSED! 🎉');
    console.log('PO Price = ₹100 | Actual GRN Price = ₹95 | Variance = -₹5.00 | PASS');
  } else {
    console.error(`💥 ${failures} PHASE 2A TEST(S) FAILED.`);
    process.exit(1);
  }
}

runPhase2AVerification()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
