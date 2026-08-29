import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';

async function runPhase2BFinalVerification() {
  console.log('====================================================');
  console.log('🧪 PHASE 2B.1 + 2B.2 — FINAL REPORT GAPS VERIFICATION');
  console.log('====================================================\n');

  let failures = 0;
  const testId = `P2B_${Date.now()}`;

  let createdFranchiseId: string | null = null;
  let createdItemId: string | null = null;
  let createdCustomerId: string | null = null;
  let createdOrderId: string | null = null;

  try {
    // 1. Setup Test Master Data
    console.log('1️⃣ Setting up Stock Summary & GSTR-1 Test Master Data...');
    const franchise = await prisma.franchise.create({
      data: {
        name: `P2B Franchise ${testId}`,
        location: 'Karnataka',
        ownerName: 'Owner',
        contactNum: '9999911111',
        isHQ: false
      }
    });
    createdFranchiseId = franchise.id;

    // Create item with customerPrice (Selling Price) = ₹100, costPrice (Avg Cost) = ₹75, stock = 25
    const item = await prisma.inventoryItem.create({
      data: {
        name: `P2B Product ${testId}`,
        sku: `SKU-P2B-${testId}`,
        category: 'FINISHED_GOOD',
        unit: 'KG',
        costPrice: 75,
        customerPrice: 100,
        currentStock: 25,
        franchiseId: franchise.id
      }
    });
    createdItemId = item.id;

    // Create B2B Sale Order with Customer Name & GST details
    const order = await prisma.order.create({
      data: {
        invoiceNum: `INV-${testId}`,
        franchiseId: franchise.id,
        customerName: `P2B B2B Customer ${testId}`,
        status: 'COMPLETED',
        subTotal: 1000,
        discountAmount: 0,
        taxAmount: 50,
        totalAmount: 1050,
        stateOfSupply: 'Karnataka',
        paymentType: 'CASH',
        paymentStatus: 'PAID'
      }
    });
    createdOrderId = order.id;

    // 2. Verify Phase 2B.1 — Stock Summary Selling Price & Potential Margin
    console.log('\n2️⃣ Testing Phase 2B.1 — Stock Summary Selling Price & Potential Margin...');
    const stockSummary = await FinanceService.getStockSummaryByItemData(franchise.id);
    const stockRow = stockSummary.find((s: any) => s.id === item.id);

    console.log(`   Stock Row -> SKU: ${stockRow?.sku}, Stock: ${stockRow?.currentStock}, Avg Cost: ₹${stockRow?.costPrice}, Selling Price: ₹${stockRow?.sellingPrice}`);
    console.log(`   Stock Value: ₹${stockRow?.stockValue} (Exp: ₹1875.00)`);
    console.log(`   Potential Retail Value: ₹${stockRow?.potentialRetailValue} (Exp: ₹2500.00)`);
    console.log(`   Potential Margin: ₹${stockRow?.potentialMargin} (Exp: ₹625.00)`);

    if (
      stockRow &&
      stockRow.costPrice === 75 &&
      stockRow.sellingPrice === 100 &&
      stockRow.stockValue === 1875 &&
      stockRow.potentialRetailValue === 2500 &&
      stockRow.potentialMargin === 625
    ) {
      console.log('   ✅ PASS: Stock Summary surfaces Selling Price ₹100, Potential Retail Value ₹2,500, and Potential Margin ₹625!');
    } else {
      console.error('   ❌ FAIL: Stock Summary calculations mismatch!');
      failures++;
    }

    // 3. Verify Phase 2B.2 — GSTR-1 CSV GSTIN & Place of Supply
    console.log('\n3️⃣ Testing Phase 2B.2 — GSTR-1 CSV Customer GSTIN & Place of Supply...');
    const gstr1 = await FinanceService.getGSTR1Data(franchise.id);
    const saleRow = gstr1.sale.find((r: any) => r.invoiceNo === order.invoiceNum);

    console.log(`   GSTR-1 Row -> Invoice: ${saleRow?.invoiceNo}, Customer GSTIN: ${saleRow?.customerGstin}, Type: ${saleRow?.b2bType}, POS: ${saleRow?.placeOfSupply}`);
    console.log(`   Taxable Value: ₹${saleRow?.taxableValue}, CGST: ₹${saleRow?.cgst}, SGST: ₹${saleRow?.sgst}, IGST: ₹${saleRow?.igst}`);

    if (
      saleRow &&
      saleRow.placeOfSupply === 'Karnataka' &&
      saleRow.taxableValue === 1000 &&
      saleRow.cgst === 25 &&
      saleRow.sgst === 25 &&
      saleRow.igst === 0
    ) {
      console.log('   ✅ PASS: GSTR-1 surfaces Taxable Value ₹1000, Tax Split (CGST ₹25, SGST ₹25), and Place of Supply (Karnataka)!');
    } else {
      console.error('   ❌ FAIL: GSTR-1 field alignment mismatch!');
      failures++;
    }

  } catch (err: any) {
    console.error('❌ Exception during Phase 2B final verification:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up test master data...');
    try {
      if (createdOrderId) await prisma.order.delete({ where: { id: createdOrderId } });
      if (createdItemId) await prisma.inventoryItem.delete({ where: { id: createdItemId } });
      if (createdFranchiseId) await prisma.franchise.delete({ where: { id: createdFranchiseId } });
      console.log('   ✅ Test master data cleaned up.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n====================================================');
  if (failures === 0) {
    console.log('🎉 PHASE 2B.1 + 2B.2 FINAL ACCEPTANCE PASSED! 🎉');
  } else {
    console.error(`💥 ${failures} PHASE 2B TEST(S) FAILED.`);
    process.exit(1);
  }
}

runPhase2BFinalVerification()
  .catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
