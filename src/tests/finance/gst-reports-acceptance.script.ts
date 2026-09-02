import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';
import { PurchaseService } from '../../modules/purchase/purchase.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { SettingsService } from '../../modules/settings/settings.service';

// GST reporting acceptance script. Exercises the full document chain
// (Estimate -> Sales Order -> Proforma -> Tax Invoice -> Return, and
// PO -> GRN -> Purchase Bill -> Purchase Return) through the REAL service
// layer against the real dev database, and asserts each GSTR-1/2/3B/9/HSN/SAC
// report method reflects it correctly. Every row created here is deleted in
// the `finally` block via a LIFO cleanupTasks stack (push a cleanup closure
// right after creating each resource, run them in reverse at the end) —
// mirrors bug4-roundoff-verification.script.ts's discipline, scaled up for
// the much deeper dependency chain this scenario set touches.

const results: { name: string; pass: boolean; detail?: string; skipped?: boolean }[] = [];

function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

function skip(name: string, reason: string) {
  results.push({ name, pass: true, skipped: true, detail: reason });
  console.log(`⏭️  SKIPPED — ${name}: ${reason}`);
}

const rnd = () => Math.random().toString(36).slice(2, 8);

async function main() {
  console.log('=== GST Reports Acceptance Script ===\n');

  const cleanupTasks: Array<{ label: string; fn: () => Promise<void> }> = [];
  const cleanup = (label: string, fn: () => Promise<void>) => cleanupTasks.push({ label, fn });

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const financialYear = `${fyStartYear}-${fyStartYear + 1}`;

  try {
    // ─── Precondition: HQ franchise ──────────────────────────────────────
    const hq = await FranchiseService.getHqFranchiseOrNull();
    if (!hq) {
      skip('Scenarios 2-10 (all HQ-dependent flows)', 'No HQ franchise configured (Franchise.isHQ) — convertProformaToInvoice would throw.');
    } else {
      console.log(`HQ franchise: ${hq.name} (location: ${hq.location})\n`);
    }

    // ─── Reference / throwaway master data ──────────────────────────────
    let goodsProduct: any = await prisma.product.findFirst({
      where: { hsnCode: { not: null }, productType: { not: 'SERVICE' } }
    });
    let ownsGoodsProduct = false;
    if (!goodsProduct) {
      goodsProduct = await prisma.product.create({
        data: {
          name: `GST-Test-Goods-${rnd()}`,
          sku: `GST-GOODS-${rnd()}`,
          basePrice: 1000,
          taxPercent: 12,
          hsnCode: '19059090',
          productType: 'FINISHED_GOOD',
          isActive: true
        }
      });
      ownsGoodsProduct = true;
      cleanup('delete throwaway goodsProduct', async () => { await prisma.product.delete({ where: { id: goodsProduct.id } }); });
      console.log(`Created throwaway goods Product (no existing HSN-coded goods product found): ${goodsProduct.name}`);
    } else {
      console.log(`Reusing existing goods Product: ${goodsProduct.name} (hsn=${goodsProduct.hsnCode})`);
    }

    const serviceProduct = await prisma.product.create({
      data: {
        name: `GST-Test-Service-${rnd()}`,
        sku: `GST-SVC-${rnd()}`,
        basePrice: 2000,
        taxPercent: 18,
        sacCode: '998714',
        productType: 'SERVICE',
        isActive: true
      }
    });
    cleanup('delete throwaway serviceProduct', async () => { await prisma.product.delete({ where: { id: serviceProduct.id } }); });

    const companyProfile = await SettingsService.getCompanyProfile();
    const hqState = companyProfile?.state || 'Tamil Nadu';
    const hqLocation = hqState;
    const diffState = hqState.toLowerCase() === 'delhi' ? 'Karnataka' : 'Delhi';

    const customerSame = await prisma.customer.create({
      data: { name: `GST-Test-Customer-Same-${rnd()}`, phone: `9${Date.now().toString().slice(-9)}`, state: hqState }
    });
    cleanup('delete customerSame', async () => { await prisma.customer.delete({ where: { id: customerSame.id } }); });

    const customerDiff = await prisma.customer.create({
      data: { name: `GST-Test-Customer-Diff-${rnd()}`, phone: `8${Date.now().toString().slice(-9)}`, state: diffState }
    });
    cleanup('delete customerDiff', async () => { await prisma.customer.delete({ where: { id: customerDiff.id } }); });

    const vendorDiffState = await prisma.vendor.create({
      data: { name: `GST-Test-Vendor-${rnd()}`, contact: `7${Date.now().toString().slice(-9)}`, state: diffState }
    });
    cleanup('delete vendorDiffState', async () => { await prisma.vendor.delete({ where: { id: vendorDiffState.id } }); });

    const invItem = await prisma.inventoryItem.create({
      data: {
        name: `GST-Test-Material-${rnd()}`,
        sku: `GST-MAT-${rnd()}`,
        category: 'RAW_MATERIAL',
        currentStock: 0,
        unit: 'KG',
        gstRate: 12,
        basePrice: 100,
        costPrice: 0,
        franchiseId: null
      }
    });
    cleanup('delete invItem (batches/movements/materials first)', async () => {
      await prisma.stockMovement.deleteMany({ where: { itemId: invItem.id } });
      await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: invItem.id } });
      await prisma.vendorMaterial.deleteMany({ where: { materialId: invItem.id } });
      await prisma.inventoryItem.delete({ where: { id: invItem.id } });
    });

    // ─── Scenarios 1-3: Estimate -> Sales Order -> Proforma -> Tax Invoice ──
    async function runSalesChain(customer: any, label: string) {
      const baseline = await FinanceService.getGSTR1Data({ franchiseId: hq.id, startDate: todayStart, endDate: todayEnd });
      const baselineCount = baseline.sale.length;

      const quotation = await SalesService.createQuotation({
        partyType: 'CUSTOMER',
        customerId: customer.id,
        customerName: customer.name,
        stateOfSupply: customer.state,
        items: [{ productId: goodsProduct.id, productName: goodsProduct.name, quantity: 1, unit: 'PCS', rate: 1000, taxPercent: goodsProduct.taxPercent }],
        discountAmount: 0,
        status: 'SENT',
        createdBy: 'gst-acceptance-script'
      });
      cleanup(`delete quotation (${label})`, async () => {
        await prisma.quotationItem.deleteMany({ where: { quotationId: quotation.id } });
        await prisma.quotation.delete({ where: { id: quotation.id } });
      });

      // Scenario 1
      const afterEstimate = await FinanceService.getGSTR1Data({ franchiseId: hq.id, startDate: todayStart, endDate: todayEnd });
      if (label === 'same-state') {
        record('1. Estimate-only does not appear in GSTR-1', afterEstimate.sale.length === baselineCount,
          `sale.length before=${baselineCount} after=${afterEstimate.sale.length}`);
      }

      const soResult = await SalesService.convertQuotationToSalesOrder(quotation.id, 'gst-acceptance-script');
      const salesOrder = soResult.salesOrder;
      cleanup(`delete salesOrder (${label})`, async () => {
        await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: salesOrder.id } });
        await prisma.salesOrder.delete({ where: { id: salesOrder.id } });
      });

      await SalesService.updateSalesOrder(salesOrder.id, { status: 'CONFIRMED' });

      const proforma = await SalesService.convertSalesOrderToProforma(salesOrder.id, 'gst-acceptance-script');
      cleanup(`delete proforma (${label})`, async () => {
        await prisma.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: proforma.id } });
        await prisma.proformaInvoice.delete({ where: { id: proforma.id } });
      });

      // Scenario 2
      const afterProforma = await FinanceService.getGSTR1Data({ franchiseId: hq.id, startDate: todayStart, endDate: todayEnd });
      if (label === 'same-state') {
        record('2. Sales Order + Proforma (no Tax Invoice) still absent from GSTR-1', afterProforma.sale.length === baselineCount,
          `sale.length before=${baselineCount} after=${afterProforma.sale.length}`);
      }

      const taxInvoiceOrder = await SalesService.convertProformaToInvoice(proforma.id, 'gst-acceptance-script');
      cleanup(`delete taxInvoiceOrder invoice+items+order (${label})`, async () => {
        await prisma.invoice.deleteMany({ where: { orderId: taxInvoiceOrder.id } });
        await prisma.orderItem.deleteMany({ where: { orderId: taxInvoiceOrder.id } });
        await prisma.order.delete({ where: { id: taxInvoiceOrder.id } });
      });

      const afterInvoice = await FinanceService.getGSTR1Data({ franchiseId: hq.id, startDate: todayStart, endDate: todayEnd });
      const row = afterInvoice.sale.find((r: any) => r.invoiceNo === taxInvoiceOrder.invoiceNum);
      const foundAndGrew = afterInvoice.sale.length === baselineCount + 1 && !!row;
      const taxableOk = row ? Math.abs(row.taxableValue - 1000) < 0.01 : false;
      const isInterState = customer.state.toLowerCase().trim() !== hqLocation.toLowerCase().trim();
      const splitOk = row
        ? (isInterState ? (row.igst > 0 && row.cgst === 0 && row.sgst === 0) : (row.cgst > 0 && row.sgst > 0 && row.igst === 0))
        : false;

      record(`3. Tax Invoice appears in GSTR-1 with correct taxableValue (${label})`, foundAndGrew && taxableOk,
        row ? `taxableValue=${row.taxableValue}` : 'row not found');
      record(`3. Tax Invoice GST split correct for ${label} customer (expected ${isInterState ? 'IGST' : 'CGST+SGST'})`, splitOk,
        row ? `cgst=${row.cgst} sgst=${row.sgst} igst=${row.igst}` : 'row not found');

      return { quotation, salesOrder, proforma, taxInvoiceOrder };
    }

    let sameChain: any = null;
    let diffChain: any = null;
    if (hq) {
      try {
        sameChain = await runSalesChain(customerSame, 'same-state');
      } catch (err: any) {
        record('1-3. Sales chain (same-state customer)', false, err.message);
      }
      try {
        diffChain = await runSalesChain(customerDiff, 'different-state');
      } catch (err: any) {
        record('1-3. Sales chain (different-state customer)', false, err.message);
      }
    } else {
      skip('1. Estimate-only unaffected', 'requires HQ franchise for the full chain to be meaningful');
      skip('2. SO+Proforma unaffected', 'requires HQ franchise');
      skip('3. Tax Invoice appears with correct split', 'requires HQ franchise');
    }

    // ─── Scenarios 4-5: PO -> GRN -> Purchase Bill ──────────────────────
    let po: any = null;
    let grn: any = null;
    if (hq) {
      try {
        po = await ProcurementService.createPurchaseOrder({
          vendorId: vendorDiffState.id,
          franchiseId: hq.id,
          status: 'PENDING_APPROVAL',
          items: [{ inventoryItemId: invItem.id, quantity: 10, price: 100, gstRate: 12, unit: 'KG' }]
        });
        cleanup('delete PO items + PO', async () => {
          await prisma.procurementOrderItem.deleteMany({ where: { poId: po.id } });
          await prisma.procurementOrder.delete({ where: { id: po.id } });
        });

        // Scenario 4
        const gstr2BeforeGrn = await FinanceService.getGSTR2Data({ partyId: vendorDiffState.id, startDate: todayStart, endDate: todayEnd });
        record('4. PO with no GRN/Bill does NOT appear in GSTR-2', gstr2BeforeGrn.data.length === 0,
          `data.length=${gstr2BeforeGrn.data.length}`);

        grn = await GRNService.createFromPO(po.id, {
          receivedBy: 'gst-acceptance-script',
          items: [{ materialId: invItem.id, orderedQty: 10, receivedQty: 10, acceptedQty: 10, rejectedQty: 0, price: 100 }]
        });
        cleanup('delete GRN items + GRN', async () => {
          await prisma.goodsReceiptItem.deleteMany({ where: { grnId: grn.id } });
          await prisma.goodsReceipt.delete({ where: { id: grn.id } });
        });

        await GRNService.approve(grn.id);
        cleanup('delete VendorInvoice bill + VendorLedger for vendorDiffState', async () => {
          await prisma.vendorLedger.deleteMany({ where: { vendorId: vendorDiffState.id } });
          await prisma.vendorInvoice.deleteMany({ where: { grnId: grn.id } });
        });
        cleanup('delete AuditLog rows for this GRN', async () => {
          await prisma.auditLog.deleteMany({ where: { module: 'GRN', recordId: grn.id } });
        });

        const gstr2AfterGrn = await FinanceService.getGSTR2Data({ partyId: vendorDiffState.id, startDate: todayStart, endDate: todayEnd });
        const bill = gstr2AfterGrn.data[0];
        const billNonZeroTax = bill ? ((bill.cgst > 0 || bill.sgst > 0 || bill.igst > 0)) : false;
        // Vendor is in a different state than HQ -> expect IGST only, CGST/SGST = 0.
        const billSplitOk = bill ? (bill.igst > 0 && bill.cgst === 0 && bill.sgst === 0) : false;
        record('5. GRN approval auto-generates a Purchase Bill in GSTR-2 with non-zero tax', gstr2AfterGrn.data.length === 1 && billNonZeroTax,
          bill ? `cgst=${bill.cgst} sgst=${bill.sgst} igst=${bill.igst}` : 'no bill row found');
        record('5. Purchase Bill tax split matches vendor(diff-state) vs HQ -> IGST', billSplitOk,
          bill ? `cgst=${bill.cgst} sgst=${bill.sgst} igst=${bill.igst}` : 'no bill row found');
      } catch (err: any) {
        record('4-5. PO -> GRN -> Purchase Bill flow', false, err.message);
      }
    } else {
      skip('4. PO without GRN absent from GSTR-2', 'requires HQ franchise');
      skip('5. GRN approval creates Purchase Bill in GSTR-2', 'requires HQ franchise');
    }

    // ─── Scenario 6: GSTR-3B before/after delta ─────────────────────────
    if (hq) {
      try {
        // Baseline captured is meaningless post-hoc (steps 3 & 5 already ran)
        // so instead assert the totals are both positive and at least as
        // large as what we know we contributed.
        const gstr3b = await FinanceService.getGSTR3BData(hq.id, todayStart, todayEnd);
        const invoiceTax = 1000 * ((goodsProduct.taxPercent || 5) / 100);
        const expectedMinOutputTax = (sameChain ? invoiceTax : 0) + (diffChain ? invoiceTax : 0);
        const expectedMinInputTax = grn ? 120 : 0; // 1000 taxable * 12%
        const outputOk = gstr3b.summary.totalOutputTax > 0 && gstr3b.summary.totalOutputTax >= expectedMinOutputTax - 0.5;
        const inputOk = gstr3b.summary.totalInputTax > 0 && gstr3b.summary.totalInputTax >= expectedMinInputTax - 0.5;
        record('6. GSTR-3B totalOutputTax reflects created Tax Invoice(s)', outputOk,
          `totalOutputTax=${gstr3b.summary.totalOutputTax}, expected >= ${expectedMinOutputTax}`);
        record('6. GSTR-3B totalInputTax reflects created Purchase Bill', inputOk,
          `totalInputTax=${gstr3b.summary.totalInputTax}, expected >= ${expectedMinInputTax}`);
      } catch (err: any) {
        record('6. GSTR-3B summary', false, err.message);
      }
    } else {
      skip('6. GSTR-3B output/input tax deltas', 'requires HQ franchise');
    }

    // ─── Scenario 7: GSTR-9 ──────────────────────────────────────────────
    try {
      const gstr9 = hq ? await FinanceService.getGSTR9Data(hq.id, financialYear) : await FinanceService.getGSTR9Data(undefined, financialYear);
      const summaryOk = gstr9 && gstr9.summary
        && typeof gstr9.summary.totalOutputTax === 'number'
        && typeof gstr9.summary.totalInputTax === 'number'
        && typeof gstr9.summary.netTaxPayable === 'number';
      record('7. GSTR-9 returns a numeric summary without throwing', !!summaryOk,
        summaryOk ? JSON.stringify(gstr9.summary) : 'summary missing/non-numeric');
    } catch (err: any) {
      record('7. GSTR-9 returns a numeric summary without throwing', false, err.message);
    }

    // ─── Scenario 8: HSN vs SAC split ────────────────────────────────────
    let sacOrder: any = null;
    if (hq) {
      try {
        const svcSubTotal = 2000;
        const svcTax = Number((svcSubTotal * (serviceProduct.taxPercent / 100)).toFixed(2));
        sacOrder = await prisma.order.create({
          data: {
            invoiceNum: `GST-SAC-TEST-${rnd()}`,
            franchiseId: hq.id,
            customerId: customerSame.id,
            customerName: customerSame.name,
            orderType: 'TAKEAWAY',
            status: 'COMPLETED',
            paymentStatus: 'PAID',
            stateOfSupply: hqLocation,
            subTotal: svcSubTotal,
            taxAmount: svcTax,
            totalAmount: svcSubTotal + svcTax,
            orderItems: {
              create: [{ productId: serviceProduct.id, quantity: 1, unit: 'NONE', price: svcSubTotal, taxAmount: svcTax, totalAmount: svcSubTotal + svcTax }]
            }
          },
          include: { orderItems: true }
        });
        cleanup('delete sacOrder items + order', async () => {
          await prisma.orderItem.deleteMany({ where: { orderId: sacOrder.id } });
          await prisma.order.delete({ where: { id: sacOrder.id } });
        });

        const [hsnRows, sacRows] = await Promise.all([
          FinanceService.getHsnSummaryData(hq.id, todayStart, todayEnd),
          FinanceService.getSacReportData(hq.id, todayStart, todayEnd)
        ]);

        const goodsInHsn = hsnRows.some((r: any) => r.productName === goodsProduct.name);
        const goodsInSac = sacRows.some((r: any) => r.serviceName === goodsProduct.name);
        const serviceInSac = sacRows.some((r: any) => r.serviceName === serviceProduct.name);
        const serviceInHsn = hsnRows.some((r: any) => r.productName === serviceProduct.name);

        record('8. Goods product appears in HSN summary', goodsInHsn, `hsnRows count=${hsnRows.length}`);
        record('8. Goods product absent from SAC report', !goodsInSac);
        record('8. Service product appears in SAC report', serviceInSac, `sacRows count=${sacRows.length}`);
        record('8. Service product absent from HSN summary', !serviceInHsn);
      } catch (err: any) {
        record('8. HSN vs SAC split', false, err.message);
      }
    } else {
      skip('8. HSN vs SAC split', 'requires HQ franchise');
    }

    // ─── Scenario 9: Sales Credit Note (ReturnOrder) ────────────────────
    if (hq && sameChain) {
      try {
        const ret = await SalesService.createReturnOrder({
          posOrderId: sameChain.taxInvoiceOrder.id,
          customerId: customerSame.id,
          franchiseId: hq.id,
          reason: 'GST acceptance test return',
          items: [{ productId: goodsProduct.id, productName: goodsProduct.name, quantity: 1, rate: 1000 }]
        });
        cleanup('delete ReturnOrder items + ReturnOrder', async () => {
          await prisma.returnItem.deleteMany({ where: { returnId: ret.id } });
          await prisma.returnOrder.delete({ where: { id: ret.id } });
        });

        await SalesService.updateReturnOrder(ret.id, { status: 'APPROVED', approvedBy: 'gst-acceptance-script' });

        const gstr1AfterReturn = await FinanceService.getGSTR1Data({ franchiseId: hq.id, startDate: todayStart, endDate: todayEnd });
        const cnRow = gstr1AfterReturn.creditNotes.find((r: any) => r.invoiceNo === ret.returnNumber);
        record('9. Approved ReturnOrder appears as a credit note in GSTR-1', !!cnRow,
          cnRow ? `taxableValue=${cnRow.taxableValue} totalTax=${cnRow.totalTax}` : 'row not found');

        const dbRow = await prisma.returnOrder.findUnique({ where: { id: ret.id } });
        const dbFieldsOk = !!dbRow && dbRow.taxableValue !== null && dbRow.cgst !== null && dbRow.sgst !== null && dbRow.igst !== null && dbRow.taxAmount !== null;
        record('9. Approved ReturnOrder DB row has non-null GST fields', dbFieldsOk,
          dbRow ? `taxableValue=${dbRow.taxableValue} cgst=${dbRow.cgst} sgst=${dbRow.sgst} igst=${dbRow.igst} taxAmount=${dbRow.taxAmount}` : 'row not found');
      } catch (err: any) {
        record('9. Sales credit note flow', false, err.message);
      }
    } else {
      skip('9. Approved ReturnOrder -> GSTR-1 credit note', 'requires HQ franchise + successful sales chain (scenario 3)');
    }

    // ─── Scenario 10: Purchase Debit Note (PurchaseReturn) ──────────────
    if (hq && po && grn) {
      try {
        const pr = await PurchaseService.createPurchaseReturn({
          procurementOrderId: po.id,
          vendorId: vendorDiffState.id,
          reason: 'GST acceptance test return',
          items: [{ itemName: invItem.name, quantity: 1, unit: 'KG', rate: 100 }]
        });
        cleanup('delete PurchaseReturn items + PurchaseReturn', async () => {
          await prisma.purchaseReturnItem.deleteMany({ where: { returnId: pr.id } });
          await prisma.purchaseReturn.delete({ where: { id: pr.id } });
        });

        await PurchaseService.updatePurchaseReturn(pr.id, { status: 'APPROVED' });

        const gstr2AfterReturn = await FinanceService.getGSTR2Data({ partyId: vendorDiffState.id, startDate: todayStart, endDate: todayEnd });
        const dnRow = gstr2AfterReturn.debitNotes.find((r: any) => r.returnNumber === pr.returnNumber);
        record('10. Approved PurchaseReturn appears as a debit note in GSTR-2', !!dnRow,
          dnRow ? `taxableValue=${dnRow.taxableValue} totalTax=${dnRow.totalTax}` : 'row not found');

        const dbRow = await prisma.purchaseReturn.findUnique({ where: { id: pr.id } });
        const dbFieldsOk = !!dbRow && dbRow.taxableValue !== null && dbRow.cgst !== null && dbRow.sgst !== null && dbRow.igst !== null && dbRow.taxAmount !== null;
        record('10. Approved PurchaseReturn DB row has non-null GST fields', dbFieldsOk,
          dbRow ? `taxableValue=${dbRow.taxableValue} cgst=${dbRow.cgst} sgst=${dbRow.sgst} igst=${dbRow.igst} taxAmount=${dbRow.taxAmount}` : 'row not found');
      } catch (err: any) {
        record('10. Purchase debit note flow', false, err.message);
      }
    } else {
      skip('10. Approved PurchaseReturn -> GSTR-2 debit note', 'requires HQ franchise + successful PO/GRN flow (scenario 5)');
    }

  } finally {
    console.log('\n=== Cleanup ===');
    for (const task of cleanupTasks.reverse()) {
      try {
        await task.fn();
        console.log(`✅ cleaned up: ${task.label}`);
      } catch (err: any) {
        console.error(`❌ cleanup FAILED for "${task.label}": ${err.message}`);
      }
    }
  }

  console.log('\n=== Summary ===');
  const real = results.filter(r => !r.skipped);
  const passed = real.filter(r => r.pass).length;
  const failed = real.filter(r => !r.pass).length;
  const skipped = results.filter(r => r.skipped).length;
  console.log(`PASS: ${passed}  FAIL: ${failed}  SKIPPED: ${skipped}  (total scenarios logged: ${results.length})`);

  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Acceptance script error:', err); process.exit(1); });
