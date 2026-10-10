/**
 * One-off backfill: customer-ledger reversals for invoices and customer
 * payments that were cancelled before cancelInvoice/cancelPayment started
 * reversing their ledger rows.
 *
 * Append-only and idempotent: it never edits or deletes a row, it only posts
 * the ADJUSTMENT rows FinanceService.reverseCustomerLedgerEntries would have
 * posted at cancellation time (that helper nets earlier reversals, so a
 * second run posts nothing).
 *
 *   npx tsx scripts/backfill-cancelled-ledger-reversals.ts          # dry run: report only
 *   npx tsx scripts/backfill-cancelled-ledger-reversals.ts --apply  # write the reversals
 */
import prisma from '../src/lib/prisma';
import { FinanceService } from '../src/modules/finance/finance.service';

const APPLY = process.argv.includes('--apply');

async function main() {
  const cancelledPayments = await prisma.payment.findMany({
    where: { isCancelled: true, entityType: 'CUSTOMER' },
    select: { id: true, paymentNumber: true }
  });
  const cancelledOrders = await prisma.order.findMany({
    where: { status: 'CANCELLED' },
    select: { id: true, invoiceNum: true }
  });

  const jobs = [
    ...cancelledPayments.map(p => ({
      label: `Payment ${p.paymentNumber || p.id}`,
      referenceId: p.id,
      referenceTypes: ['PAYMENT'] as Array<'PAYMENT'>,
      note: `Reversal — Payment #${p.paymentNumber || p.id} cancelled (backfill)`
    })),
    ...cancelledOrders.map(o => ({
      label: `Invoice ${o.invoiceNum}`,
      referenceId: o.id,
      referenceTypes: ['SALE', 'PAYMENT'] as Array<'SALE' | 'PAYMENT'>,
      note: `Reversal — Invoice #${o.invoiceNum} cancelled (backfill)`
    }))
  ];

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${cancelledPayments.length} cancelled customer payments, ${cancelledOrders.length} cancelled invoices`);
  let count = 0;
  for (const job of jobs) {
    // Dry run uses the same helper inside a transaction that is always rolled back.
    const created = await prisma.$transaction(async (tx) => {
      const rows = await FinanceService.reverseCustomerLedgerEntries(tx, job);
      if (!APPLY) throw Object.assign(new Error('rollback'), { rows });
      return rows;
    }).catch((e: any) => {
      if (e?.message === 'rollback') return e.rows as any[];
      throw e;
    });
    for (const r of created) {
      count++;
      console.log(`  ${job.label}: customer ${r.customerId} ${r.type} ₹${r.amount.toFixed(2)}`);
    }
  }
  console.log(`${count} reversal row(s) ${APPLY ? 'written' : 'would be written'}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
