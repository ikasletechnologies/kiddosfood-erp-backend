import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { IsolationUtil } from '../../utils/isolation.util';

interface ReportAuditEntry {
  id: string;
  name: string;
  route: string;
  controllerMethod: string;
  serviceMethod: string;
  sourceModels: string[];
  dbFieldsQueried: string[];
  apiFieldsReturned: string[];
  frontendComponent: string;
  uiFieldsDisplayed: string[];
  csvExportFields: string[];
  pdfPrintFields: string[];
  status: 'WORKING' | 'PARTIAL' | 'BROKEN';
  missingBusinessFields: string[];
  qualityClassification: string;
}

async function runCompleteFieldAudit() {
  console.log('================================================================');
  console.log('🔍 REPORTS MODULE — COMPLETE READ-ONLY FIELD & EXPORT AUDIT');
  console.log('================================================================\n');

  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
  const endDate = today.toISOString();

  const auditLog: ReportAuditEntry[] = [];

  // Helper to log audit details
  const auditReport = async (
    id: string,
    name: string,
    route: string,
    controllerMethod: string,
    serviceMethod: string,
    sourceModels: string[],
    dbFieldsQueried: string[],
    frontendComponent: string,
    uiFields: string[],
    csvFields: string[],
    pdfFields: string[],
    missingFields: string[],
    fetchFn: () => Promise<any>
  ) => {
    try {
      const result = await fetchFn();
      let sampleData: any = {};
      let returnedKeys: string[] = [];

      if (Array.isArray(result)) {
        sampleData = result[0] || {};
        returnedKeys = Object.keys(sampleData);
      } else if (result && typeof result === 'object') {
        sampleData = result.data ? (Array.isArray(result.data) ? result.data[0] || {} : result.data) : result;
        returnedKeys = Object.keys(result);
        if (result.data && Array.isArray(result.data) && result.data[0]) {
          returnedKeys = [...returnedKeys, ...Object.keys(result.data[0]).map(k => `data.${k}`)];
        }
      }

      auditLog.push({
        id,
        name,
        route,
        controllerMethod,
        serviceMethod,
        sourceModels,
        dbFieldsQueried,
        apiFieldsReturned: returnedKeys,
        frontendComponent,
        uiFieldsDisplayed: uiFields,
        csvExportFields: csvFields,
        pdfPrintFields: pdfFields,
        status: missingFields.length === 0 ? 'WORKING' : 'PARTIAL',
        missingBusinessFields: missingFields,
        qualityClassification: missingFields.length === 0 ? 'A (Required & Correctly Displayed)' : 'B (Available but Not Displayed/Exported)'
      });
      console.log(`  [AUDITED] ${name.padEnd(35)} -> API Keys: ${returnedKeys.length} | Missing: ${missingFields.length}`);
    } catch (err: any) {
      auditLog.push({
        id,
        name,
        route,
        controllerMethod,
        serviceMethod,
        sourceModels,
        dbFieldsQueried,
        apiFieldsReturned: [],
        frontendComponent,
        uiFieldsDisplayed: uiFields,
        csvExportFields: csvFields,
        pdfPrintFields: pdfFields,
        status: 'BROKEN',
        missingBusinessFields: missingFields,
        qualityClassification: `E (Error: ${err.message})`
      });
      console.error(`  [FAILED] ${name.padEnd(35)} -> Error: ${err.message}`);
    }
  };

  // 1. Sales Summary Report
  await auditReport(
    'R-01', 'Sales Summary Report', '/api/reports/sales', 'getSalesReport', 'getSaleOrdersReportData',
    ['Order', 'OrderItem', 'Product', 'Customer', 'Payment'],
    ['invoiceNum', 'createdAt', 'subTotal', 'taxAmount', 'discountAmount', 'totalAmount', 'stateOfSupply'],
    'SaleOrdersReport.tsx',
    ['Date', 'Invoice No', 'Customer Name', 'Status', 'Total Revenue', 'Paid', 'Pending'],
    ['Date', 'Invoice No', 'Customer Name', 'Status', 'Total Revenue', 'Paid', 'Pending'],
    ['Date', 'Invoice No', 'Customer Name', 'Status', 'Total Revenue', 'Paid', 'Pending'],
    ['Customer GSTIN', 'Customer Phone', 'Place of Supply', 'CGST', 'SGST', 'IGST', 'Payment Mode'],
    () => FinanceService.getSaleOrdersReportData({ startDate, endDate })
  );

  // 2. Purchases Summary Report
  await auditReport(
    'R-02', 'Purchases Summary Report', '/api/reports/purchases', 'getPurchasesReport', 'getSalePurchaseByItemData',
    ['ProcurementOrder', 'POItem', 'InventoryItem', 'Vendor'],
    ['poNumber', 'subtotal', 'cgst', 'sgst', 'igst', 'totalAmount'],
    'SalePurchaseByCategoryReport.tsx',
    ['Item Name', 'Category', 'Sale Qty', 'Sale Amount', 'Purchase Qty', 'Purchase Amount', 'Gross Margin'],
    ['Item Name', 'Category', 'Sale Qty', 'Sale Amount', 'Purchase Qty', 'Purchase Amount', 'Gross Margin'],
    ['Item Name', 'Category', 'Sale Qty', 'Sale Amount', 'Purchase Qty', 'Purchase Amount', 'Gross Margin'],
    ['PO Price', 'Actual GRN Price', 'Price Variance', 'Vendor GSTIN', 'Freight'],
    () => FinanceService.getSalePurchaseByItemData('', startDate, endDate)
  );

  // 3. Stock Summary Report
  await auditReport(
    'R-03', 'Stock Summary Report', '/api/reports/stock-summary', 'getStockSummaryReport', 'getStockSummaryData',
    ['InventoryItem', 'Vendor'],
    ['name', 'sku', 'category', 'unit', 'currentStock', 'minimumStock', 'costPrice', 'customerPrice'],
    'StockSummaryReport.tsx',
    ['SKU', 'Item Name', 'Category', 'Unit', 'Current Stock', 'Min Stock', 'Cost Price', 'Stock Value', 'Status'],
    ['SKU', 'Item Name', 'Category', 'Unit', 'Current Stock', 'Min Stock', 'Cost Price', 'Stock Value', 'Status'],
    ['SKU', 'Item Name', 'Category', 'Unit', 'Current Stock', 'Min Stock', 'Cost Price', 'Stock Value', 'Status'],
    ['Selling Price / MRP', 'Warehouse / Branch Location', 'Batch/Lot Number'],
    () => FinanceService.getStockSummaryData('')
  );

  // 4. Low Stock Summary Report
  await auditReport(
    'R-04', 'Low Stock Summary Report', '/api/reports/low-stock-summary', 'getLowStockSummaryReport', 'getLowStockSummaryData',
    ['InventoryItem'],
    ['name', 'sku', 'category', 'currentStock', 'minimumStock'],
    'LowStockSummaryReport.tsx',
    ['SKU', 'Item Name', 'Category', 'Unit', 'Current Stock', 'Min Stock', 'Status'],
    ['SKU', 'Item Name', 'Category', 'Unit', 'Current Stock', 'Min Stock', 'Status'],
    ['SKU', 'Item Name', 'Category', 'Unit', 'Current Stock', 'Min Stock', 'Status'],
    ['Reorder Quantity', 'Default Vendor', 'Last Purchase Price'],
    () => FinanceService.getLowStockSummaryData('')
  );

  // 5. Stock Detail Report
  await auditReport(
    'R-05', 'Stock Detail Report', '/api/reports/stock-detail', 'getStockDetailReport', 'getStockDetailData',
    ['InventoryItem', 'StockMovement'],
    ['currentStock', 'quantityIn', 'quantityOut', 'beginningQuantity'],
    'StockDetailReport.tsx',
    ['Item Name', 'Category', 'Unit', 'Opening Stock', 'Inward Stock', 'Outward Stock', 'Closing Stock'],
    ['Item Name', 'Category', 'Unit', 'Opening Stock', 'Inward Stock', 'Outward Stock', 'Closing Stock'],
    ['Item Name', 'Category', 'Unit', 'Opening Stock', 'Inward Stock', 'Outward Stock', 'Closing Stock'],
    ['Opening Valuation', 'Inward Valuation', 'Outward Valuation', 'Closing Valuation'],
    () => FinanceService.getStockDetailData(undefined, startDate, endDate)
  );

  // 6. Item Detail Report
  await auditReport(
    'R-06', 'Item Detail Report', '/api/reports/item-detail', 'getItemDetailReport', 'getItemDetailData',
    ['InventoryItem', 'StockMovement'],
    ['name', 'sku', 'category', 'currentStock', 'movements'],
    'ItemDetailReport.tsx',
    ['Item Name', 'SKU', 'Category', 'Current Stock', 'Beginning Quantity', 'Recent Movements'],
    ['Item Name', 'SKU', 'Category', 'Current Stock', 'Beginning Quantity', 'Recent Movements'],
    ['Item Name', 'SKU', 'Category', 'Current Stock', 'Beginning Quantity', 'Recent Movements'],
    ['Average Unit Cost', 'Vendor Name', 'HSN Code'],
    () => FinanceService.getItemDetailData()
  );

  // 7. Inventory Ledger Report
  await auditReport(
    'R-07', 'Inventory Ledger Report', '/api/reports/inventory-ledger', 'getInventoryLedgerReport', 'getInventoryLedgerReportData',
    ['StockMovement', 'InventoryItem', 'Warehouse'],
    ['createdAt', 'movementType', 'quantity', 'referenceType', 'referenceId', 'note'],
    'StockDetailReport.tsx',
    ['Date', 'Item Name', 'SKU', 'Movement Type', 'Quantity', 'Warehouse', 'Reference Type', 'Performed By'],
    ['Date', 'Item Name', 'SKU', 'Movement Type', 'Quantity', 'Warehouse', 'Reference Type', 'Performed By'],
    ['Date', 'Item Name', 'SKU', 'Movement Type', 'Quantity', 'Warehouse', 'Reference Type', 'Performed By'],
    ['Unit Cost', 'Total Cost / Valuation Impact', 'Batch Number'],
    () => FinanceService.getInventoryLedgerReportData()
  );

  // 8. HSN Summary Report
  await auditReport(
    'R-08', 'HSN Summary Report', '/api/reports/hsn-summary', 'getHsnSummaryReport', 'getHsnSummaryData',
    ['Order', 'OrderItem', 'Product'],
    ['hsnCode', 'quantity', 'price', 'taxAmount', 'totalAmount', 'stateOfSupply'],
    'SaleSummaryByHSNReport.tsx',
    ['HSN', 'Taxable Value', 'IGST Amount', 'CGST Amount', 'SGST Amount', 'Total Value'],
    ['HSN', 'Taxable Value', 'IGST Amount', 'CGST Amount', 'SGST Amount', 'Total Value'],
    ['HSN', 'Taxable Value', 'IGST Amount', 'CGST Amount', 'SGST Amount', 'Total Value'],
    ['HSN Description', 'UOM / Unit', 'Total Quantity Sold', 'Cess Amount'],
    () => FinanceService.getHsnSummaryData(undefined, startDate, endDate)
  );

  // 9. SAC Report
  await auditReport(
    'R-09', 'SAC Service Report', '/api/reports/sac', 'getSacReport', 'getSacReportData',
    ['Order', 'OrderItem', 'Product'],
    ['hsnCode', 'quantity', 'price', 'taxAmount'],
    'SACReport.tsx',
    ['SAC Code', 'Description', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax'],
    ['SAC Code', 'Description', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax'],
    ['SAC Code', 'Description', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax'],
    ['GST Rate %', 'Total Invoice Count'],
    () => FinanceService.getSacReportData('', startDate, endDate)
  );

  // 10. GSTR-1 Report
  await auditReport(
    'R-10', 'GSTR-1 Outward Tax Report', '/api/reports/gstr1', 'getGSTR1Report', 'getGSTR1Data',
    ['Order', 'OrderItem', 'Customer', 'Franchise'],
    ['invoiceNum', 'createdAt', 'subTotal', 'taxAmount', 'totalAmount', 'stateOfSupply'],
    'GSTR1Report.tsx',
    ['Invoice No', 'Date', 'Party Name', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax', 'Total Amount'],
    ['Invoice No', 'Date', 'Party Name', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax', 'Total Amount'],
    ['Invoice No', 'Date', 'Party Name', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax', 'Total Amount'],
    ['Customer GSTIN', 'Place of Supply', 'Invoice Type (B2B vs B2C)'],
    () => FinanceService.getGSTR1Data(undefined, startDate, endDate)
  );

  // 11. GSTR-2 Report
  await auditReport(
    'R-11', 'GSTR-2 Inward Tax Report', '/api/reports/gstr2', 'getGSTR2Report', 'getGSTR2Data',
    ['ProcurementOrder', 'Vendor'],
    ['poNumber', 'createdAt', 'subtotal', 'cgst', 'sgst', 'igst', 'totalAmount'],
    'GSTR2Report.tsx',
    ['PO Number', 'Date', 'Vendor Name', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax', 'Total Amount'],
    ['PO Number', 'Date', 'Vendor Name', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax', 'Total Amount'],
    ['PO Number', 'Date', 'Vendor Name', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Total Tax', 'Total Amount'],
    ['Vendor GSTIN', 'Invoice / Bill Number', 'Eligible ITC Amount'],
    () => FinanceService.getGSTR2Data('', startDate, endDate)
  );

  // 12. GSTR-3B Report
  await auditReport(
    'R-12', 'GSTR-3B Tax Return Summary', '/api/reports/gstr3b', 'getGSTR3BReport', 'getGSTR3BData',
    ['Order', 'ProcurementOrder', 'Franchise'],
    ['subTotal', 'taxAmount', 'cgst', 'sgst', 'igst'],
    'GSTR3BReport.tsx',
    ['Description', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess'],
    ['Description', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess'],
    ['Description', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess'],
    ['Interstate Supplies to Unregistered Persons', 'Exempt Supplies'],
    () => FinanceService.getGSTR3BData(undefined, startDate, endDate)
  );

  // 13. GSTR-9 Report
  await auditReport(
    'R-13', 'GSTR-9 Annual Return Summary', '/api/reports/gstr9', 'getGSTR9Report', 'getGSTR9Data',
    ['Order', 'ProcurementOrder', 'Franchise'],
    ['subTotal', 'taxAmount', 'cgst', 'sgst', 'igst'],
    'GSTR9Report.tsx',
    ['Section', 'Description', 'Taxable Value', 'Central Tax', 'State Tax', 'Integrated Tax'],
    ['Section', 'Description', 'Taxable Value', 'Central Tax', 'State Tax', 'Integrated Tax'],
    ['Section', 'Description', 'Taxable Value', 'Central Tax', 'State Tax', 'Integrated Tax'],
    ['GSTIN', 'Legal Name', 'Reverse Charge Tax Details'],
    () => FinanceService.getGSTR9Data('', '2025-2026')
  );

  // 14. Production Report
  await auditReport(
    'R-14', 'Production Report', '/api/reports/production', 'getProductionReport', 'getProductionReportData',
    ['Production', 'Recipe', 'Employee', 'ProductBatch'],
    ['producedAt', 'actualYield', 'quantity', 'status'],
    'ReportsPage.tsx',
    ['Total Batches', 'Completed Batches', 'In-Progress Batches', 'Total Yield Quantity'],
    ['Total Batches', 'Completed Batches', 'In-Progress Batches', 'Total Yield Quantity'],
    ['Total Batches', 'Completed Batches', 'In-Progress Batches', 'Total Yield Quantity'],
    ['Raw Material Consumption Breakdown', 'Batch Code', 'Operator Name', 'QC Approval Status'],
    () => FinanceService.getProductionReportData('', startDate, endDate)
  );

  // 15. Profit & Loss Report
  await auditReport(
    'R-15', 'Profit & Loss Statement', '/api/reports/profit', 'getPL', 'getProfitAndLoss',
    ['Order', 'Expense', 'ProcurementOrder'],
    ['subTotal', 'taxAmount', 'totalAmount', 'amount'],
    'ProfitLossReport.tsx',
    ['Gross Revenue', 'COGS', 'Gross Profit', 'Expenses', 'Net Profit'],
    ['Gross Revenue', 'COGS', 'Gross Profit', 'Expenses', 'Net Profit'],
    ['Gross Revenue', 'COGS', 'Gross Profit', 'Expenses', 'Net Profit'],
    ['Expense Category Breakdown', 'Operating Margin %', 'Tax Expenses'],
    () => FinanceService.getProfitAndLoss({ startDate: new Date(startDate), endDate: new Date(endDate) })
  );

  // Print Summary Matrix
  console.log('\n================================================================');
  console.log('📊 AUDIT SUMMARY BY REPORT (PHASE 1 & PHASE 2):');
  console.log('================================================================');
  auditLog.forEach(a => {
    console.log(`[${a.status}] ${a.id}: ${a.name}`);
    console.log(`    API Keys Returned: ${a.apiFieldsReturned.join(', ')}`);
    console.log(`    UI Fields:         ${a.uiFieldsDisplayed.join(', ')}`);
    console.log(`    Missing Business:  ${a.missingBusinessFields.join(', ')}`);
    console.log(`    Classification:    ${a.qualityClassification}\n`);
  });
  console.log('================================================================\n');
}

runCompleteFieldAudit()
  .catch(err => {
    console.error('Audit execution error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
