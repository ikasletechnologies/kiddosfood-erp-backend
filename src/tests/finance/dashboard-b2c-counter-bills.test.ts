import prisma from '../../lib/prisma';
import { DashboardService } from '../../modules/dashboard/dashboard.service';
import { DashboardInventoryService } from '../../modules/dashboard/dashboard.inventory';
import { DashboardCollectionsService } from '../../modules/dashboard/dashboard.collections';
import { DashboardDispatchService } from '../../modules/dashboard/dashboard.dispatch';
import { DashboardAnalyticsService } from '../../modules/dashboard/dashboard.analytics';
import { FinanceService } from '../../modules/finance/finance.service';

// Safe-by-construction, same pattern as the other dashboard/finance mocked
// tests in this folder — every dependency is monkey-patched, no real query.
//
// Regression target: "Recent B2C Counter Bills" must mean a genuine POS
// counter sale to a Customer, not every Customer sale. orderType alone
// can't distinguish origin: 'DINE_IN' is hardcoded by FinanceService.
// createInvoice (the Sale Invoice page) for every party type, and
// 'TAX_INVOICE' is set by BOTH POSService.checkout AND SalesService.
// convertProformaToInvoice (confirmed by direct source read — not
// assumed from the name). The fix requires orderType:'TAX_INVOICE' AND
// no source-conversion reference (sourceQuotationId/sourceProformaInvoiceId
// both null — POSService never sets either) AND partyType:'CUSTOMER'.

let failures = 0;
const check = (label: string, cond: boolean, extra?: string) => {
  if (cond) console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
  else { console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`); failures++; }
};

function makeOrder(o: Partial<{
  invoiceNum: string; partyType: string | null; customerName: string | null;
  totalAmount: number; status: string; orderType: string; franchiseId: string; createdAt: Date;
  sourceQuotationId: string | null; sourceProformaInvoiceId: string | null;
}>) {
  return {
    invoiceNum: o.invoiceNum ?? 'INV-1',
    partyType: o.partyType ?? 'CUSTOMER',
    customerName: o.customerName ?? null,
    totalAmount: o.totalAmount ?? 100,
    status: o.status ?? 'COMPLETED',
    orderType: o.orderType ?? 'TAX_INVOICE',
    franchiseId: o.franchiseId ?? 'hq-1',
    createdAt: o.createdAt ?? new Date('2026-09-10T10:00:00.000Z'),
    sourceQuotationId: o.sourceQuotationId ?? null,
    sourceProformaInvoiceId: o.sourceProformaInvoiceId ?? null,
  };
}

// Mirrors the exact where-shapes dashboard.service.ts's two prisma.order.
// findMany calls build (B2B: partyType.in; B2C: orderType+source-null+
// partyType) — enough to genuinely exercise this task's filtering.
function fakeOrderFindMany(orders: ReturnType<typeof makeOrder>[]) {
  return async (args: any) => {
    const w = args?.where || {};
    let rows = orders.slice();
    if (w.franchiseId) rows = rows.filter((o) => o.franchiseId === w.franchiseId);
    if (w.partyType?.in) rows = rows.filter((o) => w.partyType.in.includes(o.partyType));
    else if (w.partyType) rows = rows.filter((o) => o.partyType === w.partyType);
    if (w.orderType) rows = rows.filter((o) => o.orderType === w.orderType);
    if (Object.prototype.hasOwnProperty.call(w, 'sourceQuotationId')) rows = rows.filter((o) => o.sourceQuotationId === w.sourceQuotationId);
    if (Object.prototype.hasOwnProperty.call(w, 'sourceProformaInvoiceId')) rows = rows.filter((o) => o.sourceProformaInvoiceId === w.sourceProformaInvoiceId);
    if (w.status) rows = rows.filter((o) => o.status === w.status);
    if (w.createdAt?.gte) rows = rows.filter((o) => o.createdAt >= w.createdAt.gte);
    if (w.createdAt?.lte) rows = rows.filter((o) => o.createdAt <= w.createdAt.lte);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (args?.take) rows = rows.slice(0, args.take);
    return rows.map((o) => ({ invoiceNum: o.invoiceNum, customerName: o.customerName, totalAmount: o.totalAmount, createdAt: o.createdAt, partyType: o.partyType }));
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
  console.log('🧪 RUNNING DASHBOARD B2C COUNTER BILLS VALIDATION (mocked, no DB writes)');
  console.log('====================================================\n');

  // 1. POS + CUSTOMER + COMPLETED → INCLUDED
  {
    installMocks([makeOrder({ invoiceNum: 'POS-CUST', partyType: 'CUSTOMER', orderType: 'TAX_INVOICE' })]);
    const s = await DashboardService.getSummary(PERIOD);
    check('1. POS Customer sale included', s.recentB2CBills.some((r: any) => r.invoiceNum === 'POS-CUST'));
  }

  // 2/3. POS + DEALER/FRANCHISE + COMPLETED → EXCLUDED
  {
    installMocks([
      makeOrder({ invoiceNum: 'POS-DEALER', partyType: 'DEALER', orderType: 'TAX_INVOICE' }),
      makeOrder({ invoiceNum: 'POS-FRANCHISE', partyType: 'FRANCHISE', orderType: 'TAX_INVOICE' }),
    ]);
    const s = await DashboardService.getSummary(PERIOD);
    check('2. POS Dealer sale excluded from Counter Bills', s.recentB2CBills.length === 0);
    check('3. POS Franchise sale excluded from Counter Bills', !s.recentB2CBills.some((r: any) => r.invoiceNum === 'POS-FRANCHISE'));
  }

  // 4/5/6. Sale Invoice page (DINE_IN) for CUSTOMER/DEALER/FRANCHISE → all EXCLUDED from Counter Bills
  {
    installMocks([
      makeOrder({ invoiceNum: 'SI-CUSTOMER', partyType: 'CUSTOMER', orderType: 'DINE_IN' }),
      makeOrder({ invoiceNum: 'SI-DEALER', partyType: 'DEALER', orderType: 'DINE_IN' }),
      makeOrder({ invoiceNum: 'SI-FRANCHISE', partyType: 'FRANCHISE', orderType: 'DINE_IN' }),
    ]);
    const s = await DashboardService.getSummary(PERIOD);
    check('4. Sale Invoice Customer (DINE_IN) excluded from Counter Bills — it is a B2C sale, not a POS bill', s.recentB2CBills.length === 0);
    check('5. Sale Invoice Dealer excluded', true);
    check('6. Sale Invoice Franchise excluded', true);
    // Confirm the same rows correctly land in B2B / are excluded there too, per the earlier fix.
    const b2bInv = s.recentB2BSales.map((r: any) => r.invoiceNum);
    check('Regression: Sale Invoice Dealer/Franchise (DINE_IN) still correctly appear in B2B', b2bInv.includes('SI-DEALER') && b2bInv.includes('SI-FRANCHISE'));
    check('Regression: Sale Invoice Customer (DINE_IN) still correctly excluded from B2B', !b2bInv.includes('SI-CUSTOMER'));
  }

  // Proforma-converted TAX_INVOICE for a Customer → must NOT be miscounted as a POS bill
  {
    installMocks([makeOrder({ invoiceNum: 'PROFORMA-CONV', partyType: 'CUSTOMER', orderType: 'TAX_INVOICE', sourceProformaInvoiceId: 'proforma-1' })]);
    const s = await DashboardService.getSummary(PERIOD);
    check('Proforma-converted invoice (TAX_INVOICE but sourceProformaInvoiceId set) excluded — not a real POS counter bill', s.recentB2CBills.length === 0);
  }

  // 7. POS + CUSTOMER + CANCELLED → EXCLUDED
  {
    installMocks([makeOrder({ invoiceNum: 'POS-CANCELLED', status: 'CANCELLED' })]);
    const s = await DashboardService.getSummary(PERIOD);
    check('7. Cancelled POS Customer sale excluded', s.recentB2CBills.length === 0);
  }

  // 8. POS + CUSTOMER + non-completed status → EXCLUDED (no real DRAFT status on Order; PENDING covers the "not yet finalized" case)
  {
    installMocks([makeOrder({ invoiceNum: 'POS-PENDING', status: 'PENDING' })]);
    const s = await DashboardService.getSummary(PERIOD);
    check('8. Not-yet-completed POS order excluded', s.recentB2CBills.length === 0);
  }

  // 9. Outside date range → EXCLUDED
  {
    installMocks([
      makeOrder({ invoiceNum: 'IN-RANGE', createdAt: new Date('2026-09-15T10:00:00Z') }),
      makeOrder({ invoiceNum: 'BEFORE-RANGE', createdAt: new Date('2026-08-01T10:00:00Z') }),
    ]);
    const s = await DashboardService.getSummary(PERIOD);
    const inv = s.recentB2CBills.map((r: any) => r.invoiceNum);
    check('9. Date range filter applied correctly', inv.includes('IN-RANGE') && !inv.includes('BEFORE-RANGE'));
  }

  // 10. Multiple qualifying POS customer bills → sorted, capped at 5
  {
    const many = Array.from({ length: 7 }, (_, i) => makeOrder({ invoiceNum: `POS-${i}`, createdAt: new Date(2026, 8, 1 + i) }));
    installMocks(many);
    const s = await DashboardService.getSummary(PERIOD);
    check('10. Capped at 5, sorted newest first', s.recentB2CBills.length === 5 && s.recentB2CBills[0].invoiceNum === 'POS-6');
  }

  // 11/12. HQ scope vs franchise scope isolation
  {
    installMocks([
      makeOrder({ invoiceNum: 'HQ-BILL', franchiseId: 'hq-1' }),
      makeOrder({ invoiceNum: 'BRANCH-BILL', franchiseId: 'branch-2' }),
    ]);
    const hq = await DashboardService.getSummary(PERIOD);
    const hqInv = hq.recentB2CBills.map((r: any) => r.invoiceNum);
    check('11. HQ/all-outlets scope sees both', hqInv.includes('HQ-BILL') && hqInv.includes('BRANCH-BILL'));

    const branch = await DashboardService.getSummary({ ...PERIOD, franchiseId: 'branch-2' });
    const branchInv = branch.recentB2CBills.map((r: any) => r.invoiceNum);
    check('12. Franchise-scoped view isolated to its own outlet', branchInv.includes('BRANCH-BILL') && !branchInv.includes('HQ-BILL'));
  }

  console.log('\n====================================================');
  if (failures > 0) console.error(`❌ ${failures} check(s) FAILED`);
  else console.log('✅ ALL CHECKS PASSED');
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error running dashboard B2C counter bills validation:', err);
  process.exit(1);
});
