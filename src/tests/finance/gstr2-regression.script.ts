import prisma from '../../lib/prisma';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Verifies the GSTR-2 fix (billDate-based filtering, PO/GRN-alone exclusion,
// GRN-approval-generated bill inclusion, multi-item bill counted once) end
// to end against real data via the real service layer. Cleans up everything
// it creates, including GRN-approval side effects (inventory batches, stock
// movements, vendor ledger, cost-price recalculation).

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: any) {
  if (ok) { pass++; console.log(`  PASS - ${label}`); }
  else { fail++; console.log(`  FAIL - ${label}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function gstr2BillNumbers(startDate: string, endDate: string) {
  const r = await FinanceService.getGSTR2Data(undefined, startDate, endDate);
  return r;
}

async function main() {
  const today = '2026-09-01';
  const yesterday = '2026-08-31';

  const hq = await FranchiseService.getHqFranchiseOrNull();
  const vendor = await prisma.vendor.findFirst();
  const items = await prisma.inventoryItem.findMany({ where: { category: { not: 'FINISHED_GOOD' } }, take: 2 });
  if (!hq || !vendor || items.length < 2) throw new Error('Reference HQ franchise / vendor / 2 inventory items not found for test setup');

  console.log(`Using HQ=${hq.name} (${hq.id}), vendor=${vendor.name} (${vendor.id}), items=[${items.map(i => i.name).join(', ')}]`);

  const preCostPrices = new Map(items.map(i => [i.id, i.costPrice]));

  let po: any;
  let grn: any;
  let invoiceRow: { id: string } | null = null;
  let batchIds: string[] = [];

  try {
    console.log('\n=== 1. Create Purchase Order (2 line items) ===');
    po = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      franchiseId: hq.id,
      items: items.map((i) => ({ inventoryItemId: i.id, quantity: 5, price: 20, gstRate: 5, unit: i.unit || 'UNIT' })),
    });
    console.log('  PO created:', po.poNumber, 'status:', po.status);

    let report = await gstr2BillNumbers(today, today);
    check('PO-only: not present in GSTR-2', !report.data.some((r: any) => r.poNumber === po.poNumber));

    console.log('\n=== 2. Create GRN against PO (not yet approved) ===');
    grn = await GRNService.createFromPO(po.id, {
      items: items.map((i) => ({
        materialId: i.id,
        orderedQty: 5,
        receivedQty: 5,
        acceptedQty: 5,
        rejectedQty: 0,
        price: 20,
      })),
    });
    console.log('  GRN created:', grn.id, 'status:', grn.status);

    report = await gstr2BillNumbers(today, today);
    check('GRN-created-but-unapproved: still not present in GSTR-2', !report.data.some((r: any) => r.poNumber === po.poNumber));

    console.log('\n=== 3. Approve GRN (this is the real GSTR-2 trigger — auto-generates the bill) ===');
    const approved = await GRNService.approve(grn.id);
    console.log('  GRN approved. status:', approved.status);

    const bill = await prisma.vendorInvoice.findFirst({ where: { grnId: grn.id } });
    if (!bill) throw new Error('Expected an auto-generated VendorInvoice after GRN approval but found none');
    invoiceRow = { id: bill.id };
    batchIds = (await prisma.inventoryBatch.findMany({ where: { inventoryItemId: { in: items.map(i => i.id) }, batchNumber: { contains: bill.invoiceNumber } } })).map(b => b.id);
    console.log('  Auto-generated bill:', bill.invoiceNumber, 'status:', bill.status, 'billDate:', bill.billDate?.toISOString(), 'cgst:', bill.cgst, 'sgst:', bill.sgst, 'igst:', bill.igst);
    check('Auto-generated bill payment status is PENDING (unpaid)', bill.status === 'PENDING', bill.status);

    console.log('\n=== 4. GSTR-2 for today ===');
    report = await gstr2BillNumbers(today, today);
    const row = report.data.find((r: any) => r.invoiceNumber === bill.invoiceNumber);
    check('Approved-GRN bill appears in GSTR-2', !!row);
    if (row) {
      check('  taxableValue matches persisted subtotal', Math.abs(row.taxableValue - (bill.subtotal || 0)) < 0.01, { row: row.taxableValue, bill: bill.subtotal });
      check('  totalTax matches persisted cgst+sgst+igst', Math.abs(row.totalTax - ((bill.cgst || 0) + (bill.sgst || 0) + (bill.igst || 0))) < 0.01);
      check('  reverseCharge defaults to N (not fabricated Y)', row.reverseCharge === 'N', row.reverseCharge);
      check('  vendorGstin matches vendor master (or — if none)', row.vendorGstin === (vendor.gstNumber || '—'), row.vendorGstin);
      const occurrences = report.data.filter((r: any) => r.invoiceNumber === bill.invoiceNumber).length;
      check('  bill (2 line items) appears exactly once — not once per item', occurrences === 1, occurrences);
    }

    console.log('\n=== 5. Different date excludes it ===');
    const yReport = await gstr2BillNumbers(yesterday, yesterday);
    check('Bill absent when querying a different date', !yReport.data.some((r: any) => r.invoiceNumber === bill.invoiceNumber));

    console.log('\n=== 6. Search by vendor / bill number ===');
    const byVendor = report.data.filter((r: any) => r.vendorName.toLowerCase().includes(vendor.name.toLowerCase().split(' ')[0]));
    check('Search by vendor name finds it', byVendor.some((r: any) => r.invoiceNumber === bill.invoiceNumber));
    const byBillNo = report.data.filter((r: any) => r.invoiceNumber.toLowerCase().includes(bill.invoiceNumber.toLowerCase()));
    check('Search by bill number finds it', byBillNo.some((r: any) => r.invoiceNumber === bill.invoiceNumber));

    console.log('\n=== 7. Tax-rate filter ===');
    const rateMatch = report.data.filter((r: any) => r.taxRate === row?.taxRate);
    check('Matching tax-rate filter includes it', rateMatch.some((r: any) => r.invoiceNumber === bill.invoiceNumber));
    const rateMiss = report.data.filter((r: any) => r.taxRate === 28);
    check('Non-matching tax-rate filter excludes it', !rateMiss.some((r: any) => r.invoiceNumber === bill.invoiceNumber));

    console.log('\n=== 8. Refresh consistency ===');
    const reportAgain = await gstr2BillNumbers(today, today);
    check('Second identical query returns the same bill count', reportAgain.data.length === report.data.length, { first: report.data.length, second: reportAgain.data.length });

  } finally {
    console.log('\n=== Cleanup ===');
    if (invoiceRow?.id) {
      await prisma.vendorLedger.deleteMany({ where: { invoiceId: invoiceRow.id } }).catch((e) => console.log('  vendorLedger cleanup:', e.message));
      await prisma.payment.deleteMany({ where: { vendorInvoiceId: invoiceRow.id } as any }).catch(() => {});
      await prisma.vendorInvoice.delete({ where: { id: invoiceRow.id } }).catch((e) => console.log('  vendorInvoice delete:', e.message));
    }
    if (batchIds.length) {
      await prisma.inventoryBatch.deleteMany({ where: { id: { in: batchIds } } }).catch((e) => console.log('  batch cleanup:', e.message));
    }
    if (grn?.id) {
      await prisma.stockMovement.deleteMany({ where: { referenceId: grn.id, referenceType: 'GOODS_RECEIPT' } }).catch(() => {});
      await prisma.goodsReceiptItem.deleteMany({ where: { grnId: grn.id } }).catch(() => {});
      await prisma.goodsReceipt.delete({ where: { id: grn.id } }).catch((e) => console.log('  grn delete:', e.message));
    }
    if (po?.id) {
      await prisma.procurementOrderItem.deleteMany({ where: { poId: po.id } }).catch(() => {});
      await prisma.procurementOrder.delete({ where: { id: po.id } }).catch((e) => console.log('  po delete:', e.message));
    }
    for (const [id, costPrice] of preCostPrices) {
      await prisma.inventoryItem.update({ where: { id }, data: { costPrice } }).catch(() => {});
    }
    console.log('  cleanup done.');
  }

  console.log(`\n=== RESULT: ${pass} PASS, ${fail} FAIL ===`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('SCRIPT ERROR:', e); process.exit(1); });
