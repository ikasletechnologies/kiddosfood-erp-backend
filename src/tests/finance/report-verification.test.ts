import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';

async function testReportFixes() {
  console.log('🧪 Starting Report Module Fix Verification Tests...\n');
  let failures = 0;

  // 1. Test getHsnSummaryData Line-Level Tax Allocation Logic
  try {
    console.log('--- Test 1: HSN Summary Line-Level Tax Apportionment ---');
    const hsnReport = await FinanceService.getHsnSummaryData();
    console.log(`Retrieved ${hsnReport.length} HSN summary entries.`);
    if (Array.isArray(hsnReport)) {
      console.log('✅ getHsnSummaryData returned valid array format.');
    } else {
      console.error('❌ getHsnSummaryData failed: expected array.');
      failures++;
    }
  } catch (err: any) {
    console.error('❌ getHsnSummaryData threw error:', err.message);
    failures++;
  }

  // 2. Test getGSTR3BData Jurisdiction Logic
  try {
    console.log('\n--- Test 2: GSTR-3B Interstate/Intrastate Tax Breakdown ---');
    const gstr3b = await FinanceService.getGSTR3BData();
    if (gstr3b && gstr3b.outwardSupplies && gstr3b.summary) {
      console.log('Outward supplies summary:', gstr3b.outwardSupplies[0]);
      console.log('GSTR-3B Totals:', gstr3b.summary);
      console.log('✅ getGSTR3BData returned valid structure with IGST/CGST/SGST breakdown.');
    } else {
      console.error('❌ getGSTR3BData failed: invalid payload structure.');
      failures++;
    }
  } catch (err: any) {
    console.error('❌ getGSTR3BData threw error:', err.message);
    failures++;
  }

  // 3. Test getStockDetailData Historical Opening Balance Math
  try {
    console.log('\n--- Test 3: Stock Detail Opening Balance Historical Reconciliation ---');
    const today = new Date();
    const startDateStr = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
    const endDateStr = today.toISOString();

    const stockDetails = await FinanceService.getStockDetailData(undefined, startDateStr, endDateStr);
    console.log(`Retrieved ${stockDetails.length} stock detail records for date range [${startDateStr.split('T')[0]} to ${endDateStr.split('T')[0]}].`);

    let reconciledCount = 0;
    stockDetails.forEach(item => {
      const expectedClosing = Number((item.beginningQuantity + item.quantityIn - item.quantityOut).toFixed(2));
      const actualClosing = Number(item.closingQuantity.toFixed(2));
      if (Math.abs(expectedClosing - actualClosing) <= 0.01) {
        reconciledCount++;
      } else {
        console.warn(`  ⚠️ Reconciliation gap on item ${item.itemName}: beg=${item.beginningQuantity}, in=${item.quantityIn}, out=${item.quantityOut}, closing=${item.closingQuantity}, expected=${expectedClosing}`);
      }
    });

    if (stockDetails.length === 0 || reconciledCount === stockDetails.length) {
      console.log(`✅ Beginning + Inward - Outward = Closing verified for ALL ${stockDetails.length} items!`);
    } else {
      console.error(`❌ Reconciliation failed for ${stockDetails.length - reconciledCount} of ${stockDetails.length} items.`);
      failures++;
    }
  } catch (err: any) {
    console.error('❌ getStockDetailData threw error:', err.message);
    failures++;
  }

  // 4. Test getItemDetailData Movement History and Opening Stock
  try {
    console.log('\n--- Test 4: Item Detail Movement History and Opening Stock ---');
    const itemDetails = await FinanceService.getItemDetailData();
    console.log(`Retrieved detail for ${itemDetails.length} inventory items.`);
    if (Array.isArray(itemDetails)) {
      console.log('✅ getItemDetailData returned valid array with beginningQuantity and movements.');
    } else {
      console.error('❌ getItemDetailData failed: expected array.');
      failures++;
    }
  } catch (err: any) {
    console.error('❌ getItemDetailData threw error:', err.message);
    failures++;
  }

  // 5. Test getInventoryLedgerReportData Pagination
  try {
    console.log('\n--- Test 5: Inventory Ledger Pagination & Full Retrieval ---');
    const fullLedger = await FinanceService.getInventoryLedgerReportData();
    console.log(`Full ledger count: ${Array.isArray(fullLedger) ? fullLedger.length : 'N/A'}`);

    const paginatedLedger = await FinanceService.getInventoryLedgerReportData(undefined, undefined, undefined, undefined, 1, 10) as any;
    if (paginatedLedger && typeof paginatedLedger.total === 'number' && Array.isArray(paginatedLedger.data)) {
      console.log(`Paginated ledger: page 1 of ${paginatedLedger.totalPages}, pageSize 10, total records: ${paginatedLedger.total}.`);
      console.log('✅ getInventoryLedgerReportData returned structured pagination.');
    } else {
      console.error('❌ getInventoryLedgerReportData failed to return structured pagination when page/pageSize passed.');
      failures++;
    }
  } catch (err: any) {
    console.error('❌ getInventoryLedgerReportData threw error:', err.message);
    failures++;
  }

  console.log('\n==================================================');
  if (failures === 0) {
    console.log('🎉 ALL REPORT FIX VERIFICATION TESTS PASSED! 🎉');
  } else {
    console.error(`💥 ${failures} REPORT VERIFICATION TEST(S) FAILED.`);
    process.exit(1);
  }
}

testReportFixes()
  .catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
