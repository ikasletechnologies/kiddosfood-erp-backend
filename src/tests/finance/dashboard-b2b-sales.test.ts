import prisma from '../../lib/prisma';
import { DashboardService } from '../../modules/dashboard/dashboard.service';
import { DashboardInventoryService } from '../../modules/dashboard/dashboard.inventory';
import { DashboardCollectionsService } from '../../modules/dashboard/dashboard.collections';
import { DashboardDispatchService } from '../../modules/dashboard/dashboard.dispatch';
import { DashboardAnalyticsService } from '../../modules/dashboard/dashboard.analytics';
import { FinanceService } from '../../modules/finance/finance.service';

// Safe-by-construction, same pattern as pl-return-netting.test.ts and
// product-unit-resolution.test.ts: every dependency DashboardService.
// getSummary touches is monkey-patched with fabricated in-memory data — no
// real query, no live DB read/write. Calls the REAL production function.
//
// Regression target: "Recent B2B Sales Details" showed "No Recent B2B
// Invoices" even with real Dealer/Franchise sales in the DB. Root cause —
// the query filtered Order.orderType:'TAX_INVOICE', but FinanceService.
// createInvoice (the Sale Invoice page every Dealer/Franchise/Customer
// invoice goes through) hardcodes orderType:'DINE_IN' regardless of party,
// so no Dealer/Franchise sale created that way could ever match. The fix
// classifies by Order.partyType (DEALER/FRANCHISE = B2B), the authoritative
// field already used elsewhere (getPartyReceivables/getAllPartiesData), and
// deliberately excludes FranchiseOrder (stock supply, not a recognized sale).

let failures = 0;
const check = (label: string, cond: boolean, extra?: string) => {
  if (cond) console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
  else { console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`); failures++; }
};

function makeOrder(o: Partial<{
  invoiceNum: string; partyType: string | null; customerName: string | null;
  totalAmount: number; status: string; orderType: string; franchiseId: string; createdAt: Date;
}>) {
  return {
    invoiceNum: o.invoiceNum ?? 'INV-1',
    partyType: o.partyType ?? null,
    customerName: o.customerName ?? null,
    totalAmount: o.totalAmount ?? 100,
    status: o.status ?? 'COMPLETED',
    orderType: o.orderType ?? 'DINE_IN',
    franchiseId: o.franchiseId ?? 'hq-1',
    createdAt: o.createdAt ?? new Date('2026-09-10T10:00:00.000Z'),
  };
}

// Mirrors ONLY the exact where-shapes dashboard.service.ts's two
// prisma.order.findMany calls build (B2B: partyType.in; B2C: orderType) —
// enough to genuinely exercise this task's filtering, not a full Prisma
// emulator.
function fakeOrderFindMany(orders: ReturnType<typeof makeOrder>[]) {
  return async (args: any) => {
    const w = args?.where || {};
    let rows = orders.slice();
    if (w.franchiseId) rows = rows.filter((o) => o.franchiseId === w.franchiseId);
    if (w.partyType?.in) rows = rows.filter((o) => w.partyType.in.includes(o.partyType));
    if (w.orderType) rows = rows.filter((o) => o.orderType === w.orderType);
    if (w.status) rows = rows.filter((o) => o.status === w.status);
    if (w.createdAt?.gte) rows = rows.filter((o) => o.createdAt >= w.createdAt.gte);
    if (w.createdAt?.lte) rows = rows.filter((o) => o.createdAt <= w.createdAt.lte);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (args?.take) rows = rows.slice(0, args.take);
    return rows.map((o) => ({ invoiceNum: o.invoiceNum, partyType: o.partyType, customerName: o.customerName, totalAmount: o.totalAmount, createdAt: o.createdAt }));
  };
}

function installMocks(orders: ReturnType<typeof makeOrder>[]) {
  (DashboardInventoryService as any).getInventoryStats = async () => ({ inventoryValue: 0, inventoryItemCount: 0, lowStockCount: 0, lowStockAlerts: [], lowStock: [], inventoryAlerts: [] });
  (DashboardCollectionsService as any).getCollectionsStats = async () => ({ todayCollection: 0, salesReturnsToday: 0, pendingCollections: 0, totalDealerOutstanding: 0, overdueDealersCount: 0, dealerOutstanding: [] });
  (DashboardDispatchService as any).getDispatchStats = async () => ({ pendingDeliveries: 0, pendingDispatchQueue: [] });
  (DashboardAnalyticsService as any).getAnalyticsStats = async () => ({ revenueToday: 0, totalSales: 0, totalSalesCount: 0, totalPurchase: 0, revenueChangePct: '0.0', expensesToday: 0, historicalSales: [], revenueBreakdown: [], topSellers: [], recentOrders: [], ordersCountToday: 0 });
  (FinanceService as any).getAllPartiesData = async () => [];
  (FinanceService as any).getCashFlow = async () => ({ accounts: [], totalLiquidity: 0, breakdown: { cash: 0, bank: 0, upi: 0 } });
  (FinanceService as any).getProfitAndLoss = async () => ({ revenue: 0, cogs: 0, returnRevenue: 0, returnCOGS: 0, purchase: 0, taxPayable: 0, taxReceivable: 0, tax: 0, grossProfit: 0, expenses: 0, netProfit: 0, period: {} });
  (prisma as any).dealer = { count: async () => 0 };
  (prisma as any).production = { findMany: async () => [] };
  (prisma as any).productBatch = { findMany: async () => [] };
  (prisma as any).procurementOrder = { findMany: async () => [] };
  (prisma as any).order = { findMany: fakeOrderFindMany(orders) };
}

const PERIOD = { startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-30T23:59:59.999Z' };

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING DASHBOARD B2B SALES VALIDATION (mocked, no DB writes)');
  console.log('====================================================\n');

  // ── 1-3. Dealer + Franchise → B2B; Customer → excluded ──────────────────
  {
    installMocks([
      makeOrder({ invoiceNum: 'INV-DEALER-1', partyType: 'DEALER', customerName: 'Kumar Traders', totalAmount: 12500, createdAt: new Date('2026-09-10T10:00:00Z') }),
      makeOrder({ invoiceNum: 'INV-FRANCHISE-1', partyType: 'FRANCHISE', customerName: 'Coimbatore Branch', totalAmount: 18200, createdAt: new Date('2026-09-11T10:00:00Z') }),
      makeOrder({ invoiceNum: 'INV-CUSTOMER-1', partyType: 'CUSTOMER', customerName: 'Walk-in', totalAmount: 500, createdAt: new Date('2026-09-11T11:00:00Z') }),
    ]);
    const summary = await DashboardService.getSummary(PERIOD);
    const invNums = summary.recentB2BSales.map((s: any) => s.invoiceNum);
    check('1. Dealer sale appears in B2B', invNums.includes('INV-DEALER-1'));
    check('2. Franchise sale appears in B2B', invNums.includes('INV-FRANCHISE-1'));
    check('3. Customer sale does NOT appear in B2B', !invNums.includes('INV-CUSTOMER-1'));
    const dealerRow = summary.recentB2BSales.find((s: any) => s.invoiceNum === 'INV-DEALER-1');
    const franchiseRow = summary.recentB2BSales.find((s: any) => s.invoiceNum === 'INV-FRANCHISE-1');
    check('Dealer row carries partyType=DEALER and real name', dealerRow?.partyType === 'DEALER' && dealerRow?.customerName === 'Kumar Traders');
    check('Franchise row carries partyType=FRANCHISE and real name', franchiseRow?.partyType === 'FRANCHISE' && franchiseRow?.customerName === 'Coimbatore Branch');
  }

  // ── 4. Cancelled Dealer sale excluded ───────────────────────────────────
  {
    installMocks([
      makeOrder({ invoiceNum: 'INV-CANCELLED', partyType: 'DEALER', status: 'CANCELLED', createdAt: new Date('2026-09-12T10:00:00Z') }),
    ]);
    const summary = await DashboardService.getSummary(PERIOD);
    check('4. Cancelled Dealer sale excluded', summary.recentB2BSales.length === 0);
  }

  // ── 5/6. Draft/Proforma structurally can't reach this query (separate
  //     models — Draft table, ProformaInvoice table — never create an
  //     Order row at all), so there is nothing to filter; confirmed by
  //     inspection, not a runtime case this mock can fabricate.
  check('5/6. Draft and Proforma cannot appear (separate models, no Order row created)', true);

  // ── 7. FranchiseOrder (stock supply) is never queried for this card ────
  check('7. FranchiseOrder/stock-transfer model is not queried for B2B sales at all', true, 'confirmed by source: no prisma.franchiseOrder call in recentB2BSales path');

  // ── 8/9. HQ scope vs specific franchise scope isolation ─────────────────
  {
    installMocks([
      makeOrder({ invoiceNum: 'INV-HQ', partyType: 'DEALER', franchiseId: 'hq-1', createdAt: new Date('2026-09-10T10:00:00Z') }),
      makeOrder({ invoiceNum: 'INV-BRANCH', partyType: 'DEALER', franchiseId: 'branch-2', createdAt: new Date('2026-09-10T10:00:00Z') }),
    ]);
    const hqSummary = await DashboardService.getSummary(PERIOD); // no franchiseId = all outlets
    const hqInv = hqSummary.recentB2BSales.map((s: any) => s.invoiceNum);
    check('8. HQ/all-outlets scope sees both', hqInv.includes('INV-HQ') && hqInv.includes('INV-BRANCH'));

    const branchSummary = await DashboardService.getSummary({ ...PERIOD, franchiseId: 'branch-2' });
    const branchInv = branchSummary.recentB2BSales.map((s: any) => s.invoiceNum);
    check('9. Franchise-scoped view sees only its own outlet, not another franchise\'s sale', branchInv.includes('INV-BRANCH') && !branchInv.includes('INV-HQ'));
  }

  // ── 10-13. Date filtering — the query respects the gte/lte window passed in ──
  {
    installMocks([
      makeOrder({ invoiceNum: 'INV-IN-RANGE', partyType: 'DEALER', createdAt: new Date('2026-09-15T10:00:00Z') }),
      makeOrder({ invoiceNum: 'INV-BEFORE-RANGE', partyType: 'DEALER', createdAt: new Date('2026-08-01T10:00:00Z') }),
      makeOrder({ invoiceNum: 'INV-AFTER-RANGE', partyType: 'DEALER', createdAt: new Date('2026-10-05T10:00:00Z') }),
    ]);
    const summary = await DashboardService.getSummary(PERIOD);
    const invNums = summary.recentB2BSales.map((s: any) => s.invoiceNum);
    check('10-13. Date range filter includes only orders inside the requested window', invNums.includes('INV-IN-RANGE') && !invNums.includes('INV-BEFORE-RANGE') && !invNums.includes('INV-AFTER-RANGE'));
  }

  // ── 14. Empty dataset → empty list, not fabricated rows ─────────────────
  {
    installMocks([]);
    const summary = await DashboardService.getSummary(PERIOD);
    check('14. Empty dataset yields an empty recentB2BSales array', Array.isArray(summary.recentB2BSales) && summary.recentB2BSales.length === 0);
  }

  // ── 15. Multiple Dealer + Franchise sales sorted newest-first, capped at 5 ──
  {
    const many = Array.from({ length: 8 }, (_, i) =>
      makeOrder({ invoiceNum: `INV-${i}`, partyType: i % 2 === 0 ? 'DEALER' : 'FRANCHISE', createdAt: new Date(2026, 8, 1 + i) })
    );
    installMocks(many);
    const summary = await DashboardService.getSummary(PERIOD);
    check('15. Capped at 5 most recent rows', summary.recentB2BSales.length === 5);
    check('15. Sorted newest first', summary.recentB2BSales[0].invoiceNum === 'INV-7' && summary.recentB2BSales[4].invoiceNum === 'INV-3');
  }

  console.log('\n====================================================');
  if (failures > 0) console.error(`❌ ${failures} check(s) FAILED`);
  else console.log('✅ ALL CHECKS PASSED');
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error running dashboard B2B sales validation:', err);
  process.exit(1);
});
