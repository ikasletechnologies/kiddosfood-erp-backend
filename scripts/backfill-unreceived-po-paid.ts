/**
 * One-off correction: ProcurementOrder.paid on POs whose goods haven't been
 * received, inflated by the old settleVendorOrders. It ran on PO approval
 * and wrote any unmatched vendor debit (a purchase return, or the part of a
 * bill payment above its PO's total) into APPROVED POs' `paid`, so a PO
 * with 0 units received and no payment showed as Paid.
 *
 * That auto-settlement only ever changed po.paid/balance — it wrote no
 * Payment or VendorLedger row — so lowering po.paid back to what was
 * actually recorded against the PO leaves the ledger untouched and the
 * money simply stays available as vendor advance.
 *
 * Recorded against the PO = advancePaid + advanceApplied (explicit advance
 * at creation / Record Advance / Apply Advance) + non-cancelled Payments
 * linked to the PO or its bills. That's an upper bound (creation's
 * advanceApplied is a subset of advancePaid), so a legitimately paid PO is
 * never lowered. Only paid and balance change. Idempotent.
 *
 *   npx tsx scripts/backfill-unreceived-po-paid.ts          # dry run: report only
 *   npx tsx scripts/backfill-unreceived-po-paid.ts --apply  # write the corrections
 */
import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const pos = await prisma.procurementOrder.findMany({
    where: {
      status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'SENT'] },
      paid: { gt: 0 },
    },
    include: { invoices: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });

  let changed = 0;
  for (const po of pos) {
    const invoiceIds = po.invoices.map(i => i.id);
    const linked = await prisma.payment.aggregate({
      where: {
        isCancelled: false,
        status: { in: ['PAID', 'SUCCESS'] },
        OR: [
          // The creation-time advance Payment links by poNumber, others by id.
          { linkedDocType: 'PO', linkedDocId: { in: [po.id, po.poNumber] } },
          ...(invoiceIds.length ? [{ vendorInvoiceId: { in: invoiceIds } }] : []),
        ],
      },
      _sum: { paidAmount: true },
    });
    const recorded = round2((po.advancePaid || 0) + (po.advanceApplied || 0) + (linked._sum.paidAmount || 0));
    const correctPaid = round2(Math.min(po.totalAmount, recorded));
    if (po.paid <= correctPaid + 0.005) continue;

    changed++;
    const newBalance = round2(Math.max(0, po.totalAmount - correctPaid));
    console.log(`  ${po.poNumber} [${po.status}] total ₹${po.totalAmount.toFixed(2)} paid ₹${po.paid.toFixed(2)} → ₹${correctPaid.toFixed(2)} (recorded: advance ₹${(po.advancePaid || 0).toFixed(2)}, applied ₹${(po.advanceApplied || 0).toFixed(2)}, payments ₹${(linked._sum.paidAmount || 0).toFixed(2)})`);
    if (APPLY) {
      await prisma.procurementOrder.update({
        where: { id: po.id },
        data: { paid: correctPaid, balance: newBalance },
      });
    }
  }

  console.log(`\n${changed} PO(s) ${APPLY ? 'corrected' : 'would be corrected (dry run — pass --apply to write)'}.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
