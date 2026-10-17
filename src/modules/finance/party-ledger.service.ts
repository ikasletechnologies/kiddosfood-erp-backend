import prisma from '../../lib/prisma';

/**
 * Unified Party Statement (Reports → Party Reports → Party Statement) for
 * Customers, Dealers, Franchises and Vendors: one party, one party type, or
 * all parties.
 *
 * Sources — the posted records each party type already has:
 *  • Customer  — CustomerLedger (sales, payments, returns, adjustments,
 *                opening balance). A Sale Invoice that never posted a SALE
 *                ledger row (e.g. converted from a Sales Order) is added as a
 *                debit, matched by invoice id so nothing is counted twice.
 *  • Dealer    — no ledger table: non-cancelled dealer invoices (debit) and
 *                non-cancelled dealer payments incl. return credits (credit),
 *                the same records the Dealer master balance uses.
 *  • Franchise — FranchiseLedger only (posted entries; an order that never
 *                posted is not a receivable).
 *  • Vendor    — VendorLedger (payable side).
 * Master opening balances are used only when no OPENING_BALANCE ledger row
 * exists for that party (never both).
 *
 * Each party keeps its own running balance. Receivable-side parties
 * (customer, dealer, franchise): balance = debit − credit (positive = they owe
 * us). Vendor: balance = credit − debit (positive = we owe them). Combined
 * views never net unrelated accounts: receivable and payable positions are
 * totalled separately. Opening = all valid activity before the start date;
 * closing = through the end date. Read-only.
 */

export type PartyType = 'CUSTOMER' | 'DEALER' | 'FRANCHISE' | 'VENDOR';
export const PARTY_TYPES: PartyType[] = ['CUSTOMER', 'DEALER', 'FRANCHISE', 'VENDOR'];
type Orientation = 'RECEIVABLE' | 'PAYABLE';
const orientationOf = (t: PartyType): Orientation => (t === 'VENDOR' ? 'PAYABLE' : 'RECEIVABLE');

interface Party { id: string; partyType: PartyType; name: string; phone: string | null; email?: string | null; gstNumber?: string | null; address?: string | null }

interface Entry {
  partyType: PartyType;
  partyId: string;
  date: Date;
  /** Stable tie-breaker for entries at the same instant. */
  seq: string;
  txnType: string;
  particular: string;
  voucherNo: string;
  paymentType: string;
  debit: number;
  credit: number;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const shortId = (id?: string | null) => (id ? id.slice(0, 8).toUpperCase() : '—');
const keyOf = (t: PartyType, id: string) => `${t}:${id}`;

export interface PartyLedgerQuery {
  partyType?: PartyType | 'ALL';
  partyId?: string;
  start?: Date;
  end?: Date;
  search?: string;
  /** Franchise admins: only their own customers, dealers and franchise; no vendors. */
  restrictToFranchiseId?: string | null;
}

export class PartyLedgerService {
  /** Parties the caller may see, by type. */
  static async listParties(restrictToFranchiseId?: string | null): Promise<Party[]> {
    const own = restrictToFranchiseId || null;
    const [customers, dealers, franchises, vendors] = await Promise.all([
      prisma.customer.findMany({ where: own ? { franchiseId: own } : {}, select: { id: true, name: true, phone: true, email: true, gstNumber: true, address: true }, orderBy: { name: 'asc' } }),
      prisma.dealer.findMany({ where: own ? { franchiseId: own } : {}, select: { id: true, name: true, phone: true, email: true, gstNumber: true, address: true }, orderBy: { name: 'asc' } }),
      // HQ is the company itself, not a party.
      prisma.franchise.findMany({ where: { isHQ: false, ...(own ? { id: own } : {}) }, select: { id: true, name: true, contactNum: true, location: true }, orderBy: { name: 'asc' } }),
      own ? Promise.resolve([] as any[]) : prisma.vendor.findMany({ select: { id: true, name: true, contact: true, email: true, gstNumber: true, address: true }, orderBy: { name: 'asc' } }),
    ]);
    return [
      ...franchises.map((f: any) => ({ id: f.id, partyType: 'FRANCHISE' as const, name: f.name, phone: f.contactNum ?? null, email: null, gstNumber: null, address: f.location ?? null })),
      ...customers.map((c) => ({ id: c.id, partyType: 'CUSTOMER' as const, name: c.name, phone: c.phone, email: c.email, gstNumber: c.gstNumber, address: c.address })),
      ...dealers.map((d) => ({ id: d.id, partyType: 'DEALER' as const, name: d.name, phone: d.phone, email: d.email, gstNumber: d.gstNumber, address: d.address })),
      ...vendors.map((v: any) => ({ id: v.id, partyType: 'VENDOR' as const, name: v.name, phone: v.contact ?? null, email: v.email ?? null, gstNumber: v.gstNumber ?? null, address: v.address ?? null })),
    ];
  }

  static async getStatement(q: PartyLedgerQuery) {
    const allParties = await this.listParties(q.restrictToFranchiseId);
    const typeFilter = q.partyType && q.partyType !== 'ALL' ? q.partyType : null;
    let scoped = allParties.filter((p) => !typeFilter || p.partyType === typeFilter);
    if (q.partyId) scoped = scoped.filter((p) => p.id === q.partyId);
    const single = q.partyId ? scoped[0] || null : null;
    if (q.partyId && !single) throw new Error('Party not found or not accessible.');

    const idsByType = (t: PartyType) => scoped.filter((p) => p.partyType === t).map((p) => p.id);
    const end = q.end;
    const entries = (await Promise.all([
      this.customerEntries(idsByType('CUSTOMER'), end),
      this.dealerEntries(idsByType('DEALER'), end),
      this.franchiseEntries(idsByType('FRANCHISE'), end),
      this.vendorEntries(idsByType('VENDOR'), end),
    ])).flat();

    entries.sort((a, b) => a.date.getTime() - b.date.getTime() || a.seq.localeCompare(b.seq));

    const partyByKey = new Map(scoped.map((p) => [keyOf(p.partyType, p.id), p]));
    const startMs = q.start ? q.start.getTime() : -Infinity;
    const search = (q.search || '').trim().toLowerCase();
    const partyMatches = (p: Party) => !search || [p.name, p.phone, p.id, p.gstNumber].some((v) => (v || '').toLowerCase().includes(search));

    // Per-party opening, period totals and running balance.
    const state = new Map<string, { opening: number; debit: number; credit: number; balance: number; rows: number }>();
    const signed = (e: Entry) => (orientationOf(e.partyType) === 'RECEIVABLE' ? e.debit - e.credit : e.credit - e.debit);
    const transactions: Array<Record<string, unknown>> = [];

    for (const e of entries) {
      const key = keyOf(e.partyType, e.partyId);
      const party = partyByKey.get(key);
      if (!party) continue;
      const s = state.get(key) || { opening: 0, debit: 0, credit: 0, balance: 0, rows: 0 };
      if (e.date.getTime() < startMs) {
        s.opening = round2(s.opening + signed(e));
        s.balance = s.opening;
        state.set(key, s);
        continue;
      }
      s.debit = round2(s.debit + e.debit);
      s.credit = round2(s.credit + e.credit);
      s.balance = round2(s.balance + signed(e));
      s.rows += 1;
      state.set(key, s);
      const hit = partyMatches(party) || [e.voucherNo, e.particular, e.txnType].some((v) => v.toLowerCase().includes(search));
      if (!hit) continue;
      transactions.push({
        date: e.date.toISOString(),
        partyId: party.id,
        partyName: party.name,
        partyType: party.partyType,
        txnType: e.txnType,
        particular: e.particular,
        voucherNo: e.voucherNo,
        paymentType: e.paymentType,
        debit: round2(e.debit),
        credit: round2(e.credit),
        balance: s.balance,
        balanceLabel: this.balanceLabel(party.partyType, s.balance),
      });
    }

    const partySummaries = scoped
      .filter((p) => state.has(keyOf(p.partyType, p.id)) || (single && p.id === single.id))
      .filter((p) => !search || partyMatches(p) || transactions.some((t) => t.partyId === p.id && t.partyType === p.partyType))
      .map((p) => {
        const s = state.get(keyOf(p.partyType, p.id)) || { opening: 0, debit: 0, credit: 0, balance: 0, rows: 0 };
        return {
          partyId: p.id, partyName: p.name, partyType: p.partyType, orientation: orientationOf(p.partyType),
          openingBalance: s.opening, totalDebit: s.debit, totalCredit: s.credit, closingBalance: s.balance,
          closingLabel: this.balanceLabel(p.partyType, s.balance), position: this.position(p.partyType, s.balance), transactions: s.rows,
        };
      });

    const combined = {
      parties: partySummaries.length,
      totalDebit: round2(partySummaries.reduce((a, p) => a + p.totalDebit, 0)),
      totalCredit: round2(partySummaries.reduce((a, p) => a + p.totalCredit, 0)),
      // Kept apart, never netted across unrelated accounts.
      totalReceivable: round2(partySummaries.filter((p) => p.position === 'RECEIVABLE').reduce((a, p) => a + Math.abs(p.closingBalance), 0)),
      totalPayable: round2(partySummaries.filter((p) => p.position === 'PAYABLE').reduce((a, p) => a + Math.abs(p.closingBalance), 0)),
    };

    const singleSummary = single ? partySummaries.find((p) => p.partyId === single.id) : null;
    // Newest first for multi-party views is handled by the client; keep chronological here.
    const MAX_ROWS = 5000;
    return {
      parties: allParties.map((p) => ({ id: p.id, name: p.name, partyType: p.partyType, phone: p.phone })),
      scope: { partyType: typeFilter || 'ALL', partyId: single?.id || null },
      period: { start: q.start?.toISOString() || null, end: q.end?.toISOString() || null },
      party: single ? { ...single, orientation: orientationOf(single.partyType) } : null,
      summary: singleSummary
        ? {
            openingBalance: singleSummary.openingBalance, totalDebit: singleSummary.totalDebit, totalCredit: singleSummary.totalCredit,
            closingBalance: singleSummary.closingBalance, closingLabel: singleSummary.closingLabel, position: singleSummary.position,
            outstanding: Math.abs(singleSummary.closingBalance), orientation: singleSummary.orientation,
          }
        : null,
      partySummaries,
      combined,
      transactions: transactions.slice(-MAX_ROWS),
      truncated: transactions.length > MAX_ROWS,
    };
  }

  /** "Dr" when the party owes us (or our advance to a vendor), "Cr" when we owe them. */
  private static balanceLabel(t: PartyType, balance: number): 'Dr' | 'Cr' | '' {
    if (Math.abs(balance) < 0.005) return '';
    const owesUs = orientationOf(t) === 'RECEIVABLE' ? balance > 0 : balance < 0;
    return owesUs ? 'Dr' : 'Cr';
  }

  private static position(t: PartyType, balance: number): 'RECEIVABLE' | 'PAYABLE' | 'SETTLED' {
    if (Math.abs(balance) < 0.005) return 'SETTLED';
    return this.balanceLabel(t, balance) === 'Dr' ? 'RECEIVABLE' : 'PAYABLE';
  }

  // ─── Entry builders (all activity up to `end`; opening is derived) ────────

  private static async customerEntries(ids: string[], end?: Date): Promise<Entry[]> {
    if (!ids.length) return [];
    const upTo = end ? { lte: end } : undefined;
    const [ledgers, orders, customers] = await Promise.all([
      prisma.customerLedger.findMany({ where: { customerId: { in: ids }, ...(upTo ? { createdAt: upTo } : {}) } }),
      prisma.order.findMany({
        where: { customerId: { in: ids }, status: { not: 'CANCELLED' }, ...(upTo ? { createdAt: upTo } : {}) },
        select: { id: true, customerId: true, invoiceNum: true, totalAmount: true, createdAt: true, paymentType: true, invoice: { select: { status: true } } },
      }),
      prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, openingBalance: true, asOfDate: true, createdAt: true } }),
    ]);
    const paymentIds = ledgers.filter((l) => l.referenceType === 'PAYMENT' && l.referenceId).map((l) => l.referenceId!) as string[];
    const payments = paymentIds.length ? await prisma.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, paymentNumber: true } }) : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const extraOrderIds = ledgers.map((l) => l.referenceId).filter((id): id is string => !!id && !orderById.has(id));
    const extraOrders = extraOrderIds.length ? await prisma.order.findMany({ where: { id: { in: extraOrderIds } }, select: { id: true, invoiceNum: true } }) : [];
    const invoiceNum = new Map<string, string>([...orders, ...extraOrders].map((o) => [o.id, o.invoiceNum]));
    const paymentNum = new Map(payments.map((p) => [p.id, p.paymentNumber || shortId(p.id)]));

    const out: Entry[] = [];
    const postedSales = new Set<string>();
    const withOpeningRow = new Set<string>();
    for (const l of ledgers) {
      if (l.referenceType === 'SALE' && l.referenceId) postedSales.add(l.referenceId);
      if (l.referenceType === 'OPENING_BALANCE') withOpeningRow.add(l.customerId);
      const ref = l.referenceId || '';
      const voucher = invoiceNum.get(ref) || paymentNum.get(ref) || (l.referenceType === 'OPENING_BALANCE' ? 'OPENING' : shortId(ref));
      const txnType = { SALE: 'Sale Invoice', PAYMENT: 'Payment Received', RETURN: 'Sales Return / Credit', ADJUSTMENT: 'Adjustment / Reversal', OPENING_BALANCE: 'Opening Balance' }[l.referenceType] || l.referenceType;
      out.push({
        partyType: 'CUSTOMER', partyId: l.customerId, date: l.createdAt, seq: `${l.createdAt.toISOString()}-L-${l.id}`,
        txnType, particular: l.note || txnType, voucherNo: voucher, paymentType: l.referenceType === 'PAYMENT' ? l.paymentMode : '—',
        debit: l.type === 'DEBIT' ? l.amount : 0, credit: l.type === 'CREDIT' ? l.amount : 0,
      });
    }
    // Invoices for the customer that never posted a SALE ledger row.
    for (const o of orders) {
      if (!o.customerId || postedSales.has(o.id) || o.invoice?.status === 'CANCELLED') continue;
      out.push({
        partyType: 'CUSTOMER', partyId: o.customerId, date: o.createdAt, seq: `${o.createdAt.toISOString()}-O-${o.id}`,
        txnType: 'Sale Invoice', particular: `Invoice ${o.invoiceNum} (not posted to customer ledger)`, voucherNo: o.invoiceNum, paymentType: o.paymentType || '—',
        debit: o.totalAmount, credit: 0,
      });
    }
    for (const c of customers) {
      const ob = Number(c.openingBalance) || 0;
      if (!ob || withOpeningRow.has(c.id)) continue;
      const date = c.asOfDate || c.createdAt;
      if (end && date > end) continue; // opening dated after the period end
      out.push({ partyType: 'CUSTOMER', partyId: c.id, date, seq: `${date.toISOString()}-A`, txnType: 'Opening Balance', particular: 'Customer opening balance', voucherNo: 'OPENING', paymentType: '—', debit: ob > 0 ? ob : 0, credit: ob < 0 ? -ob : 0 });
    }
    return out;
  }

  private static async dealerEntries(ids: string[], end?: Date): Promise<Entry[]> {
    if (!ids.length) return [];
    const upTo = end ? { lte: end } : undefined;
    const [orders, dealers] = await Promise.all([
      prisma.order.findMany({
        where: { partyType: 'DEALER', partyId: { in: ids }, status: { not: 'CANCELLED' }, ...(upTo ? { createdAt: upTo } : {}) },
        select: { id: true, partyId: true, invoiceNum: true, totalAmount: true, createdAt: true, paymentType: true, invoice: { select: { id: true, status: true } } },
      }),
      prisma.dealer.findMany({ where: { id: { in: ids } }, select: { id: true, openingBalance: true, asOfDate: true, createdAt: true } }),
    ]);
    const orderIds = orders.map((o) => o.id);
    const invoiceIds = orders.map((o) => o.invoice?.id).filter(Boolean) as string[];
    const payments = await prisma.payment.findMany({
      where: {
        isCancelled: false, status: { not: 'CANCELLED' }, ...(upTo ? { createdAt: upTo } : {}),
        OR: [
          { entityType: 'DEALER', entityId: { in: ids } },
          ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
          ...(invoiceIds.length ? [{ allocations: { some: { invoiceId: { in: invoiceIds } } } }] : []),
        ],
      },
      select: { id: true, entityId: true, entityType: true, orderId: true, paidAmount: true, createdAt: true, paymentNumber: true, transactionRef: true, paymentMode: true, linkedDocType: true },
    });
    const dealerOfOrder = new Map(orders.map((o) => [o.id, o.partyId!]));
    const out: Entry[] = [];
    for (const o of orders) {
      if (o.invoice?.status === 'CANCELLED') continue;
      out.push({ partyType: 'DEALER', partyId: o.partyId!, date: o.createdAt, seq: `${o.createdAt.toISOString()}-O-${o.id}`, txnType: 'Sale Invoice', particular: `Invoice ${o.invoiceNum}`, voucherNo: o.invoiceNum, paymentType: o.paymentType || '—', debit: o.totalAmount, credit: 0 });
    }
    for (const p of payments) {
      const dealerId = p.entityType === 'DEALER' && p.entityId && ids.includes(p.entityId) ? p.entityId : (p.orderId ? dealerOfOrder.get(p.orderId) : undefined);
      if (!dealerId) continue;
      const isReturn = p.linkedDocType === 'DIRECT' && /return/i.test(p.transactionRef || '');
      out.push({
        partyType: 'DEALER', partyId: dealerId, date: p.createdAt, seq: `${p.createdAt.toISOString()}-P-${p.id}`,
        txnType: isReturn ? 'Return Credit' : 'Payment Received', particular: p.transactionRef || 'Payment received', voucherNo: p.paymentNumber || shortId(p.id), paymentType: p.paymentMode,
        debit: 0, credit: p.paidAmount,
      });
    }
    for (const d of dealers) {
      const ob = Number(d.openingBalance) || 0;
      if (!ob) continue;
      const date = d.asOfDate || d.createdAt;
      if (end && date > end) continue; // opening dated after the period end
      out.push({ partyType: 'DEALER', partyId: d.id, date, seq: `${date.toISOString()}-A`, txnType: 'Opening Balance', particular: 'Dealer opening balance', voucherNo: 'OPENING', paymentType: '—', debit: ob > 0 ? ob : 0, credit: ob < 0 ? -ob : 0 });
    }
    return out;
  }

  private static async franchiseEntries(ids: string[], end?: Date): Promise<Entry[]> {
    if (!ids.length) return [];
    const rows = await prisma.franchiseLedger.findMany({ where: { franchiseId: { in: ids }, ...(end ? { createdAt: { lte: end } } : {}) } });
    const label = { ORDER: 'Franchise Order', PAYMENT: 'Payment Received', RETURN: 'Return / Credit Note', ADJUSTMENT: 'Adjustment', OPENING_BALANCE: 'Opening Balance' } as Record<string, string>;
    return rows.map((r) => ({
      partyType: 'FRANCHISE' as const, partyId: r.franchiseId, date: r.createdAt, seq: `${r.createdAt.toISOString()}-F-${r.id}`,
      txnType: label[r.referenceType] || r.referenceType, particular: r.note || label[r.referenceType] || r.referenceType,
      voucherNo: r.referenceId || (r.referenceType === 'OPENING_BALANCE' ? 'OPENING' : '—'), paymentType: '—',
      debit: r.type === 'DEBIT' ? r.amount : 0, credit: r.type === 'CREDIT' ? r.amount : 0,
    }));
  }

  private static async vendorEntries(ids: string[], end?: Date): Promise<Entry[]> {
    if (!ids.length) return [];
    const [rows, vendors] = await Promise.all([
      prisma.vendorLedger.findMany({ where: { vendorId: { in: ids }, ...(end ? { createdAt: { lte: end } } : {}) }, include: { invoice: { select: { invoiceNumber: true } } } }),
      prisma.vendor.findMany({ where: { id: { in: ids } }, select: { id: true, openingBalance: true, asOfDate: true, createdAt: true } }),
    ]);
    const refIds = rows.map((r) => r.referenceId).filter(Boolean) as string[];
    const [pos, pays] = refIds.length
      ? await Promise.all([
          prisma.procurementOrder.findMany({ where: { id: { in: refIds } }, select: { id: true, poNumber: true } }),
          prisma.payment.findMany({ where: { id: { in: refIds } }, select: { id: true, paymentNumber: true } }),
        ])
      : [[], []];
    const voucherOf = new Map<string, string>([...pos.map((p) => [p.id, p.poNumber] as [string, string]), ...pays.map((p) => [p.id, p.paymentNumber || shortId(p.id)] as [string, string])]);
    const label = { PO: 'Purchase Order', PURCHASE: 'Purchase Bill', PAYMENT: 'Payment Made', ADVANCE: 'Advance Paid', ADJUSTMENT: 'Adjustment', OPENING_BALANCE: 'Opening Balance', RETURN: 'Purchase Return', REFUND: 'Refund Received' } as Record<string, string>;
    const withOpeningRow = new Set(rows.filter((r) => r.referenceType === 'OPENING_BALANCE').map((r) => r.vendorId));
    const out: Entry[] = rows.map((r) => ({
      partyType: 'VENDOR' as const, partyId: r.vendorId, date: r.createdAt, seq: `${r.createdAt.toISOString()}-V-${r.id}`,
      txnType: label[r.referenceType] || r.referenceType, particular: r.note || label[r.referenceType] || r.referenceType,
      voucherNo: r.invoice?.invoiceNumber || (r.referenceId && voucherOf.get(r.referenceId)) || (r.referenceType === 'OPENING_BALANCE' ? 'OPENING' : shortId(r.referenceId)),
      paymentType: ['PAYMENT', 'ADVANCE', 'REFUND'].includes(r.referenceType) ? r.paymentMode : '—',
      debit: r.type === 'DEBIT' ? r.amount : 0, credit: r.type === 'CREDIT' ? r.amount : 0,
    }));
    for (const v of vendors) {
      const ob = Number(v.openingBalance) || 0;
      if (!ob || withOpeningRow.has(v.id)) continue;
      const date = v.asOfDate || v.createdAt;
      if (end && date > end) continue; // opening dated after the period end
      // Vendor opening: positive = we owe the vendor (payable, credit side).
      out.push({ partyType: 'VENDOR', partyId: v.id, date, seq: `${date.toISOString()}-A`, txnType: 'Opening Balance', particular: 'Vendor opening balance', voucherNo: 'OPENING', paymentType: '—', debit: ob < 0 ? -ob : 0, credit: ob > 0 ? ob : 0 });
    }
    return out;
  }
}
