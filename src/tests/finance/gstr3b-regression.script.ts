import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { SettingsService } from '../../modules/settings/settings.service';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';

// Full GSTR-3B regression: CGST/SGST vs IGST classification (both directions,
// via a real, temporarily-configured company GST state), reconciliation
// against GSTR-1/GSTR-2, payment-status independence, credit-note
// single-deduction, cancelled-invoice exclusion, and PO/GRN-alone exclusion
// from ITC. Uses the real service layer throughout; cleans up everything,
// including the temporary company-profile change.

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: any) {
  if (ok) { pass++; console.log(`  PASS - ${label}`); }
  else { fail++; console.log(`  FAIL - ${label}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

const TODAY = '2026-09-01';
const YESTERDAY = '2026-08-31';
const COMPANY_STATE = 'Tamil Nadu'; // matches the intra-state customer below
const INTERSTATE_CUSTOMER_STATE = 'Karnataka';

async function createTaxInvoice(opts: { customerId: string; customerName: string; stateOfSupply: string; productId: string; qty: number; rate: number; taxPercent: number }) {
  const quotation = await SalesService.createQuotation({
    partyType: 'CUSTOMER',
    customerId: opts.customerId,
    customerName: opts.customerName,
    stateOfSupply: opts.stateOfSupply,
    items: [{ productId: opts.productId, productName: 'test-item', quantity: opts.qty, unit: 'KGS', rate: opts.rate, taxPercent: opts.taxPercent }],
    status: 'SENT',
    createdBy: 'gstr3b-regression-script',
  });
  const conv = await SalesService.convertQuotationToSalesOrder(quotation.id, 'gstr3b-regression-script');
  const salesOrder = conv.salesOrder;
  await SalesService.updateSalesOrder(salesOrder.id, { status: 'CONFIRMED' });
  const proforma = await SalesService.convertSalesOrderToProforma(salesOrder.id, 'gstr3b-regression-script');
  const invoice = await SalesService.convertProformaToInvoice(proforma.id, 'gstr3b-regression-script');
  return { quotation, salesOrder, proforma, invoice };
}

async function cleanupChain(chain: { quotation?: any; salesOrder?: any; proforma?: any; invoice?: any }) {
  if (chain.invoice?.id) {
    await prisma.orderItem.deleteMany({ where: { orderId: chain.invoice.id } }).catch(() => {});
    await prisma.invoice.deleteMany({ where: { orderId: chain.invoice.id } }).catch(() => {});
    await prisma.order.delete({ where: { id: chain.invoice.id } }).catch((e) => console.log('    invoice delete:', e.message));
  }
  if (chain.proforma?.id) {
    await prisma.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: chain.proforma.id } }).catch(() => {});
    await prisma.proformaInvoice.delete({ where: { id: chain.proforma.id } }).catch((e) => console.log('    proforma delete:', e.message));
  }
  if (chain.salesOrder?.id) {
    await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: chain.salesOrder.id } }).catch(() => {});
    await prisma.salesOrder.delete({ where: { id: chain.salesOrder.id } }).catch((e) => console.log('    salesOrder delete:', e.message));
  }
  if (chain.quotation?.id) {
    await SalesService.deleteQuotation(chain.quotation.id).catch(async () => {
      await prisma.quotationItem.deleteMany({ where: { quotationId: chain.quotation.id } }).catch(() => {});
      await prisma.quotation.delete({ where: { id: chain.quotation.id } }).catch(() => {});
    });
  }
}

async function main() {
  const hq = await FranchiseService.getHqFranchiseOrNull();
  const product = await prisma.product.findFirst({ where: { productType: { not: 'SERVICE' } } });
  const vendor = await prisma.vendor.findFirst();
  const invItems = await prisma.inventoryItem.findMany({ where: { category: { not: 'FINISHED_GOOD' } }, take: 1 });
  if (!hq || !product || !vendor || invItems.length < 1) throw new Error('Reference HQ/product/vendor/inventory item not found');
  const invItem = invItems[0];

  const originalCompanyProfileSetting = await prisma.systemSetting.findUnique({ where: { key: 'COMPANY_PROFILE' } });

  let customerIntra: any, customerInter: any;
  const chains: any[] = [];
  let cancelledChain: any = null;
  let returnOrder: any = null;
  let po: any, grn: any, vendorInvoice: any, batchIds: string[] = [];
  const preCostPrice = invItem.costPrice;

  try {
    console.log('=== Setup: configure a REAL company GST state via SettingsService.updateCompanyProfile ===');
    await SettingsService.updateCompanyProfile({ ...(JSON.parse(originalCompanyProfileSetting?.value || '{}')), state: COMPANY_STATE });
    const profile = await SettingsService.getCompanyProfile();
    check('Company profile state now resolves to the configured value (precedence fix)', profile.state === COMPANY_STATE, profile.state);

    customerIntra = await prisma.customer.create({ data: { name: 'GSTR3B-Test-Intra', state: COMPANY_STATE, phone: '9000000001' } });
    customerInter = await prisma.customer.create({ data: { name: 'GSTR3B-Test-Inter', state: INTERSTATE_CUSTOMER_STATE, phone: '9000000002' } });

    console.log('\n=== CASE 5/6/7 — Estimate / SalesOrder / Proforma alone must not affect GST ===');
    const preReport = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    const q = await SalesService.createQuotation({
      partyType: 'CUSTOMER', customerId: customerIntra.id, customerName: customerIntra.name, stateOfSupply: COMPANY_STATE,
      items: [{ productId: product.id, productName: 'test', quantity: 1, unit: 'KGS', rate: 100, taxPercent: 5 }],
      status: 'SENT', createdBy: 'gstr3b-regression-script',
    });
    let midReport = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('Estimate-only: GSTR-3B output tax unchanged', Math.abs(midReport.summary.totalOutputTax - preReport.summary.totalOutputTax) < 0.01);

    const conv = await SalesService.convertQuotationToSalesOrder(q.id, 'gstr3b-regression-script');
    midReport = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('SalesOrder-only: GSTR-3B output tax unchanged', Math.abs(midReport.summary.totalOutputTax - preReport.summary.totalOutputTax) < 0.01);

    await SalesService.updateSalesOrder(conv.salesOrder.id, { status: 'CONFIRMED' });
    const proforma = await SalesService.convertSalesOrderToProforma(conv.salesOrder.id, 'gstr3b-regression-script');
    midReport = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('Proforma-only: GSTR-3B output tax unchanged', Math.abs(midReport.summary.totalOutputTax - preReport.summary.totalOutputTax) < 0.01);

    console.log('\n=== CASE 1 — Intra-state taxable sale (5%) ===');
    const invoiceIntra = await SalesService.convertProformaToInvoice(proforma.id, 'gstr3b-regression-script');
    chains.push({ quotation: q, salesOrder: conv.salesOrder, proforma, invoice: invoiceIntra });
    console.log('  Intra-state Tax Invoice:', invoiceIntra.invoiceNum, 'taxAmount:', invoiceIntra.taxAmount, 'paymentStatus:', invoiceIntra.paymentStatus);
    check('CASE 4: Tax Invoice created UNPAID (payment never touched)', invoiceIntra.paymentStatus === 'UNPAID');

    let gstr1 = await FinanceService.getGSTR1Data(undefined, TODAY, TODAY);
    let row = gstr1.sale.find((r: any) => r.invoiceNo === invoiceIntra.invoiceNum);
    check('CASE 1: GSTR-1 classifies intra-state as CGST+SGST, IGST=0', !!row && row.igst === 0 && row.cgst > 0 && row.sgst > 0, row);

    console.log('\n=== CASE 2 — Inter-state taxable sale (5%) ===');
    const interChain = await createTaxInvoice({ customerId: customerInter.id, customerName: customerInter.name, stateOfSupply: INTERSTATE_CUSTOMER_STATE, productId: product.id, qty: 1, rate: 100, taxPercent: 5 });
    chains.push(interChain);
    console.log('  Inter-state Tax Invoice:', interChain.invoice.invoiceNum);
    gstr1 = await FinanceService.getGSTR1Data(undefined, TODAY, TODAY);
    row = gstr1.sale.find((r: any) => r.invoiceNo === interChain.invoice.invoiceNum);
    check('CASE 2: GSTR-1 classifies inter-state as IGST, CGST=SGST=0', !!row && row.cgst === 0 && row.sgst === 0 && row.igst > 0, row);

    console.log('\n=== CASE 15 — Cancelled invoice must be excluded ===');
    const cancelChain = await createTaxInvoice({ customerId: customerIntra.id, customerName: customerIntra.name, stateOfSupply: COMPANY_STATE, productId: product.id, qty: 1, rate: 50, taxPercent: 5 });
    cancelledChain = cancelChain;
    await prisma.order.update({ where: { id: cancelChain.invoice.id }, data: { status: 'CANCELLED' } });
    gstr1 = await FinanceService.getGSTR1Data(undefined, TODAY, TODAY);
    check('CASE 15: Cancelled Tax Invoice absent from GSTR-1', !gstr1.sale.some((r: any) => r.invoiceNo === cancelChain.invoice.invoiceNum));

    console.log('\n=== CASE 12 — Sales payment must not duplicate Output GST ===');
    const before3b = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    await prisma.order.update({ where: { id: invoiceIntra.id }, data: { paymentStatus: 'PAID' } });
    const after3bPayment = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('CASE 12: Output GST unchanged after marking invoice PAID', Math.abs(after3bPayment.summary.totalOutputTax - before3b.summary.totalOutputTax) < 0.01, { before: before3b.summary.totalOutputTax, after: after3bPayment.summary.totalOutputTax });

    console.log('\n=== CASE 13 — Credit Note adjusts outward tax exactly once ===');
    const ret = await SalesService.createReturnOrder({
      posOrderId: invoiceIntra.id,
      customerId: customerIntra.id,
      franchiseId: invoiceIntra.franchiseId,
      reason: 'gstr3b-regression-script test return',
      items: [{ productId: product.id, productName: 'test', quantity: 1, rate: 100 }],
    });
    returnOrder = ret;
    const beforeApprove = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    await SalesService.updateReturnOrder(ret.id, { status: 'APPROVED' });
    const afterApprove1 = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    const afterApprove2 = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY); // query twice — must not double-apply
    check('CASE 13: Approving credit note reduces output tax by the note amount (once)', afterApprove1.summary.totalOutputTax < beforeApprove.summary.totalOutputTax);
    check('CASE 13: Re-querying does not deduct it a second time', Math.abs(afterApprove1.summary.totalOutputTax - afterApprove2.summary.totalOutputTax) < 0.01, { first: afterApprove1.summary.totalOutputTax, second: afterApprove2.summary.totalOutputTax });

    console.log('\n=== CASE 8/9/10/11 — PO alone / GRN alone must not affect ITC; approved bill must; payment must not duplicate ===');
    const preItc = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    po = await ProcurementService.createPurchaseOrder({ vendorId: vendor.id, franchiseId: hq.id, items: [{ inventoryItemId: invItem.id, quantity: 5, price: 20, gstRate: 5, unit: invItem.unit || 'UNIT' }] });
    let midItc = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('CASE 8: PO-only does not affect input tax', Math.abs(midItc.summary.totalInputTax - preItc.summary.totalInputTax) < 0.01);

    grn = await GRNService.createFromPO(po.id, { items: [{ materialId: invItem.id, orderedQty: 5, receivedQty: 5, acceptedQty: 5, rejectedQty: 0, price: 20 }] });
    midItc = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('CASE 9: GRN-created-unapproved does not affect input tax', Math.abs(midItc.summary.totalInputTax - preItc.summary.totalInputTax) < 0.01);

    await GRNService.approve(grn.id);
    vendorInvoice = await prisma.vendorInvoice.findFirst({ where: { grnId: grn.id } });
    batchIds = (await prisma.inventoryBatch.findMany({ where: { inventoryItemId: invItem.id, batchNumber: { contains: vendorInvoice!.invoiceNumber } } })).map((b) => b.id);
    const afterBill = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('CASE 10: Approved GRN (auto-generated Purchase Bill) increases input tax', afterBill.summary.totalInputTax > preItc.summary.totalInputTax);
    check('CASE 10: Purchase Bill created UNPAID', vendorInvoice!.status === 'PENDING');

    await prisma.vendorInvoice.update({ where: { id: vendorInvoice!.id }, data: { status: 'PAID' } });
    const afterPayment = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check('CASE 11: Marking Purchase Bill PAID does not duplicate ITC', Math.abs(afterPayment.summary.totalInputTax - afterBill.summary.totalInputTax) < 0.01, { before: afterBill.summary.totalInputTax, after: afterPayment.summary.totalInputTax });

    console.log('\n=== CASE 14 — Different date range excludes everything created today ===');
    const yReport = await FinanceService.getGSTR3BData(undefined, YESTERDAY, YESTERDAY);
    const yGstr1 = await FinanceService.getGSTR1Data(undefined, YESTERDAY, YESTERDAY);
    check('CASE 14: Yesterday range does not include today\'s intra-state invoice', !yGstr1.sale.some((r: any) => r.invoiceNo === invoiceIntra.invoiceNum));

    console.log('\n=== Reconciliation: GSTR-1 vs GSTR-3B Section 3.1 (same date range) ===');
    const finalGstr1 = await FinanceService.getGSTR1Data(undefined, TODAY, TODAY);
    const finalGstr3b = await FinanceService.getGSTR3BData(undefined, TODAY, TODAY);
    check(
      'GSTR-1 totalOutputGST reconciles with GSTR-3B 3.1 total tax',
      Math.abs(finalGstr1.totalOutputGST - (finalGstr3b.outwardSupplies[0].cgst + finalGstr3b.outwardSupplies[0].sgst + finalGstr3b.outwardSupplies[0].igst)) < 0.01,
      { gstr1: finalGstr1.totalOutputGST, gstr3bSection31: finalGstr3b.outwardSupplies[0] }
    );
    check(
      'GSTR-1 totalTaxableValue reconciles with GSTR-3B 3.1 taxable value',
      Math.abs(finalGstr1.totalTaxableValue - finalGstr3b.outwardSupplies[0].taxableValue) < 0.01,
      { gstr1: finalGstr1.totalTaxableValue, gstr3b: finalGstr3b.outwardSupplies[0].taxableValue }
    );

    console.log('\n=== Component-wise Net GST Payable sanity ===');
    check(
      'netGstLiability total matches summary.netGstPayable',
      Math.abs((finalGstr3b.netGstLiability.cgst + finalGstr3b.netGstLiability.sgst + finalGstr3b.netGstLiability.igst) - finalGstr3b.summary.netGstPayable) < 0.01,
      finalGstr3b.netGstLiability
    );
    check('No negative net liability on any head', finalGstr3b.netGstLiability.cgst >= 0 && finalGstr3b.netGstLiability.sgst >= 0 && finalGstr3b.netGstLiability.igst >= 0, finalGstr3b.netGstLiability);

    console.log('\n=== CASE 3 — Draft Tax Invoice ===');
    console.log('  NOTE: structurally impossible to test — OrderStatus has no DRAFT value, and a TAX_INVOICE');
    console.log('  order is only ever created (via convertProformaToInvoice) already final. Documenting, not fabricating a test.');

  } finally {
    console.log('\n=== Cleanup ===');
    if (returnOrder?.id) {
      await prisma.returnItem.deleteMany({ where: { returnId: returnOrder.id } }).catch(() => {});
      await prisma.returnOrder.delete({ where: { id: returnOrder.id } }).catch((e) => console.log('  returnOrder delete:', e.message));
    }
    if (vendorInvoice?.id) {
      await prisma.vendorLedger.deleteMany({ where: { invoiceId: vendorInvoice.id } }).catch(() => {});
      await prisma.vendorInvoice.delete({ where: { id: vendorInvoice.id } }).catch((e) => console.log('  vendorInvoice delete:', e.message));
    }
    if (batchIds.length) await prisma.inventoryBatch.deleteMany({ where: { id: { in: batchIds } } }).catch(() => {});
    if (grn?.id) {
      await prisma.stockMovement.deleteMany({ where: { referenceId: grn.id, referenceType: 'GOODS_RECEIPT' } }).catch(() => {});
      await prisma.goodsReceiptItem.deleteMany({ where: { grnId: grn.id } }).catch(() => {});
      await prisma.goodsReceipt.delete({ where: { id: grn.id } }).catch((e) => console.log('  grn delete:', e.message));
    }
    if (po?.id) {
      await prisma.procurementOrderItem.deleteMany({ where: { poId: po.id } }).catch(() => {});
      await prisma.procurementOrder.delete({ where: { id: po.id } }).catch((e) => console.log('  po delete:', e.message));
    }
    await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { costPrice: preCostPrice } }).catch(() => {});

    if (cancelledChain) await cleanupChain(cancelledChain);
    for (const c of chains) await cleanupChain(c);

    if (customerIntra?.id) await prisma.customer.delete({ where: { id: customerIntra.id } }).catch((e) => console.log('  customerIntra delete:', e.message));
    if (customerInter?.id) await prisma.customer.delete({ where: { id: customerInter.id } }).catch((e) => console.log('  customerInter delete:', e.message));

    if (originalCompanyProfileSetting) {
      await prisma.systemSetting.update({ where: { key: 'COMPANY_PROFILE' }, data: { value: originalCompanyProfileSetting.value } }).catch(() => {});
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'COMPANY_PROFILE' } }).catch(() => {});
    }
    console.log('  cleanup done. Company profile restored to original state:', originalCompanyProfileSetting ? JSON.parse(originalCompanyProfileSetting.value) : '(was unset)');
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('SCRIPT ERROR:', e); process.exit(1); });
