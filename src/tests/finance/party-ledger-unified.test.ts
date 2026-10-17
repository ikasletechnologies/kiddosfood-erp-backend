// Unified Party Statement (Customer / Dealer / Franchise / Vendor).
// Run: npx tsx src/tests/finance/party-ledger-unified.test.ts
import prisma from '../../lib/prisma';
import { PartyLedgerService } from '../../modules/finance/party-ledger.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`   ✅ PASS: ${label}`);
  else { console.error(`   ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

async function run() {
  const id = `PL${Date.now().toString().slice(-6)}`;
  const hq = await FranchiseService.getHqFranchiseOrNull();
  if (!hq) throw new Error('No HQ franchise');
  const d = (s: string) => new Date(`${s}T10:00:00+05:30`);
  const start = new Date('2026-09-01T00:00:00+05:30');
  const end = new Date('2026-09-30T23:59:59.999+05:30');
  const product = await prisma.product.findFirst();
  if (!product) throw new Error('Need any product for order items');

  const fr = await prisma.franchise.create({ data: { name: `Branch ${id}`, location: 'Test', ownerName: 'T', contactNum: `9${id.slice(-6)}111`, isHQ: false } });
  const cust = await prisma.customer.create({ data: { name: `Cust ${id}`, phone: `8${id.slice(-6)}111`, franchiseId: hq.id } });
  const otherCust = await prisma.customer.create({ data: { name: `OtherBranchCust ${id}`, phone: `8${id.slice(-6)}222`, franchiseId: fr.id } });
  const dealer = await prisma.dealer.create({ data: { name: `Dealer ${id}`, phone: `7${id.slice(-6)}111`, franchiseId: hq.id, openingBalance: 50, asOfDate: new Date('2026-08-01T00:00:00+05:30') } });
  const vendor = await prisma.vendor.create({ data: { name: `Vendor ${id}`, contact: `6${id.slice(-6)}111` } as any });
  const orderIds: string[] = [];
  const mkOrder = async (data: any) => {
    const o = await prisma.order.create({ data: { franchiseId: hq.id, subTotal: data.totalAmount, taxAmount: 0, status: 'COMPLETED', ...data, orderItems: { create: [{ productId: product.id, quantity: 1, price: data.totalAmount }] } } });
    orderIds.push(o.id);
    return o;
  };

  try {
    // Customer: Aug sale 100 (posted) + Aug payment 40 → opening 60.
    const o1 = await mkOrder({ invoiceNum: `INV-${id}-1`, customerId: cust.id, totalAmount: 100, createdAt: d('2026-08-10') });
    await prisma.customerLedger.create({ data: { customerId: cust.id, type: 'DEBIT', amount: 100, paymentMode: 'CASH', referenceType: 'SALE', referenceId: o1.id, createdAt: d('2026-08-10') } });
    await prisma.customerLedger.create({ data: { customerId: cust.id, type: 'CREDIT', amount: 40, paymentMode: 'UPI', referenceType: 'PAYMENT', referenceId: o1.id, createdAt: d('2026-08-12') } });
    // Sept: posted sale 200, unposted converted invoice 30, payment 120, Oct sale (outside).
    const o2 = await mkOrder({ invoiceNum: `INV-${id}-2`, customerId: cust.id, totalAmount: 200, createdAt: d('2026-09-05') });
    await prisma.customerLedger.create({ data: { customerId: cust.id, type: 'DEBIT', amount: 200, paymentMode: 'CASH', referenceType: 'SALE', referenceId: o2.id, createdAt: d('2026-09-05') } });
    await mkOrder({ invoiceNum: `INV-${id}-3`, customerId: cust.id, totalAmount: 30, createdAt: d('2026-09-07') });
    await prisma.customerLedger.create({ data: { customerId: cust.id, type: 'CREDIT', amount: 120, paymentMode: 'CASH', referenceType: 'PAYMENT', referenceId: o2.id, createdAt: d('2026-09-20') } });
    await mkOrder({ invoiceNum: `INV-${id}-4`, customerId: cust.id, totalAmount: 999, createdAt: d('2026-10-05') });

    // Dealer: opening 50; Sept invoice 300, payment 100 linked, return credit 20.
    const dO = await mkOrder({ invoiceNum: `INV-${id}-D`, partyType: 'DEALER', partyId: dealer.id, totalAmount: 300, createdAt: d('2026-09-10') });
    await prisma.payment.create({ data: { orderId: dO.id, paidAmount: 100, entityType: 'DEALER', entityId: dealer.id, status: 'PAID', paymentNumber: `PAY-${id}-D`, createdAt: d('2026-09-11') } });
    await prisma.payment.create({ data: { orderId: dO.id, paidAmount: 20, entityType: 'DEALER', entityId: dealer.id, status: 'SUCCESS', linkedDocType: 'DIRECT', transactionRef: 'Dealer return credit', createdAt: d('2026-09-12') } });
    await prisma.payment.create({ data: { orderId: dO.id, paidAmount: 77, entityType: 'DEALER', entityId: dealer.id, status: 'PAID', isCancelled: true, createdAt: d('2026-09-13') } });

    // Franchise ledger: Sept order 500, payment 450.
    await prisma.franchiseLedger.create({ data: { franchiseId: fr.id, type: 'DEBIT', amount: 500, balanceAfter: 500, referenceType: 'ORDER', referenceId: `FO-${id}`, createdAt: d('2026-09-03') } });
    await prisma.franchiseLedger.create({ data: { franchiseId: fr.id, type: 'CREDIT', amount: 450, balanceAfter: 50, referenceType: 'PAYMENT', referenceId: `FP-${id}`, createdAt: d('2026-09-04') } });

    // Vendor: Sept bill 1000 (credit), payment 600 (debit) → payable 400.
    await prisma.vendorLedger.create({ data: { vendorId: vendor.id, amount: 1000, referenceType: 'PURCHASE', paymentMode: 'CASH', type: 'CREDIT', createdAt: d('2026-09-02') } });
    await prisma.vendorLedger.create({ data: { vendorId: vendor.id, amount: 600, referenceType: 'PAYMENT', paymentMode: 'CASH', type: 'DEBIT', createdAt: d('2026-09-25') } });

    console.log('1️⃣ One customer');
    const c = await PartyLedgerService.getStatement({ partyType: 'CUSTOMER', partyId: cust.id, start, end });
    check('Opening includes posted activity before the period (100 − 40 = 60)', c.summary!.openingBalance === 60, JSON.stringify(c.summary));
    check('Period debits 230 (posted 200 + unposted invoice 30), credits 120', c.summary!.totalDebit === 230 && c.summary!.totalCredit === 120);
    check('Closing = opening + debits − credits = 170 Dr', c.summary!.closingBalance === 170 && c.summary!.closingLabel === 'Dr');
    check('Posted invoice not duplicated; unposted invoice listed once', c.transactions.filter((t: any) => t.voucherNo === `INV-${id}-2` && t.debit > 0).length === 1 && c.transactions.filter((t: any) => t.voucherNo === `INV-${id}-3` && t.debit > 0).length === 1);
    check('Activity after the end date excluded', !c.transactions.some((t: any) => t.voucherNo === `INV-${id}-4`));
    check('Running balance ends at closing', (c.transactions.at(-1) as any).balance === 170);

    console.log('\n2️⃣ One dealer');
    const dl = await PartyLedgerService.getStatement({ partyType: 'DEALER', partyId: dealer.id, start, end });
    check('Dealer opening = master opening 50', dl.summary!.openingBalance === 50);
    check('Dealer: invoice 300, payment 100 + return credit 20, cancelled payment ignored', dl.summary!.totalDebit === 300 && dl.summary!.totalCredit === 120, JSON.stringify(dl.summary));
    check('Dealer closing 230 Dr', dl.summary!.closingBalance === 230);
    check('Return credit labelled', dl.transactions.some((t: any) => t.txnType === 'Return Credit'));

    console.log('\n3️⃣ One franchise / one vendor');
    const f = await PartyLedgerService.getStatement({ partyType: 'FRANCHISE', partyId: fr.id, start, end });
    check('Franchise from its ledger: 500 − 450 = 50 Dr', f.summary!.closingBalance === 50 && f.summary!.closingLabel === 'Dr');
    const v = await PartyLedgerService.getStatement({ partyType: 'VENDOR', partyId: vendor.id, start, end });
    check('Vendor payable 400 Cr', v.summary!.closingBalance === 400 && v.summary!.closingLabel === 'Cr' && v.summary!.position === 'PAYABLE');

    console.log('\n4️⃣ All parties');
    const all = await PartyLedgerService.getStatement({ partyType: 'ALL', start, end, search: id });
    const mine = all.partySummaries.filter((p: any) => p.partyName.includes(id));
    check('All four party types present', ['CUSTOMER', 'DEALER', 'FRANCHISE', 'VENDOR'].every((t) => mine.some((p: any) => p.partyType === t)));
    check('Each party keeps its own running balance', all.transactions.filter((t: any) => t.partyId === cust.id).at(-1)?.balance === 170 && all.transactions.filter((t: any) => t.partyId === vendor.id).at(-1)?.balance === 400);
    check('Receivable and payable kept apart (170+230+50 vs 400)', all.combined.totalReceivable === 450 && all.combined.totalPayable === 400, JSON.stringify(all.combined));
    check('Chronological order', all.transactions.every((t: any, i: number, a: any[]) => i === 0 || a[i - 1].date <= t.date));

    console.log('\n5️⃣ Filters, search and access');
    const dealers = await PartyLedgerService.getStatement({ partyType: 'DEALER', start, end, search: id });
    check('Type filter shows only dealers', dealers.partySummaries.length > 0 && dealers.partySummaries.every((p: any) => p.partyType === 'DEALER'));
    const byVoucher = await PartyLedgerService.getStatement({ partyType: 'ALL', start, end, search: `INV-${id}-3` });
    check('Search by invoice number finds the line', byVoucher.transactions.length === 1 && (byVoucher.transactions[0] as any).voucherNo === `INV-${id}-3`);
    const branch = await PartyLedgerService.getStatement({ partyType: 'ALL', start, end, restrictToFranchiseId: fr.id });
    check('Franchise admin: own franchise and own customers only, no vendors',
      branch.parties.every((p) => (p.partyType === 'FRANCHISE' && p.id === fr.id) || p.partyType === 'CUSTOMER' || p.partyType === 'DEALER')
      && !branch.parties.some((p) => p.id === cust.id) && branch.parties.some((p) => p.id === otherCust.id) && !branch.parties.some((p) => p.partyType === 'VENDOR'));
    let blocked = false;
    try { await PartyLedgerService.getStatement({ partyType: 'VENDOR', partyId: vendor.id, restrictToFranchiseId: fr.id }); } catch { blocked = true; }
    check('Franchise admin cannot open a vendor statement', blocked);
  } finally {
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customerLedger.deleteMany({ where: { customerId: { in: [cust.id, otherCust.id] } } });
    await prisma.customer.deleteMany({ where: { id: { in: [cust.id, otherCust.id] } } });
    await prisma.dealer.delete({ where: { id: dealer.id } });
    await prisma.franchiseLedger.deleteMany({ where: { franchiseId: fr.id } });
    await prisma.franchise.delete({ where: { id: fr.id } });
    await prisma.vendorLedger.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.vendor.delete({ where: { id: vendor.id } });
  }
  if (failures) { console.error(`\n💥 ${failures} CHECK(S) FAILED`); process.exit(1); }
  console.log('\n🎉 ALL UNIFIED PARTY STATEMENT TESTS PASSED');
}

run().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
