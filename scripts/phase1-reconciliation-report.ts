/**
 * READ-ONLY reconciliation report for data affected by the Phase 1 defects
 * (audit C-03, C-04, C-05, C-07). It never writes. Run it against a COPY of
 * production first, then hand the output to accounting: corrections must be
 * posted as new, append-only adjustment entries after sign-off — never by
 * editing or deleting historical rows.
 *
 *   npx tsx scripts/phase1-reconciliation-report.ts
 */
import prisma from '../src/lib/prisma';

const money = (n: number) => `₹${(Math.round(n * 100) / 100).toFixed(2)}`;

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n=== ${title} ===`);
  try { await fn(); } catch (e: any) { console.log(`  (could not evaluate: ${e.message})`); }
}

async function main() {
  // C-05: phantom payables written by the old cancelPO / deletePO.
  await section('C-05 Phantom vendor CREDITs from PO cancel/delete', async () => {
    const rows = await prisma.vendorLedger.findMany({
      where: { type: 'CREDIT', referenceType: 'ADJUSTMENT', OR: [{ note: { startsWith: 'PO Cancelled — Reversal' } }, { note: { startsWith: 'PO Deleted — Reversal' } }] },
      select: { vendorId: true, amount: true, referenceId: true, createdAt: true },
    });
    const byVendor = new Map<string, { n: number; total: number }>();
    rows.forEach(r => { const v = byVendor.get(r.vendorId) || { n: 0, total: 0 }; v.n++; v.total += r.amount; byVendor.set(r.vendorId, v); });
    console.log(`  ${rows.length} row(s), ${money(rows.reduce((s, r) => s + r.amount, 0))} total overstated payable`);
    for (const [vendorId, v] of byVendor) console.log(`  vendor ${vendorId}: ${v.n} row(s), ${money(v.total)}`);
    const zeroBalance = await prisma.vendorLedger.count({ where: { balanceAfterTransaction: 0, referenceType: 'ADJUSTMENT', note: { contains: 'Reversal of PO' } } });
    console.log(`  rows with balanceAfterTransaction=0 (running balance corrupted after them): ${zeroBalance}`);
  });

  // C-04: GRN-rejection returns that debited the vendor ledger.
  await section('C-04 GRN-rejection returns that reduced vendor payables', async () => {
    const returns = await prisma.purchaseReturn.findMany({ where: { returnSource: 'GRN_REJECTION', status: 'COMPLETED' }, select: { id: true, returnNumber: true, vendorId: true } });
    let total = 0; let n = 0;
    for (const r of returns) {
      const ledger = await prisma.vendorLedger.findMany({ where: { vendorId: r.vendorId, referenceType: 'RETURN', OR: [{ referenceId: r.returnNumber }, { referenceId: r.id }] }, select: { amount: true, type: true } });
      const net = ledger.reduce((s, l) => s + (l.type === 'DEBIT' ? l.amount : -l.amount), 0);
      if (Math.abs(net) > 0.009) { n++; total += net; console.log(`  ${r.returnNumber} vendor ${r.vendorId}: payable reduced by ${money(net)}`); }
    }
    console.log(`  ${n} return(s), ${money(total)} total understated payable`);
    const unbounded = await prisma.purchaseReturn.count({ where: { returnSource: 'GRN_REJECTION', goodsReceiptId: null } });
    console.log(`  legacy GRN-rejection returns not linked to a GRN (client-generated, quantities unverified): ${unbounded}`);
  });

  // C-07: legacy payments whose direction could not be classified.
  await section('C-07 Payments without a classified flow (cannot be cancelled until reviewed)', async () => {
    const rows = await prisma.payment.groupBy({ by: ['sourceModule', 'type', 'entityType'], where: { flow: null, type: { not: 'REVERSAL' } }, _count: true, _sum: { paidAmount: true } });
    if (!rows.length) console.log('  none');
    rows.forEach(r => console.log(`  ${r.sourceModule}/${r.type}/${r.entityType || '-'}: ${r._count} payment(s), ${money(r._sum.paidAmount || 0)}`));
  });

  // C-07: payments cancelled under the old code (vendor ledger never reversed,
  // account possibly moved the wrong way).
  await section('C-07 Previously cancelled payments needing review', async () => {
    const cancelled = await prisma.payment.findMany({ where: { isCancelled: true, type: { not: 'REVERSAL' } }, select: { id: true, paymentNumber: true, entityType: true, type: true, sourceModule: true, paidAmount: true, flow: true } });
    let vendorUnreversed = 0; let suspectDirection = 0;
    for (const p of cancelled) {
      const rows = await prisma.vendorLedger.findMany({ where: { referenceId: p.id }, select: { type: true, amount: true } });
      const net = rows.reduce((s, r) => s + (r.type === 'CREDIT' ? r.amount : -r.amount), 0);
      if (Math.abs(net) > 0.009) { vendorUnreversed++; console.log(`  vendor ledger still reflects cancelled payment ${p.paymentNumber || p.id}: net ${money(net)}`); }
      const oldGuessOut = p.entityType === 'VENDOR' || p.type === 'EXPENSE';
      const trueOut = p.flow === 'OUT';
      if (p.flow && oldGuessOut !== trueOut) { suspectDirection++; console.log(`  account reversed in the WRONG direction for ${p.paymentNumber || p.id} (${p.sourceModule}/${p.type}): account off by ${money(2 * p.paidAmount)}`); }
    }
    console.log(`  cancelled payments: ${cancelled.length}; vendor ledger not reversed: ${vendorUnreversed}; wrong-direction account reversal: ${suspectDirection}`);
    const franchiseSuccess = await prisma.payment.count({ where: { isCancelled: true, sourceModule: 'FRANCHISE', status: 'SUCCESS' } });
    console.log(`  cancelled franchise payments (old code skipped their account + ledger reversal entirely): ${franchiseSuccess}`);
  });

  // C-03: franchise-order lifecycle anomalies.
  await section('C-03 Franchise orders with lifecycle anomalies', async () => {
    const orders = await prisma.franchiseOrder.findMany({ select: { id: true, orderNumber: true, status: true, franchiseId: true, items: { select: { quantity: true } } } });
    let anomalies = 0;
    for (const o of orders) {
      const ordered = o.items.reduce((s, i) => s + i.quantity, 0);
      const moves = await prisma.stockMovement.groupBy({ by: ['movementType'], where: { referenceId: o.id }, _sum: { quantity: true } });
      const transferIn = moves.filter(m => m.movementType === 'TRANSFER_IN').reduce((s, m) => s + (m._sum.quantity || 0), 0);
      const issues: string[] = [];
      if (transferIn > ordered + 0.0001) issues.push(`franchise received ${transferIn} > ordered ${ordered} (repeated delivery)`);
      if (o.status === 'CANCELLED' && moves.length) issues.push('cancelled but has stock movements (cancelled after dispatch/delivery)');
      if (o.status === 'CANCELLED') {
        const debit = await prisma.franchiseLedger.aggregate({ where: { referenceType: 'ORDER', referenceId: o.orderNumber, type: 'DEBIT' }, _sum: { amount: true } });
        const reversed = await prisma.franchiseLedger.aggregate({ where: { referenceType: 'ADJUSTMENT', referenceId: o.orderNumber, type: 'CREDIT' }, _sum: { amount: true } });
        const open = (debit._sum.amount || 0) - (reversed._sum.amount || 0);
        if (open > 0.009) issues.push(`cancelled but franchise still owes ${money(open)} for it`);
      }
      if (issues.length) { anomalies++; console.log(`  ${o.orderNumber} (${o.status}): ${issues.join('; ')}`); }
    }
    console.log(`  ${anomalies} order(s) with anomalies out of ${orders.length}`);
  });

  // Remaining-risks round ------------------------------------------------------

  await section('Advance paid at PO creation but not reserved (could be offered to other POs)', async () => {
    const rows = await prisma.procurementOrder.findMany({
      where: { status: { notIn: ['CANCELLED', 'CLOSED'] } },
      select: { poNumber: true, vendorId: true, advancePaid: true, advanceApplied: true },
    });
    const gaps = rows.filter(r => (r.advancePaid || 0) - (r.advanceApplied || 0) > 0.009);
    gaps.forEach(r => console.log(`  ${r.poNumber}: advancePaid ${money(r.advancePaid)} vs reserved ${money(r.advanceApplied)} (gap ${money(r.advancePaid - r.advanceApplied)})`));
    console.log(`  ${gaps.length} open PO(s) with unreserved advance`);
  });

  await section('H-04 Advances recorded without any cash movement (old PATCH /advance)', async () => {
    const rows = await prisma.vendorLedger.findMany({ where: { referenceType: 'ADVANCE', note: { startsWith: 'Advance Payment for PO' } }, select: { referenceId: true, amount: true, vendorId: true } });
    let n = 0; let total = 0;
    for (const r of rows) {
      // createPayment-based advances key the ledger row by payment id; the old
      // path keyed it by PO number with no Payment row behind it.
      const pay = await prisma.payment.findUnique({ where: { id: r.referenceId || '' }, select: { id: true } }).catch(() => null);
      if (!pay) { n++; total += r.amount; console.log(`  vendor ${r.vendorId}: advance ${money(r.amount)} for ${r.referenceId} has no Payment / account debit`); }
    }
    console.log(`  ${n} advance(s), ${money(total)} — cash/bank balances overstated by this amount`);
  });

  await section('H-07 Cancelled invoices whose stock was never restored', async () => {
    const cancelled = await prisma.order.findMany({ where: { status: 'CANCELLED' }, select: { id: true, invoiceNum: true } });
    let n = 0;
    for (const o of cancelled) {
      const out = await prisma.stockMovement.count({ where: { referenceType: 'ORDER', referenceId: o.id, movementType: 'SALES_OUT' } });
      const back = await prisma.stockMovement.count({ where: { referenceId: o.id, OR: [{ referenceType: 'INVOICE_CANCEL' }, { movementType: 'SALES_RETURN_IN' }] } });
      if (out > 0 && back === 0) { n++; console.log(`  ${o.invoiceNum}: ${out} SALES_OUT movement(s) never reversed`); }
    }
    console.log(`  ${n} cancelled invoice(s) with stock still deducted`);
  });

  await section('H-08 Duplicate customer ledger postings from legacy POS routes', async () => {
    const sales = await prisma.customerLedger.groupBy({ by: ['referenceId'], where: { referenceType: 'SALE' }, _count: true, _sum: { amount: true } });
    const dupSales = sales.filter(s => s._count > 1);
    dupSales.forEach(s => console.log(`  order ${s.referenceId}: ${s._count} SALE debits totalling ${money(s._sum.amount || 0)}`));
    // Old payOrder wrote its own CREDIT keyed by ORDER id on top of the one
    // createPayment writes keyed by PAYMENT id.
    const orderKeyed = await prisma.customerLedger.findMany({ where: { referenceType: 'PAYMENT', note: { startsWith: 'Payment for Order #' } }, select: { referenceId: true, amount: true } });
    orderKeyed.forEach(r => console.log(`  order ${r.referenceId}: extra payment CREDIT ${money(r.amount)} (double-credited)`));
    console.log(`  ${dupSales.length} order(s) with repeated SALE debits; ${orderKeyed.length} double payment credit(s)`);
  });

  await section('Invoices marked PAID with no payment behind them (old createInvoiceFromOrder)', async () => {
    const paid = await prisma.invoice.findMany({ where: { status: 'PAID' }, select: { id: true, finalAmount: true, order: { select: { invoiceNum: true } } } });
    let n = 0;
    for (const inv of paid) {
      const direct = await prisma.payment.aggregate({ where: { invoiceId: inv.id, status: 'PAID', isCancelled: false }, _sum: { paidAmount: true } });
      const alloc = await prisma.paymentAllocation.aggregate({ where: { invoiceId: inv.id, payment: { status: 'PAID', isCancelled: false } }, _sum: { amount: true } });
      const got = (direct._sum.paidAmount || 0) + (alloc._sum.amount || 0);
      if (got < inv.finalAmount - 0.01) { n++; console.log(`  ${inv.order?.invoiceNum}: PAID but only ${money(got)} of ${money(inv.finalAmount)} received`); }
    }
    console.log(`  ${n} invoice(s) overstated as paid`);
  });

  await section('Employee / franchise logins created with a shared default password', async () => {
    const empUsers = await prisma.employee.findMany({ select: { userId: true } });
    const active = await prisma.user.count({ where: { id: { in: empUsers.map(e => e.userId) }, is_active: true } });
    console.log(`  ${active} active employee login(s) — any created before this fix used password "emp123"; reset them`);
  });

  // C-08: stock adjustments made by franchise admins on items they do not own.
  await section('C-08 Cross-franchise stock adjustments', async () => {
    const adjustments = await prisma.stockMovement.findMany({ where: { movementType: 'ADJUSTMENT', createdBy: { not: null } }, select: { id: true, itemId: true, createdBy: true, quantity: true, createdAt: true, item: { select: { franchiseId: true, name: true } } } });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(adjustments.map(a => a.createdBy!))] } }, select: { id: true, role: true, franchiseId: true } });
    const byId = new Map(users.map(u => [u.id, u]));
    let n = 0;
    for (const a of adjustments) {
      const u = byId.get(a.createdBy!);
      if (u && u.role !== 'SUPER_ADMIN' && u.franchiseId !== a.item.franchiseId) { n++; console.log(`  movement ${a.id}: user ${u.id} (franchise ${u.franchiseId}) adjusted "${a.item.name}" owned by ${a.item.franchiseId || 'HQ'} by ${a.quantity}`); }
    }
    console.log(`  ${n} cross-franchise adjustment(s)`);
  });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
