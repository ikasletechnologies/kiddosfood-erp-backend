/**
 * READ-ONLY manual acceptance diagnostic for the 29 report-serving
 * FinanceService methods. Calls each service method directly (bypassing
 * HTTP/auth) against the LIVE database, with three franchise scopes
 * (undefined/org-wide, HQ franchise, second franchise) and two date ranges
 * (last 12 months, all-time/undefined). Does not create/update/delete
 * anything — every call below is a read path through FinanceService.
 *
 * Run: npx tsx src/tests/finance/manual-acceptance-diagnostic.script.ts
 */
import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';

function jsonSafe(value: any): any {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

function shapeOf(result: any): string {
  if (result === null || result === undefined) return String(result);
  if (Array.isArray(result)) return `array(len=${result.length})`;
  if (typeof result === 'object') {
    const keys = Object.keys(result);
    const arrKeys = keys.filter(k => Array.isArray(result[k]));
    const arrInfo = arrKeys.map(k => `${k}:len=${result[k].length}`).join(', ');
    return `object(keys=[${keys.join(',')}]${arrInfo ? ` | ${arrInfo}` : ''})`;
  }
  return typeof result;
}

type RunResult = {
  label: string;
  ok: boolean;
  shape?: string;
  error?: string;
  stack?: string;
  sample?: any;
};

const results: RunResult[] = [];

async function run(label: string, fn: () => Promise<any>, extract?: (r: any) => any): Promise<any> {
  const start = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - start;
    const shape = shapeOf(r);
    const sample = extract ? jsonSafe(extract(r)) : undefined;
    results.push({ label, ok: true, shape, sample });
    console.log(`OK   [${ms}ms] ${label} :: ${shape}`);
    if (sample !== undefined) {
      console.log(`       sample: ${JSON.stringify(sample)}`);
    }
    return r;
  } catch (err: any) {
    const ms = Date.now() - start;
    results.push({ label, ok: false, error: err?.message, stack: err?.stack });
    console.error(`FAIL [${ms}ms] ${label} :: ${err?.message}`);
    console.error(err?.stack);
    return undefined;
  }
}

async function main() {
  console.log('='.repeat(100));
  console.log('MANUAL ACCEPTANCE DIAGNOSTIC — 29 FinanceService reports');
  console.log('Run at:', new Date().toISOString());
  console.log('='.repeat(100));

  // ── Live parameters pulled from the DB (read-only) ─────────────────────
  const franchises = await prisma.franchise.findMany({ select: { id: true, name: true } });
  console.log(`\nFranchises found (${franchises.length}):`, franchises.map(f => `${f.id} (${f.name})`).join(' | '));

  const franchiseA = franchises[0]?.id; // e.g. root-franchise / HQ
  const franchiseB = franchises[1]?.id; // e.g. second franchise, if any

  const loanAcct = await prisma.loanAccount.findFirst({ select: { id: true, franchiseId: true } });
  const bankAcct = await prisma.account.findFirst({ where: { type: 'BANK' }, select: { id: true, franchiseId: true } });
  console.log('Loan account for loan-statement drill-down test:', loanAcct ? loanAcct.id : 'NONE FOUND IN DB');
  console.log('Bank account for bank-statement drill-down test:', bankAcct ? bankAcct.id : 'NONE FOUND IN DB');

  // Date ranges
  const now = new Date();
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setFullYear(now.getFullYear() - 1);
  const rangeStart = twelveMonthsAgo; // Date object
  const rangeEnd = now; // Date object
  const rangeStartStr = rangeStart.toISOString();
  const rangeEndStr = rangeEnd.toISOString();

  console.log(`\nDate range (last 12 months): ${rangeStartStr} -> ${rangeEndStr}`);
  console.log('All-time range: undefined/undefined (no date filter applied)\n');

  const scopes: { tag: string; franchiseId: string | undefined }[] = [
    { tag: 'ORG-WIDE (no franchiseId)', franchiseId: undefined },
    { tag: `FRANCHISE-A (${franchiseA})`, franchiseId: franchiseA },
    ...(franchiseB ? [{ tag: `FRANCHISE-B (${franchiseB})`, franchiseId: franchiseB }] : [])
  ];

  // ─────────────────────────────────────────────────────────────────────
  // Run every report once per scope, once per date-window (12mo + all-time)
  // ─────────────────────────────────────────────────────────────────────
  for (const scope of scopes) {
    console.log('\n' + '-'.repeat(100));
    console.log(`SCOPE: ${scope.tag}`);
    console.log('-'.repeat(100));

    for (const dw of [
      { tag: '12mo', start: rangeStart, end: rangeEnd, startStr: rangeStartStr, endStr: rangeEndStr },
      { tag: 'all-time', start: undefined, end: undefined, startStr: undefined, endStr: undefined }
    ]) {
      const p = `[${scope.tag} | ${dw.tag}]`;

      // 1. Profit And Loss
      await run(`1. PL getFinancialReport ${p}`, () =>
        FinanceService.getFinancialReport({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ revenue: r.revenue, cogs: r.cogs, grossProfit: r.grossProfit, expenses: r.expenses, netProfit: r.netProfit, taxPayable: r.taxPayable, taxReceivable: r.taxReceivable })
      );
      await run(`1b. PL getProfitAndLoss(detailed) ${p}`, () =>
        FinanceService.getProfitAndLoss({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ revenue: r.revenue, netProfit: r.netProfit })
      );

      // 2. Balance Sheet
      await run(`2. Balance Sheet ${p}`, () =>
        FinanceService.getBalanceSheetReport({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({
          assets: r.assets?.map((a: any) => ({ name: a.name, amount: a.amount })),
          liabilities: r.liabilities?.map((l: any) => ({ name: l.name, amount: l.amount })),
          details: r.details
        })
      );

      // 3. Cash Flow
      await run(`3. Cash Flow ${p}`, () =>
        FinanceService.getCashFlow(scope.franchiseId ?? null),
        r => ({ totalLiquidity: r.totalLiquidity, breakdown: r.breakdown, accountCount: r.accounts?.length })
      );

      // 4. Trial Balance
      await run(`4. Trial Balance ${p}`, () =>
        FinanceService.getTrialBalanceReport({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({
          totalDebit: Array.isArray(r) ? r.reduce((s: number, x: any) => s + (x.debit || 0), 0) : undefined,
          totalCredit: Array.isArray(r) ? r.reduce((s: number, x: any) => s + (x.credit || 0), 0) : undefined,
          rowCount: Array.isArray(r) ? r.length : undefined
        })
      );

      // 5. Bill Wise Profit
      await run(`5. Bill Wise Profit ${p}`, () =>
        FinanceService.getBillWiseProfitReport({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ rowCount: r?.length, totalProfit: Array.isArray(r) ? Number(r.reduce((s: number, x: any) => s + (x.profit || 0), 0).toFixed(2)) : undefined })
      );

      // 6. Day Book
      await run(`6. Day Book ${p}`, () =>
        FinanceService.getDayBookReport({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ openingBalance: r.openingBalance, closingBalance: r.closingBalance, totalDebit: r.totalDebit, totalCredit: r.totalCredit, rowCount: r.data?.length })
      );

      // 7. Sale Invoices (both routes)
      await run(`7. Sale Invoices getSalesReportDetails ${p}`, () =>
        FinanceService.getSalesReportDetails({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ totalCount: r.pagination?.totalCount, rowCount: r.data?.length })
      );
      await run(`7b. Sale Invoices getInvoices ${p}`, () =>
        FinanceService.getInvoices(scope.franchiseId),
        r => ({ rowCount: r?.length })
      );

      // 8. Purchase Orders
      await run(`8. Purchase Orders ${p}`, () =>
        FinanceService.getPurchasesReportDetails({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ totalCount: r.pagination?.totalCount, rowCount: r.data?.length })
      );

      // 9. Payment Register (All Transactions)
      await run(`9. Payment Register ${p}`, () =>
        FinanceService.getFinancialTransactionsReport({ franchiseId: scope.franchiseId, startDate: dw.start, endDate: dw.end }),
        r => ({ totalDebit: r.totalDebit, totalCredit: r.totalCredit, totalCount: r.pagination?.totalCount })
      );

      // 10-13. GSTR1/2/3B/9
      const gstr1 = await run(`10. GSTR1 ${p}`, () =>
        FinanceService.getGSTR1Data(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ saleCount: r.sale?.length, saleReturnCount: r.saleReturn?.length, totalTaxableValue: r.totalTaxableValue, totalOutputGST: r.totalOutputGST })
      );
      const gstr2 = await run(`11. GSTR2 ${p}`, () =>
        FinanceService.getGSTR2Data(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalTaxableValue: r.totalTaxableValue, totalInputGST: r.totalInputGST })
      );
      const gstr3b = await run(`12. GSTR3B ${p}`, () =>
        FinanceService.getGSTR3BData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ summary: r.summary, eligibleITC: r.eligibleITC?.available?.[0] })
      );
      // GSTR9 uses a financial year string, not a date range — run once per scope (outside dw loop ideally,
      // but harmless to call twice; results will be identical across dw iterations since FY is fixed).
      const gstr9 = await run(`13. GSTR9 ${p} (FY 2025-2026)`, () =>
        FinanceService.getGSTR9Data(scope.franchiseId, '2025-2026'),
        r => ({ summary: r.summary })
      );

      // Cross-reconciliation note (printed once per scope+window)
      if (gstr1 && gstr3b) {
        const diff = Number(((gstr1.totalOutputGST || 0) - (gstr3b.summary?.totalOutputTax || 0)).toFixed(2));
        console.log(`   >> GST RECON [output tax] GSTR1=${gstr1.totalOutputGST} vs GSTR3B=${gstr3b.summary?.totalOutputTax} diff=${diff}`);
      }
      if (gstr2 && gstr3b) {
        const diff = Number(((gstr2.totalInputGST || 0) - (gstr3b.summary?.totalInputTax || 0)).toFixed(2));
        console.log(`   >> GST RECON [input tax/ITC] GSTR2=${gstr2.totalInputGST} vs GSTR3B=${gstr3b.summary?.totalInputTax} diff=${diff}`);
      }
      if (gstr2 && gstr9) {
        const diff = Number(((gstr2.totalInputGST || 0) - (gstr9.summary?.totalInputTax || 0)).toFixed(2));
        console.log(`   >> GST RECON [ITC vs GSTR9] GSTR2=${gstr2.totalInputGST} vs GSTR9=${gstr9.summary?.totalInputTax} diff=${diff}`);
      }

      // 14. HSN Summary
      await run(`14. HSN Summary ${p}`, () =>
        FinanceService.getHsnSummaryData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r?.length, totalTaxable: Array.isArray(r) ? Number(r.reduce((s: number, x: any) => s + (x.taxableValue || 0), 0).toFixed(2)) : undefined })
      );

      // 15. SAC Report
      await run(`15. SAC Report ${p}`, () =>
        FinanceService.getSacReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r?.length })
      );

      // 16. GST Report
      await run(`16. GST Report ${p}`, () =>
        FinanceService.getGstReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalTaxIn: r.totalTaxIn, totalTaxOut: r.totalTaxOut })
      );

      // 17. GST Rate Report
      await run(`17. GST Rate Report ${p}`, () =>
        FinanceService.getGstRateReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalTaxIn: r.totalTaxIn, totalTaxOut: r.totalTaxOut })
      );

      // 18. Form 27EQ
      await run(`18. Form 27EQ ${p}`, () =>
        FinanceService.getForm27eqData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalSaleWithTcs: r.totalSaleWithTcs, totalTcs: r.totalTcs })
      );

      // 19. TCS Receivable
      await run(`19. TCS Receivable ${p}`, () =>
        FinanceService.getTcsReceivableData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalPurchaseWithTcs: r.totalPurchaseWithTcs, totalTcs: r.totalTcs })
      );

      // 20. TDS Payable
      await run(`20. TDS Payable ${p}`, () =>
        FinanceService.getTdsPayableData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalPurchaseWithTds: r.totalPurchaseWithTds, totalTds: r.totalTds })
      );

      // 21. TDS Receivable
      await run(`21. TDS Receivable ${p}`, () =>
        FinanceService.getTdsReceivableData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalSaleWithTds: r.totalSaleWithTds, totalTds: r.totalTds })
      );

      // 22. Expense Report
      await run(`22. Expense Report ${p}`, () =>
        FinanceService.getExpensesReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ summary: r.summary, categoryCount: r.categoryBreakdown?.length })
      );

      // 23. Expense Category Report
      await run(`23. Expense Category Report ${p}`, () =>
        FinanceService.getExpenseCategoryReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ summary: r.summary, categoryCount: r.categoryBreakdown?.length })
      );

      // 24. Expense Item Report
      await run(`24. Expense Item Report ${p}`, () =>
        FinanceService.getExpenseItemReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ summary: r.summary })
      );

      // 25. Sale Orders
      await run(`25. Sale Orders ${p}`, () =>
        FinanceService.getSaleOrdersReportData({ franchiseId: scope.franchiseId, startDate: dw.startStr, endDate: dw.endStr }),
        r => ({ summary: r.summary })
      );

      // 26. Sale Order Items
      await run(`26. Sale Order Item ${p}`, () =>
        FinanceService.getSaleOrderItemsReportData({ franchiseId: scope.franchiseId, startDate: dw.startStr, endDate: dw.endStr }),
        r => ({ rowCount: r?.length })
      );

      // 27. Bank Statement (org-wide/all accounts, plus drill-down if a bank account exists)
      await run(`27. Bank Statement ${p}`, () =>
        FinanceService.getBankStatementData(scope.franchiseId, undefined, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, closingBalance: r.closingBalance })
      );

      // 28. Discount Report
      await run(`28. Discount Report ${p}`, () =>
        FinanceService.getDiscountReportData(scope.franchiseId, dw.startStr, dw.endStr),
        r => ({ rowCount: r.data?.length, totalDiscount: r.totalDiscount })
      );

      // 29. Loan Statement (list-only branch; drill-down tested separately below if a loan exists)
      await run(`29. Loan Statement (list) ${p}`, () =>
        FinanceService.getLoanStatement({ franchiseId: scope.franchiseId as string, startDate: dw.start, endDate: dw.end }),
        r => ({ loanCount: r.loans?.length, summary: r.summary })
      );
    }
  }

  // Loan statement drill-down (only meaningful if a loan account exists)
  if (loanAcct) {
    await run(`29b. Loan Statement (drill-down, loanAccountId=${loanAcct.id})`, () =>
      FinanceService.getLoanStatement({ franchiseId: loanAcct.franchiseId as string, loanAccountId: loanAcct.id }),
      r => ({ summary: r.summary, txnCount: r.transactions?.length })
    );
  } else {
    console.log('\n29b. Loan Statement drill-down SKIPPED — no LoanAccount rows exist in the DB.');
  }

  // Bank statement drill-down (only meaningful if a bank account exists)
  if (bankAcct) {
    await run(`27b. Bank Statement (drill-down, accountId=${bankAcct.id})`, () =>
      FinanceService.getBankStatementData(bankAcct.franchiseId ?? undefined, bankAcct.id, rangeStartStr, rangeEndStr),
      r => ({ rowCount: r.data?.length, closingBalance: r.closingBalance })
    );
  } else {
    console.log('27b. Bank Statement drill-down SKIPPED — no Account rows of type BANK exist in the DB (accountCount=0 total).');
  }

  // ── Franchise isolation spot-check ──────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('FRANCHISE ISOLATION SPOT-CHECK');
  console.log('='.repeat(100));
  if (franchiseB) {
    const [salesA, salesB] = await Promise.all([
      FinanceService.getSalesReportDetails({ franchiseId: franchiseA }),
      FinanceService.getSalesReportDetails({ franchiseId: franchiseB })
    ]);
    console.log(`Franchise A (${franchiseA}) sales totalCount = ${salesA.pagination.totalCount}`);
    console.log(`Franchise B (${franchiseB}) sales totalCount = ${salesB.pagination.totalCount}`);
    console.log(salesA.pagination.totalCount !== salesB.pagination.totalCount
      ? 'RESULT: Franchise-scoped totals DIFFER — isolation filter is effective for this dataset.'
      : 'RESULT: Franchise-scoped totals are EQUAL — inconclusive from this metric alone (could be coincidence or both empty); see raw counts above.');

    const [poA, poB] = await Promise.all([
      FinanceService.getPurchasesReportDetails({ franchiseId: franchiseA }),
      FinanceService.getPurchasesReportDetails({ franchiseId: franchiseB })
    ]);
    console.log(`Franchise A PO totalCount = ${poA.pagination.totalCount}, Franchise B PO totalCount = ${poB.pagination.totalCount}`);
  } else {
    console.log('Only one franchise exists in the DB — cross-franchise isolation CANNOT be empirically verified with two distinct non-empty datasets. Not fabricating a second-franchise comparison.');
  }

  // ── Final summary ────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY');
  console.log('='.repeat(100));
  const failed = results.filter(r => !r.ok);
  console.log(`Total calls: ${results.length}, OK: ${results.length - failed.length}, FAILED: ${failed.length}`);
  if (failed.length) {
    console.log('\nFAILED CALLS:');
    for (const f of failed) {
      console.log(` - ${f.label}: ${f.error}`);
    }
  }

  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('FATAL SCRIPT ERROR:', err);
  await prisma.$disconnect();
  process.exit(1);
});
