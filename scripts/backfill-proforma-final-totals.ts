/**
 * One-off correction: ProformaInvoice.totalAmount / discountAmount for
 * invoices saved before create/updateProformaInvoice stored the final total.
 * Those rows lack the invoice round-off and, when lines carried discounts,
 * subtracted the discount a second time — so summary cards (which sum
 * totalAmount) disagreed with the amounts the list shows.
 *
 * Recomputes each invoice from its own stored line items with the same
 * calculateTotals the API uses, plus the nearest-rupee round-off the list
 * applies. Only totalAmount and discountAmount change; items, GST, status
 * and everything else are untouched. Idempotent (a correct row is skipped).
 *
 *   npx tsx scripts/backfill-proforma-final-totals.ts          # dry run: report only
 *   npx tsx scripts/backfill-proforma-final-totals.ts --apply  # write the corrections
 */
import prisma from '../src/lib/prisma';
import { calculateTotals, resolveDocumentRoundOff } from '../src/modules/sales/sales.service';

const APPLY = process.argv.includes('--apply');
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const invoices = await prisma.proformaInvoice.findMany({
    include: { items: true },
    orderBy: { createdAt: 'asc' }
  });

  let changed = 0;
  for (const pi of invoices) {
    if (!pi.items.length) continue;
    const { totalDiscount, totalAmount } = calculateTotals(pi.items as any[], 0);
    // Round-off on (1 = any non-zero flag) — what the list has been showing.
    const finalTotal = round2(Math.max(0, totalAmount + resolveDocumentRoundOff(1, totalAmount)));
    if (Math.abs(finalTotal - pi.totalAmount) < 0.005 && Math.abs(totalDiscount - pi.discountAmount) < 0.005) continue;

    changed++;
    console.log(`  ${pi.proformaNumber} [${pi.status}] total ₹${pi.totalAmount.toFixed(2)} → ₹${finalTotal.toFixed(2)}, discount ₹${pi.discountAmount.toFixed(2)} → ₹${totalDiscount.toFixed(2)}`);
    if (APPLY) {
      await prisma.proformaInvoice.update({
        where: { id: pi.id },
        data: { totalAmount: finalTotal, discountAmount: totalDiscount }
      });
    }
  }
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${invoices.length} proforma invoices checked, ${changed} ${APPLY ? 'corrected' : 'would be corrected'}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
