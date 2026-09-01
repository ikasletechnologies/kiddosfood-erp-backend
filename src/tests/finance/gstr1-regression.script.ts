import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';

// Verifies the GSTR-1 fix (timezone-broken date filter + status-based
// exclusion) end-to-end against a real Estimate -> SalesOrder -> Proforma ->
// Tax Invoice chain, using the exact same date-only-string inputs the real
// frontend sends (not precise Date objects), which is the path the bug
// actually lived on. Creates real throwaway rows via the real service layer,
// cleans up everything in a finally block.

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: any) {
  if (ok) { pass++; console.log(`  PASS - ${label}`); }
  else { fail++; console.log(`  FAIL - ${label}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function gstr1SaleInvoiceNumbers(startDate: string, endDate: string): Promise<string[]> {
  const r = await FinanceService.getGSTR1Data(undefined, startDate, endDate);
  return r.sale.map((row: any) => row.invoiceNo);
}

async function main() {
  const today = '2026-09-01';
  const yesterday = '2026-08-31';

  const customer = await prisma.customer.findFirst({ where: { name: { contains: 'Hari', mode: 'insensitive' } } });
  const product = await prisma.product.findFirst({ where: { productType: { not: 'SERVICE' } } });
  if (!customer || !product) throw new Error('Reference customer/product not found for test setup');

  console.log(`Using customer=${customer.name} (${customer.id}), product=${product.name} (${product.id})`);

  let quotation: any;
  let salesOrder: any;
  let proforma: any;
  let invoice: any;

  try {
    console.log('\n=== 1. Create Estimate (Quotation) only ===');
    quotation = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      customerId: customer.id,
      customerName: customer.name,
      stateOfSupply: 'Tamil Nadu',
      items: [{ productId: product.id, productName: product.name, quantity: 10, unit: 'KGS', rate: 40.5, taxPercent: 5 }],
      status: 'SENT',
      createdBy: 'gstr1-regression-script',
    });
    console.log('  Estimate created:', quotation.quotationNumber, 'subTotal:', quotation.subTotal);

    let sale = await gstr1SaleInvoiceNumbers(today, today);
    check('Estimate-only: GSTR-1 sale[] does not contain any reference to this estimate', !sale.includes(quotation.quotationNumber));

    console.log('\n=== 2. Convert Estimate -> SalesOrder (still no Tax Invoice) ===');
    const convResult = await SalesService.convertQuotationToSalesOrder(quotation.id, 'gstr1-regression-script');
    salesOrder = convResult.salesOrder;
    console.log('  SalesOrder created:', salesOrder.orderNumber, 'status:', salesOrder.status);

    sale = await gstr1SaleInvoiceNumbers(today, today);
    check('SalesOrder-only: GSTR-1 sale[] does not contain the SO number', !sale.includes(salesOrder.orderNumber));

    console.log('\n=== 3. Confirm SalesOrder, convert to Proforma (still no Tax Invoice) ===');
    await SalesService.updateSalesOrder(salesOrder.id, { status: 'CONFIRMED' });
    proforma = await SalesService.convertSalesOrderToProforma(salesOrder.id, 'gstr1-regression-script');
    console.log('  Proforma created:', proforma.proformaNumber, 'status:', proforma.status);

    sale = await gstr1SaleInvoiceNumbers(today, today);
    check('Proforma-only: GSTR-1 sale[] does not contain the Proforma number', !sale.includes(proforma.proformaNumber));

    console.log('\n=== 4. Convert Proforma -> Tax Invoice (this is the real GSTR-1 trigger) ===');
    invoice = await SalesService.convertProformaToInvoice(proforma.id, 'gstr1-regression-script');
    console.log('  Tax Invoice created:', invoice.invoiceNum, 'orderType:', invoice.orderType, 'status:', invoice.status, 'paymentStatus:', invoice.paymentStatus);
    check('Tax Invoice paymentStatus is UNPAID (never touched)', invoice.paymentStatus === 'UNPAID', invoice.paymentStatus);

    console.log('\n=== 5. GSTR-1 for today (date-only strings, exactly as the real UI sends them) ===');
    const report = await FinanceService.getGSTR1Data(undefined, today, today);
    const row = report.sale.find((r: any) => r.invoiceNo === invoice.invoiceNum);
    check('Unpaid Tax Invoice appears in GSTR-1 sale[]', !!row, { saleLength: report.sale.length });
    if (row) {
      check('  invoiceNo matches', row.invoiceNo === invoice.invoiceNum);
      check('  partyName matches customer', row.partyName === customer.name, row.partyName);
      check('  placeOfSupply matches stateOfSupply', row.placeOfSupply === 'Tamil Nadu', row.placeOfSupply);
      check('  taxableValue matches subTotal', Math.abs(row.taxableValue - invoice.subTotal) < 0.01, { row: row.taxableValue, invoice: invoice.subTotal });
      check('  totalTax matches taxAmount', Math.abs(row.totalTax - invoice.taxAmount) < 0.01, { row: row.totalTax, invoice: invoice.taxAmount });
      check('  taxRate derived correctly (~5%)', Math.abs(row.taxRate - 5) < 0.5, row.taxRate);
      const occurrences = report.sale.filter((r: any) => r.invoiceNo === invoice.invoiceNum).length;
      check('  appears exactly once (no duplicates)', occurrences === 1, occurrences);
    }

    console.log('\n=== 6. Different date (yesterday) excludes this invoice ===');
    const yReport = await FinanceService.getGSTR1Data(undefined, yesterday, yesterday);
    const yRow = yReport.sale.find((r: any) => r.invoiceNo === invoice.invoiceNum);
    check('Invoice absent when querying a different date', !yRow);

    console.log('\n=== 7. Search by invoice / party (frontend-side logic replicated) ===');
    const searchByInvoice = report.sale.filter((r: any) => r.invoiceNo.toLowerCase().includes(invoice.invoiceNum.toLowerCase()));
    check('Search by invoice number finds it', searchByInvoice.some((r: any) => r.invoiceNo === invoice.invoiceNum));
    const searchByParty = report.sale.filter((r: any) => r.partyName.toLowerCase().includes('hari'));
    check('Search by party name finds it', searchByParty.some((r: any) => r.invoiceNo === invoice.invoiceNum));

    console.log('\n=== 8. Tax-rate filter ===');
    const rateFiltered = report.sale.filter((r: any) => r.taxRate === row?.taxRate);
    check('Tax-rate filter (matching rate) still includes it', rateFiltered.some((r: any) => r.invoiceNo === invoice.invoiceNum));
    const rateExcluded = report.sale.filter((r: any) => r.taxRate === 28); // a rate this invoice does not have
    check('Tax-rate filter (non-matching rate) excludes it', !rateExcluded.some((r: any) => r.invoiceNo === invoice.invoiceNum));

    console.log('\n=== 9. Refresh consistency (same query twice) ===');
    const reportAgain = await FinanceService.getGSTR1Data(undefined, today, today);
    check('Second identical query returns the same sale count', reportAgain.sale.length === report.sale.length, { first: report.sale.length, second: reportAgain.sale.length });

  } finally {
    console.log('\n=== Cleanup ===');
    if (invoice?.id) {
      await prisma.orderItem.deleteMany({ where: { orderId: invoice.id } });
      await prisma.invoice.deleteMany({ where: { orderId: invoice.id } }).catch(() => {});
      await prisma.order.delete({ where: { id: invoice.id } }).catch((e) => console.log('  order delete:', e.message));
    }
    if (proforma?.id) {
      await prisma.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: proforma.id } }).catch(() => {});
      await prisma.proformaInvoice.delete({ where: { id: proforma.id } }).catch((e) => console.log('  proforma delete:', e.message));
    }
    if (salesOrder?.id) {
      await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: salesOrder.id } }).catch(() => {});
      await prisma.salesOrder.delete({ where: { id: salesOrder.id } }).catch((e) => console.log('  salesOrder delete:', e.message));
    }
    if (quotation?.id) {
      await SalesService.deleteQuotation(quotation.id).catch(async (e: any) => {
        console.log('  deleteQuotation failed, raw cleanup:', e.message);
        await prisma.quotationItem.deleteMany({ where: { quotationId: quotation.id } }).catch(() => {});
        await prisma.quotation.delete({ where: { id: quotation.id } }).catch(() => {});
      });
    }
    console.log('  cleanup done.');
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('SCRIPT ERROR:', e); process.exit(1); });
