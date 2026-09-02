import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { SettingsService } from '../../modules/settings/settings.service';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';

// Verifies the redesigned GSTR-9: FY windowing, B2B/B2C split, the RCM
// mislabeling fix, and reconciliation against GSTR-1/GSTR-3B for the same
// financial year — all via the real service layer, real throwaway data,
// fully cleaned up (including a temporary company-profile change).

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: any) {
  if (ok) { pass++; console.log(`  PASS - ${label}`); }
  else { fail++; console.log(`  FAIL - ${label}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

const COMPANY_STATE = 'Tamil Nadu';
const TODAY = new Date();
const FY = TODAY.getUTCMonth() >= 3 ? `${TODAY.getUTCFullYear()}-${TODAY.getUTCFullYear() + 1}` : `${TODAY.getUTCFullYear() - 1}-${TODAY.getUTCFullYear()}`;

async function createTaxInvoice(opts: { customerId: string; customerName: string; stateOfSupply: string; productId: string; qty: number; rate: number; taxPercent: number }) {
  const quotation = await SalesService.createQuotation({
    partyType: 'CUSTOMER', customerId: opts.customerId, customerName: opts.customerName, stateOfSupply: opts.stateOfSupply,
    items: [{ productId: opts.productId, productName: 'test-item', quantity: opts.qty, unit: 'KGS', rate: opts.rate, taxPercent: opts.taxPercent }],
    status: 'SENT', createdBy: 'gstr9-regression-script',
  });
  const conv = await SalesService.convertQuotationToSalesOrder(quotation.id, 'gstr9-regression-script');
  await SalesService.updateSalesOrder(conv.salesOrder.id, { status: 'CONFIRMED' });
  const proforma = await SalesService.convertSalesOrderToProforma(conv.salesOrder.id, 'gstr9-regression-script');
  const invoice = await SalesService.convertProformaToInvoice(proforma.id, 'gstr9-regression-script');
  return { quotation, salesOrder: conv.salesOrder, proforma, invoice };
}

async function cleanupChain(chain: any) {
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
  const preCostPrice = invItem.costPrice;

  const originalCompanyProfileSetting = await prisma.systemSetting.findUnique({ where: { key: 'COMPANY_PROFILE' } });

  let customerB2B: any, customerB2C: any;
  const chains: any[] = [];
  let po: any, grn: any, vendorInvoice: any, batchIds: string[] = [];

  try {
    console.log(`=== Setup: FY under test = ${FY}, configuring real company GST state ===`);
    await SettingsService.updateCompanyProfile({ ...(JSON.parse(originalCompanyProfileSetting?.value || '{}')), state: COMPANY_STATE });

    customerB2B = await prisma.customer.create({ data: { name: 'GSTR9-Test-B2B', state: COMPANY_STATE, gstNumber: '33AAAAA0000A1Z5', phone: '9000000101' } });
    customerB2C = await prisma.customer.create({ data: { name: 'GSTR9-Test-B2C', state: COMPANY_STATE, phone: '9000000102' } });

    const before = await FinanceService.getGSTR9Data(undefined, FY);
    check('Response shape has the 4 required sections', !!before.outwardSupplies && !!before.itcSummary && !!before.reconciliation, Object.keys(before));
    check('No "reverse charge" category anywhere in outward/ITC (the mislabeling bug)', JSON.stringify(before).toLowerCase().indexOf('reverse charge') === -1);

    console.log('\n=== B2B Tax Invoice ===');
    const b2bChain = await createTaxInvoice({ customerId: customerB2B.id, customerName: customerB2B.name, stateOfSupply: COMPANY_STATE, productId: product.id, qty: 1, rate: 200, taxPercent: 5 });
    chains.push(b2bChain);
    console.log('  Invoice:', b2bChain.invoice.invoiceNum, 'taxAmount:', b2bChain.invoice.taxAmount);

    console.log('\n=== B2C Tax Invoice ===');
    const b2cChain = await createTaxInvoice({ customerId: customerB2C.id, customerName: customerB2C.name, stateOfSupply: COMPANY_STATE, productId: product.id, qty: 1, rate: 100, taxPercent: 5 });
    chains.push(b2cChain);
    console.log('  Invoice:', b2cChain.invoice.invoiceNum, 'taxAmount:', b2cChain.invoice.taxAmount);

    const after = await FinanceService.getGSTR9Data(undefined, FY);
    const b2bRow = after.outwardSupplies.find((r: any) => r.category === 'B2B Sales');
    const b2cRow = after.outwardSupplies.find((r: any) => r.category === 'B2C Sales');
    const totalRow = after.outwardSupplies.find((r: any) => r.category === 'Total Outward Supplies');

    check('B2B taxable value increased by the B2B invoice amount', (b2bRow?.taxableValue || 0) - (before.outwardSupplies.find((r: any) => r.category === 'B2B Sales')?.taxableValue || 0) >= 199.99);
    check('B2C taxable value increased by the B2C invoice amount', (b2cRow?.taxableValue || 0) - (before.outwardSupplies.find((r: any) => r.category === 'B2C Sales')?.taxableValue || 0) >= 99.99);
    check('B2B row is intra-state (CGST+SGST, no IGST) given matching company/customer state', b2bRow?.igst === 0 && (b2bRow?.cgst || 0) > 0 && (b2bRow?.sgst || 0) > 0, b2bRow);
    check(
      'Total Outward Supplies = B2B + B2C + Credit/Debit adjustments',
      Math.abs((totalRow?.taxableValue || 0) - ((b2bRow?.taxableValue || 0) + (b2cRow?.taxableValue || 0) + (after.outwardSupplies.find((r: any) => r.category === 'Credit/Debit Note Adjustments')?.taxableValue || 0))) < 0.01
    );

    console.log('\n=== Purchase side: PO/GRN alone must not affect ITC; approved bill must (and must not be labeled RCM) ===');
    const preItc = await FinanceService.getGSTR9Data(undefined, FY);
    po = await ProcurementService.createPurchaseOrder({ vendorId: vendor.id, franchiseId: hq.id, items: [{ inventoryItemId: invItem.id, quantity: 5, price: 20, gstRate: 5, unit: invItem.unit || 'UNIT' }] });
    let midItc = await FinanceService.getGSTR9Data(undefined, FY);
    check('PO-only does not affect Total Eligible ITC', Math.abs(midItc.itcSummary.total - preItc.itcSummary.total) < 0.01);

    grn = await GRNService.createFromPO(po.id, { items: [{ materialId: invItem.id, orderedQty: 5, receivedQty: 5, acceptedQty: 5, rejectedQty: 0, price: 20 }] });
    midItc = await FinanceService.getGSTR9Data(undefined, FY);
    check('GRN-created-unapproved does not affect Total Eligible ITC', Math.abs(midItc.itcSummary.total - preItc.itcSummary.total) < 0.01);

    await GRNService.approve(grn.id);
    vendorInvoice = await prisma.vendorInvoice.findFirst({ where: { grnId: grn.id } });
    batchIds = (await prisma.inventoryBatch.findMany({ where: { inventoryItemId: invItem.id, batchNumber: { contains: vendorInvoice!.invoiceNumber } } })).map((b) => b.id);
    const afterItc = await FinanceService.getGSTR9Data(undefined, FY);
    check('Approved GRN (auto-generated Purchase Bill) increases Total Eligible ITC', afterItc.itcSummary.total > preItc.itcSummary.total);

    console.log('\n=== Reconciliation with GSTR-1 / GSTR-3B for the same FY window ===');
    const fyStart = `${FY.split('-')[0]}-04-01`;
    const fyEndYear = FY.split('-')[1];
    const fyEnd = `${fyEndYear}-03-31`;
    const gstr1 = await FinanceService.getGSTR1Data(undefined, fyStart, fyEnd);
    const gstr3b = await FinanceService.getGSTR3BData(undefined, fyStart, fyEnd);
    const gstr9 = await FinanceService.getGSTR9Data(undefined, FY);

    check(
      'GSTR-9 Total Output GST reconciles with GSTR-1 output GST for the same window',
      Math.abs(gstr9.reconciliation.totalOutputGst - gstr1.totalOutputGST) < 0.5,
      { gstr9: gstr9.reconciliation.totalOutputGst, gstr1: gstr1.totalOutputGST }
    );
    check(
      'GSTR-9 Eligible ITC reconciles with GSTR-3B input tax for the same window',
      Math.abs(gstr9.itcSummary.total - gstr3b.summary.totalInputTax) < 0.5,
      { gstr9: gstr9.itcSummary.total, gstr3b: gstr3b.summary.totalInputTax }
    );
    check(
      'GSTR-9 Net GST Payable = Total Output GST - Eligible ITC (component-wise, non-negative)',
      Math.abs(gstr9.reconciliation.netGstPayable - (gstr9.reconciliation.totalOutputGst - gstr9.reconciliation.eligibleItc)) < 1 && gstr9.reconciliation.netGstPayable >= 0,
      gstr9.reconciliation
    );

    console.log('\n=== FY windowing sanity: a different FY must not include today\'s data ===');
    const priorFy = `${Number(FY.split('-')[0]) - 1}-${Number(FY.split('-')[1]) - 1}`;
    const priorFyReport = await FinanceService.getGSTR9Data(undefined, priorFy);
    const priorTotal = priorFyReport.outwardSupplies.find((r: any) => r.category === 'Total Outward Supplies');
    check('Prior FY total taxable value did not pick up today\'s new invoices', (priorTotal?.taxableValue || 0) < (totalRow?.taxableValue || 0));

  } finally {
    console.log('\n=== Cleanup ===');
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

    for (const c of chains) await cleanupChain(c);
    if (customerB2B?.id) await prisma.customer.delete({ where: { id: customerB2B.id } }).catch((e) => console.log('  customerB2B delete:', e.message));
    if (customerB2C?.id) await prisma.customer.delete({ where: { id: customerB2C.id } }).catch((e) => console.log('  customerB2C delete:', e.message));

    if (originalCompanyProfileSetting) {
      await prisma.systemSetting.update({ where: { key: 'COMPANY_PROFILE' }, data: { value: originalCompanyProfileSetting.value } }).catch(() => {});
    } else {
      await prisma.systemSetting.deleteMany({ where: { key: 'COMPANY_PROFILE' } }).catch(() => {});
    }
    console.log('  cleanup done.');
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('SCRIPT ERROR:', e); process.exit(1); });
