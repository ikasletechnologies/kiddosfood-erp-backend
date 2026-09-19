import prisma from '../../lib/prisma';
import { DashboardInventoryService } from './dashboard.inventory';
import { DashboardCollectionsService } from './dashboard.collections';
import { DashboardDispatchService } from './dashboard.dispatch';
import { DashboardAnalyticsService } from './dashboard.analytics';
import { FinanceService } from '../finance/finance.service';

export class DashboardService {
  static async getSummary(params: { franchiseId?: string; startDate?: string; endDate?: string; period?: string }) {
    const { franchiseId, startDate, endDate, period = 'month' } = params;

    const today = startDate ? new Date(startDate) : new Date();
    if (!startDate) today.setHours(0, 0, 0, 0);

    const periodEnd = endDate ? new Date(endDate) : new Date();
    if (startDate && !endDate) periodEnd.setHours(23, 59, 59, 999);

    // Fetch stats and report tables in parallel using optimized domain services
    const [
      inv,
      col,
      disp,
      ana,
      dealerCount,
      payableParties,
      receivableParties,
      cashFlow,
      pnl,
      productions,
      batches,
      recentPurchases,
      recentB2BOrders,
      recentB2CBills,
      supplierPaymentsDue
    ] = await Promise.all([
      DashboardInventoryService.getInventoryStats(franchiseId),
      DashboardCollectionsService.getCollectionsStats(franchiseId, startDate, endDate),
      DashboardDispatchService.getDispatchStats(franchiseId),
      DashboardAnalyticsService.getAnalyticsStats({ franchiseId, startDate, endDate, period }),
      prisma.dealer.count({ where: franchiseId ? { franchiseId } : {} }),
      // Vendor Payables — reuse the same VENDOR-ledger balance formula the
      // working Reports > All Parties (Payables) view already uses, instead
      // of a second CREDIT/DEBIT groupBy living only in the dashboard.
      // VendorLedger has no franchiseId column at all (vendors are global),
      // so this figure is always company-wide regardless of outlet filter —
      // an existing architectural limitation, not something a dashboard
      // query can scope around.
      FinanceService.getAllPartiesData(undefined, undefined, undefined, { datasetType: 'PAYABLE' }),
      // Pending Receivables — the general "who owes us" figure across every
      // CUSTOMER/DEALER/FRANCHISE party (unpaid/partial invoices only,
      // returns/cancellations already excluded), not the Dealer-only subset
      // `col.totalDealerOutstanding` matches (that figure is kept separately
      // below for the Franchise Dashboard's dealer-collections widget, which
      // genuinely wants only the dealer network).
      FinanceService.getAllPartiesData(franchiseId, undefined, undefined, { datasetType: 'RECEIVABLE' }),
      // Cash Position — reuse AccountService.getAccounts via getCashFlow so
      // UPI accounts are included and "All Outlets" resolves to the real HQ
      // franchise id instead of a literal franchiseId:null query.
      FinanceService.getCashFlow(franchiseId || null),
      // Net Profit — the real P&L engine (FIFO COGS from OrderItem.totalCost,
      // real expenses), not a client-side totalSales-totalPurchase guess.
      FinanceService.getProfitAndLoss({ franchiseId, startDate: today, endDate: periodEnd }),
      prisma.production.findMany({
        where: {
          status: 'COMPLETED',
          producedAt: { gte: today, lte: periodEnd },
          ...(franchiseId ? { franchiseId } : {})
        },
        select: {
          quantity: true,
          actualYield: true,
          recipe: { select: { yieldQty: true } }
        }
      }),
      prisma.productBatch.findMany({
        where: {
          createdAt: { gte: today, lte: periodEnd },
          ...(franchiseId ? { franchiseId } : {})
        },
        select: {
          rejectionQty: true,
          quantity: true
        }
      }),
      prisma.procurementOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          createdAt: { gte: today, lte: periodEnd },
          status: { not: 'CANCELLED' }
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { vendor: { select: { name: true } } }
      }),
      // B2B = a real, financially-recognized sale to a DEALER or FRANCHISE
      // party — per Order.partyType, the authoritative classification field
      // (already used correctly by getPartyReceivables/getAllPartiesData).
      // NOT orderType: that field is 'DINE_IN'-vs-'TAX_INVOICE' bookkeeping
      // unrelated to who the party is — FinanceService.createInvoice (the
      // Sale Invoice page every Dealer/Franchise/Customer invoice actually
      // goes through) hardcodes orderType:'DINE_IN' regardless of party,
      // so a 'TAX_INVOICE' filter here silently excluded every Dealer/
      // Franchise sale created from that page — this list was never
      // populated by real Dealer/Franchise data, only genuinely empty by
      // construction. Deliberately NOT prisma.franchiseOrder — that model
      // (FranchiseOrderType STOCK/REQUEST) is HQ→franchise stock supply,
      // never linked to an Invoice, and not part of FinanceService.
      // getProfitAndLoss's revenue — it's inventory movement, not a
      // recognized sale, so it must not be counted as a B2B sale here.
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          partyType: { in: ['DEALER', 'FRANCHISE'] },
          status: 'COMPLETED',
          createdAt: { gte: today, lte: periodEnd }
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { invoiceNum: true, partyType: true, customerName: true, totalAmount: true, createdAt: true }
      }),
      // "Recent B2C Counter Bills" specifically means a POS counter sale to
      // a Customer — not every Customer sale. orderType alone can't tell
      // POS apart from other origins: 'DINE_IN' is what FinanceService.
      // createInvoice (the Sale Invoice page) hardcodes for EVERY invoice
      // regardless of party (see the B2B query above), and 'TAX_INVOICE' is
      // set by BOTH POSService.checkout AND SalesService.
      // convertProformaToInvoice (a Proforma conversion, not POS). The one
      // reliable POS-origin signal is orderType:'TAX_INVOICE' combined with
      // no source-conversion reference — POSService.checkout/createOrder
      // never set sourceQuotationId/sourceProformaInvoiceId (grep-confirmed:
      // pos.service.ts never assigns either field), while every conversion
      // path that also uses TAX_INVOICE always stamps one. partyType:
      // 'CUSTOMER' then excludes a Dealer/Franchise walking up to the same
      // counter (POSService.checkout sets a real, never-null partyType).
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          orderType: 'TAX_INVOICE',
          sourceQuotationId: null,
          sourceProformaInvoiceId: null,
          partyType: 'CUSTOMER',
          status: 'COMPLETED',
          createdAt: { gte: today, lte: periodEnd }
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { invoiceNum: true, customerName: true, totalAmount: true, createdAt: true }
      }),
      prisma.procurementOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
          status: { not: 'CANCELLED' }
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { vendor: { select: { name: true } } }
      })
    ]);

    // Recent B2B Sales Details: real Dealer/Franchise Orders only (see the
    // query comment above for why franchiseOrder is deliberately excluded).
    const recentB2BSales = recentB2BOrders.map(o => ({
      invoiceNum: o.invoiceNum,
      customerName: o.customerName || (o.partyType === 'FRANCHISE' ? 'Franchise Client' : 'Dealer Client'),
      partyType: o.partyType,
      totalAmount: o.totalAmount
    }));

    // Vendor Payables: payableParties already carries only VENDOR rows with
    // currentBalance < 0 meaning "amount owed to that vendor" (see
    // FinanceService.getAllPartiesData / getAllPartiesReport's
    // payableBalance mapping) — sum their absolute value. Always
    // company-wide (VendorLedger has no franchiseId column).
    const vendorPayables = payableParties.reduce((sum: number, p: any) => sum + (p.currentBalance < 0 ? Math.abs(p.currentBalance) : 0), 0);

    // Pending Receivables: receivableParties carries CUSTOMER/DEALER/
    // FRANCHISE rows with currentBalance > 0 meaning "amount that party owes
    // us" — sum them for the company-/outlet-wide total.
    const totalReceivables = receivableParties.reduce((sum: number, p: any) => sum + (p.currentBalance > 0 ? p.currentBalance : 0), 0);

    // Cash Position: FinanceService.getCashFlow already includes CASH+BANK+UPI
    // and resolves "no franchiseId" to the real HQ franchise id.
    const dailyCashPosition = cashFlow.totalLiquidity;

    // Calculate production KPIs. "Planned/expected" output must be scaled by
    // the recipe's yield (quantity * recipe.yieldQty), not the raw batch
    // quantity, or a recipe with yieldQty != 1 always shows a wrong %.
    const totalProducedQty = productions.reduce((s, p) => s + (p.actualYield || 0), 0);
    const plannedQty = productions.reduce((s, p) => s + (p.quantity || 0) * (p.recipe?.yieldQty ?? 1), 0);
    // No completed production in this window means "no data", not a fake
    // 100% — a real 0% yield (a production failure) must never be
    // indistinguishable from "nothing produced yet".
    const yieldPercentage = plannedQty > 0 ? Number(((totalProducedQty / plannedQty) * 100).toFixed(1)) : null;
    const totalWastage = batches.reduce((s, b) => s + (b.rejectionQty || 0), 0);

    return {
      stats: {
        // Today's Operational KPIs
        revenueToday: ana.revenueToday,               // Today's Sales / Billing
        pendingCollections: col.pendingCollections,   // Unpaid dealer invoices
        outstandingAmount: col.totalDealerOutstanding, // Total Credit / Receivables
        lowStockCount: inv.lowStockCount,             // Products below threshold
        pendingDeliveries: disp.pendingDeliveries,     // Orders not delivered
        dealerCount: dealerCount,                     // Total network size
        salesReturnsToday: col.salesReturnsToday,     // Returned value today
        todayCollection: col.todayCollection,         // Collected payments today
        overdueDealersCount: col.overdueDealersCount, // Overdue partners (Red status)

        // General / HQ Compatibility KPIs
        totalSales: ana.totalSales,
        totalSalesCount: ana.totalSalesCount,
        totalPurchase: ana.totalPurchase,
        revenueChangePct: ana.revenueChangePct,
        expensesToday: ana.expensesToday,
        inventoryValue: inv.inventoryValue,
        inventoryItemCount: inv.inventoryItemCount,
        activeFranchiseOrders: disp.pendingDeliveries,
        orderCountToday: ana.ordersCountToday,
        
        // Calculated/PRD KPIs
        vendorPayables,
        totalReceivables,
        dailyCashPosition,
        productionQuantity: totalProducedQty,
        yieldPercentage,
        wastage: totalWastage,

        // Net Profit — FinanceService.getProfitAndLoss's own revenue/COGS
        // (Invoice-based, FIFO cost), so this reconciles exactly with the
        // P&L report for the same scope/date range. Deliberately NOT
        // totalSales-totalPurchase (that mixed Order-based sales with a
        // VendorInvoice/COGS blend and was never a real profit figure).
        netProfit: pnl.netProfit,
        grossProfit: pnl.grossProfit,
        pnlRevenue: pnl.revenue,
        pnlExpenses: pnl.expenses
      },
      
      // Detailed operational lists (Connected to DB, no hardcoding)
      recentOrders: ana.recentOrders,
      lowStockAlerts: inv.lowStockAlerts,
      lowStock: inv.lowStock,
      recentPurchases,
      recentB2BSales,
      recentB2CBills,
      supplierPaymentsDue,
      dealerOutstanding: col.dealerOutstanding,
      pendingDispatchQueue: disp.pendingDispatchQueue,
      inventoryAlerts: inv.inventoryAlerts,

      // Analytics & Charts (HQ Dashboard and Franchise Analytics)
      historicalSales: ana.historicalSales,
      revenueBreakdown: ana.revenueBreakdown,
      topSellers: ana.topSellers
    };
  }
}
