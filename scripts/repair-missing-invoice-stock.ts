// Repair: Sale Invoices created by "Sales Order → Sale" / "Estimate → Sale"
// before the fix were flagged inventory_deducted = true but never issued any
// stock (no SALES_OUT movement). This finds them and, only for the invoice
// numbers you name with --apply, issues the stock exactly as the fixed
// conversion now does (selected lots exactly, FIFO otherwise, actual cost
// recorded), one transaction per invoice, with an AuditLog entry.
//
// Safe to re-run: SalesService.issueInvoiceStock does nothing for an invoice
// that already has SALES_OUT movements, so nothing is ever deducted twice.
//
//   npx tsx scripts/repair-missing-invoice-stock.ts                      # list candidates (read-only)
//   npx tsx scripts/repair-missing-invoice-stock.ts INV-2026-00027       # show the plan (read-only)
//   npx tsx scripts/repair-missing-invoice-stock.ts INV-2026-00027 --apply
import prisma from '../src/lib/prisma';
import { SalesService } from '../src/modules/sales/sales.service';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const invoiceNums = args.filter((a) => !a.startsWith('--'));

  // Candidates: claimed deducted, not cancelled, no SALES_OUT movement, and
  // at least one line for a stocked finished good.
  const flagged = await prisma.order.findMany({
    where: {
      inventory_deducted: true,
      status: { not: 'CANCELLED' },
      ...(invoiceNums.length ? { invoiceNum: { in: invoiceNums } } : {}),
    },
    include: { orderItems: { include: { product: { select: { name: true, sku: true } } } }, invoice: { select: { status: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const candidates = [];
  for (const o of flagged) {
    if (o.invoice?.status === 'CANCELLED') continue;
    const moved = await prisma.stockMovement.count({ where: { referenceId: o.id } });
    if (moved > 0) continue;
    const skus = o.orderItems.map((i) => i.product?.sku).filter(Boolean) as string[];
    const stocked = skus.length ? await prisma.inventoryItem.count({ where: { sku: { in: skus }, category: 'FINISHED_GOOD' } }) : 0;
    if (!stocked) continue;
    candidates.push(o);
  }

  if (!candidates.length) {
    console.log(invoiceNums.length ? 'Nothing to repair for the given invoice(s) — stock already issued, cancelled, or no stocked items.' : 'No invoices with missing stock issue found.');
    return;
  }

  for (const o of candidates) {
    console.log(`\n${o.invoiceNum}  (${o.createdAt.toISOString().slice(0, 10)}, ${o.paymentStatus}, seller ${o.franchiseId})`);
    for (const i of o.orderItems) {
      const lot = i.inventoryBatchId ? await prisma.inventoryBatch.findUnique({ where: { id: i.inventoryBatchId }, select: { currentQty: true } }) : null;
      console.log(`  - ${i.product?.name} × ${i.quantity} ${i.lotNumber ? `from lot ${i.lotNumber} (now ${lot?.currentQty ?? '?'})` : '(FIFO)'}`);
    }
  }

  if (!invoiceNums.length) {
    console.log('\nRead-only listing. Re-run with the invoice number(s) and --apply to issue their stock.');
    return;
  }
  if (!apply) {
    console.log('\nDry run — nothing changed. Add --apply to issue this stock.');
    return;
  }

  for (const o of candidates) {
    await prisma.$transaction(async (tx) => {
      const result = await SalesService.issueInvoiceStock(tx, o.id, o.franchiseId, 'REPAIR_SCRIPT');
      await tx.auditLog.create({
        data: {
          module: 'SALES',
          action: 'REPAIR_MISSING_INVOICE_STOCK_ISSUE',
          recordId: o.id,
          oldValue: { invoiceNum: o.invoiceNum, stockMovements: 0 },
          newValue: { issuedLines: result.issued, skipped: result.skipped },
          performedBy: 'repair-missing-invoice-stock.ts',
        },
      });
      console.log(`✅ ${o.invoiceNum}: ${result.skipped ? 'already issued — skipped' : `issued ${result.issued} line(s)`}`);
    }, { timeout: 30000 });
  }
}

main()
  .catch((e) => { console.error('❌', e.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
