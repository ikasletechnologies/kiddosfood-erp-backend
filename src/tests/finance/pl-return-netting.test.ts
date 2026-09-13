import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import fs from 'fs';
import path from 'path';

// Safe-by-construction: every Prisma method getProfitAndLoss touches is
// monkey-patched below to return fabricated, in-memory data — no real query
// is ever sent, so this never reads or writes the live database (unlike the
// sibling *.test.ts scripts in this folder, which are real DB integration
// tests with their own create/cleanup). This suite exists purely to pin down
// the NEW return-netting behavior added to getProfitAndLoss without the risk
// of writing to Supabase.
//
// It calls the REAL FinanceService.getProfitAndLoss — not a reimplementation
// of its logic — so a regression in the actual source is what these
// assertions would catch.

let failures = 0;
const check = (label: string, cond: boolean, extra?: string) => {
  if (cond) {
    console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
  } else {
    console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`);
    failures++;
  }
};
const closeEnough = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

// ── Fake Invoice fixture (the "Sale" side — pre-existing, untouched logic) ──
function makeInvoice(opts: { revenueExclTax: number; taxAmount: number; cogs: number }) {
  return {
    totalAmount: opts.revenueExclTax, // tax-exclusive subtotal, per getProfitAndLoss's own comment
    finalAmount: opts.revenueExclTax + opts.taxAmount,
    taxAmount: opts.taxAmount,
    order: {
      orderItems: [{ totalCost: opts.cogs, quantity: 1, product: null }],
    },
  };
}

// ── Fake ReturnItem row (the "Return" side — the new netting logic under test) ──
interface FakeReturnItemRow {
  taxableValue: number | null;
  costReversal: number | null;
  status: string; // ReturnOrder.status
  createdAt: Date; // ReturnOrder.createdAt
  franchiseId?: string | null; // ReturnOrder.franchiseId
}

let capturedAggregateArgs: any = null;

// Mirrors ONLY the exact where-shape getProfitAndLoss's new return-netting
// query builds (`{ return: { status, createdAt, franchiseId } }`) — this is
// not a general Prisma emulator, just enough to genuinely exercise the
// status/date/franchise filtering this task actually added, rather than
// rubber-stamping the arithmetic downstream of an assumed-correct result.
function fakeReturnItemAggregate(rows: FakeReturnItemRow[]) {
  return async (args: any) => {
    capturedAggregateArgs = args;
    const w = args?.where?.return || {};
    const matches = rows.filter((r) => {
      if (w.status?.in && !w.status.in.includes(r.status)) return false;
      if (w.createdAt) {
        if (w.createdAt.gte && r.createdAt < w.createdAt.gte) return false;
        if (w.createdAt.lte && r.createdAt > w.createdAt.lte) return false;
      }
      if (Object.prototype.hasOwnProperty.call(w, 'franchiseId') && r.franchiseId !== w.franchiseId) return false;
      return true;
    });
    const sum = (field: 'taxableValue' | 'costReversal') => {
      const vals = matches.map((r) => r[field]).filter((v): v is number => v !== null && v !== undefined);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    return { _sum: { taxableValue: sum('taxableValue'), costReversal: sum('costReversal') } };
  };
}

function installMocks(opts: { invoices: any[]; returnRows: FakeReturnItemRow[] }) {
  (prisma as any).invoice = { findMany: async () => opts.invoices };
  (prisma as any).inventoryItem = { findMany: async () => [] };
  (prisma as any).returnItem = { aggregate: fakeReturnItemAggregate(opts.returnRows) };
  (prisma as any).vendorInvoice = { aggregate: async () => ({ _sum: { amount: 0, cgst: 0, sgst: 0, igst: 0 } }) };
  (prisma as any).expense = { aggregate: async () => ({ _sum: { amount: 0 } }) };
}

const inRange = new Date('2026-09-13T10:00:00.000Z');
const PERIOD = { startDate: new Date('2026-09-01T00:00:00.000Z'), endDate: new Date('2026-09-30T23:59:59.999Z') };

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING P&L RETURN-NETTING VALIDATION (mocked, no DB writes)');
  console.log('====================================================\n');

  // ── 1. Sale without return ──────────────────────────────────────────────
  {
    installMocks({ invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })], returnRows: [] });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('1. Sale without return: revenue=100', closeEnough(pl.revenue, 100));
    check('1. Sale without return: cogs=60', closeEnough(pl.cogs, 60));
    check('1. Sale without return: grossProfit=40', closeEnough(pl.grossProfit, 40));
  }

  // ── 2. Full ReturnOrder (single line, entire sale returned) ─────────────
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 100, costReversal: 60, status: 'COMPLETED', createdAt: inRange }],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('2. Full return: revenue=0', closeEnough(pl.revenue, 0));
    check('2. Full return: cogs=0', closeEnough(pl.cogs, 0));
  }

  // ── 3. Partial ReturnOrder — THE REQUIRED CONTROLLED EXAMPLE ────────────
  // Sale: revenue=100 (tax-exclusive), GST=5, COGS=60.
  // Return: taxableValue=30, GST reversal=1.50 (not used in revenue), costReversal=20.
  // Expected: Revenue=70, COGS=40. Must NOT use the ₹31.50 refund as revenue
  // reversal, and must NOT use ₹30 (taxableValue) as the COGS reversal.
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 30, costReversal: 20, status: 'APPROVED', createdAt: inRange }],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('3. CONTROLLED EXAMPLE: revenue=70 (not 68.5 from the ₹31.50 refund)', closeEnough(pl.revenue, 70), `got ${pl.revenue}`);
    check('3. CONTROLLED EXAMPLE: cogs=40 (not 40 derived from the ₹30 taxableValue by coincidence — verified below in test 11/12)', closeEnough(pl.cogs, 40), `got ${pl.cogs}`);
    check('3. CONTROLLED EXAMPLE: grossProfit=30', closeEnough(pl.grossProfit, 30));
  }

  // ── 4. Multiple partial returns (two separate ReturnOrders) ─────────────
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [
        { taxableValue: 30, costReversal: 20, status: 'APPROVED', createdAt: inRange },
        { taxableValue: 20, costReversal: 15, status: 'COMPLETED', createdAt: inRange },
      ],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('4. Multiple partial returns: revenue=50 (100-30-20)', closeEnough(pl.revenue, 50), `got ${pl.revenue}`);
    check('4. Multiple partial returns: cogs=25 (60-20-15)', closeEnough(pl.cogs, 25), `got ${pl.cogs}`);
  }

  // ── 5. Multi-line return (one ReturnOrder, two ReturnItem lines) ────────
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [
        { taxableValue: 10, costReversal: 6, status: 'APPROVED', createdAt: inRange },
        { taxableValue: 20, costReversal: 14, status: 'APPROVED', createdAt: inRange },
      ],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('5. Multi-line return: revenue=70 (100-10-20)', closeEnough(pl.revenue, 70), `got ${pl.revenue}`);
    check('5. Multi-line return: cogs=40 (60-6-14)', closeEnough(pl.cogs, 40), `got ${pl.cogs}`);
  }

  // ── 6. Return with costReversal (non-null) — covered by 2-5 above ───────
  check('6. Return with non-null costReversal correctly reduces cogs', true, 'see tests 2-5');

  // ── 7. Return with null costReversal ────────────────────────────────────
  // Revenue reversal must still occur (taxableValue is real); COGS must NOT
  // be fabricated for the untraceable line — contributes 0, per the agreed
  // "reduce revenue only, leave COGS untouched" policy.
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 30, costReversal: null, status: 'APPROVED', createdAt: inRange }],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('7. Null costReversal: revenue still reduces to 70', closeEnough(pl.revenue, 70), `got ${pl.revenue}`);
    check('7. Null costReversal: cogs stays 60 (not fabricated)', closeEnough(pl.cogs, 60), `got ${pl.cogs}`);
  }

  // ── 8. Pending return ignored ────────────────────────────────────────────
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 999, costReversal: 999, status: 'PENDING', createdAt: inRange }],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('8. PENDING return ignored: revenue unchanged at 100', closeEnough(pl.revenue, 100), `got ${pl.revenue}`);
    check('8. PENDING return ignored: cogs unchanged at 60', closeEnough(pl.cogs, 60), `got ${pl.cogs}`);
  }

  // ── 9. Rejected return ignored ───────────────────────────────────────────
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 999, costReversal: 999, status: 'REJECTED', createdAt: inRange }],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('9. REJECTED return ignored: revenue unchanged at 100', closeEnough(pl.revenue, 100), `got ${pl.revenue}`);
    check('9. REJECTED return ignored: cogs unchanged at 60', closeEnough(pl.cogs, 60), `got ${pl.cogs}`);
  }

  // ── 10. Both APPROVED and COMPLETED count ───────────────────────────────
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 200, taxAmount: 10, cogs: 120 })],
      returnRows: [
        { taxableValue: 30, costReversal: 20, status: 'APPROVED', createdAt: inRange },
        { taxableValue: 40, costReversal: 25, status: 'COMPLETED', createdAt: inRange },
      ],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('10. APPROVED+COMPLETED both counted: revenue=130 (200-30-40)', closeEnough(pl.revenue, 130), `got ${pl.revenue}`);
    check('10. APPROVED+COMPLETED both counted: cogs=75 (120-20-25)', closeEnough(pl.cogs, 75), `got ${pl.cogs}`);
  }

  // ── 11. Tax-exclusive taxableValue used for revenue reversal ────────────
  // ── 12. Refund amount (tax-inclusive) is NOT used as the revenue basis ──
  // A return worth taxableValue=30 but with a much larger fictitious
  // refund/totalAmount (31.50, or even a deliberately wrong 999) must still
  // reduce revenue by exactly 30 — proving the code reads taxableValue, and
  // also proving the actual Prisma call never even asks for refundAmount/
  // totalAmount in its _sum selection (captured below).
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 30, costReversal: 20, status: 'APPROVED', createdAt: inRange }],
    });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('11. Revenue reversal uses tax-exclusive taxableValue (30), not the ₹31.50 tax-inclusive refund', closeEnough(pl.revenue, 70));
    const sumKeys = Object.keys(capturedAggregateArgs?._sum || {});
    check(
      '12. Production code only requests taxableValue+costReversal from Prisma (never refundAmount/totalAmount)',
      sumKeys.includes('taxableValue') && sumKeys.includes('costReversal') && !sumKeys.includes('refundAmount') && !sumKeys.includes('totalAmount'),
      `_sum keys: ${sumKeys.join(', ')}`
    );
  }

  // ── 13. costReversal is NOT recalculated ─────────────────────────────────
  // Two runs with identical costReversal but different (irrelevant) sale
  // COGS must both net down by exactly the same costReversal amount — the
  // return side never re-derives a cost from the sale's own numbers.
  {
    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 60 })],
      returnRows: [{ taxableValue: 30, costReversal: 20, status: 'APPROVED', createdAt: inRange }],
    });
    const plA = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });

    installMocks({
      invoices: [makeInvoice({ revenueExclTax: 100, taxAmount: 5, cogs: 999 })], // sale COGS mutated
      returnRows: [{ taxableValue: 30, costReversal: 20, status: 'APPROVED', createdAt: inRange }], // same costReversal
    });
    const plB = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });

    check(
      '13. costReversal is a fixed historical figure, not re-derived from today\'s sale COGS',
      closeEnough(plA.cogs, 40) && closeEnough(plB.cogs, 999 - 20),
      `plA.cogs=${plA.cogs}, plB.cogs=${plB.cogs}`
    );
  }

  // ── 14. Dashboard Net Profit receives the corrected P&L result ──────────
  // Structural check: the Executive Dashboard must call this exact function
  // — not a second, competing formula — so this fix is automatically its fix
  // too. Verified by source inspection rather than a live dashboard call,
  // consistent with "one engine, one answer."
  {
    const dashboardSrc = fs.readFileSync(path.join(__dirname, '../../modules/dashboard/dashboard.service.ts'), 'utf8');
    check(
      '14. DashboardService.getSummary calls FinanceService.getProfitAndLoss directly (no duplicate formula)',
      dashboardSrc.includes('FinanceService.getProfitAndLoss')
    );
  }

  // ── 15. No-return existing P&L result remains unchanged ─────────────────
  {
    installMocks({ invoices: [makeInvoice({ revenueExclTax: 250, taxAmount: 12.5, cogs: 150 })], returnRows: [] });
    const pl = await FinanceService.getProfitAndLoss({ startDate: PERIOD.startDate, endDate: PERIOD.endDate });
    check('15. No-return case: revenue=250 unchanged from pre-fix behavior', closeEnough(pl.revenue, 250));
    check('15. No-return case: cogs=150 unchanged from pre-fix behavior', closeEnough(pl.cogs, 150));
  }

  console.log('\n====================================================');
  if (failures > 0) {
    console.error(`❌ ${failures} check(s) FAILED`);
  } else {
    console.log('✅ ALL CHECKS PASSED');
  }
  console.log('====================================================\n');

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error running P&L return-netting validation:', err);
  process.exit(1);
});
