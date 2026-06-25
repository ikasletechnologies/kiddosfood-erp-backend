import prisma from '../../lib/prisma';
import { DashboardInventoryService } from './dashboard.inventory';
import { DashboardCollectionsService } from './dashboard.collections';
import { DashboardDispatchService } from './dashboard.dispatch';
import { DashboardAnalyticsService } from './dashboard.analytics';

export class DashboardService {
  static async getSummary(params: { franchiseId?: string; startDate?: string; endDate?: string; period?: string }) {
    const { franchiseId, startDate, endDate, period = 'month' } = params;

    const today = startDate ? new Date(startDate) : new Date();
    if (!startDate) today.setHours(0, 0, 0, 0);

    const periodEnd = endDate ? new Date(endDate) : new Date();
    if (startDate && !endDate) periodEnd.setHours(23, 59, 59, 999);

    // Fetch stats in parallel using optimized domain services
    const [inv, col, disp, ana, dealerCount, vendors, cashAccounts, productions, batches] = await Promise.all([
      DashboardInventoryService.getInventoryStats(franchiseId),
      DashboardCollectionsService.getCollectionsStats(franchiseId, startDate, endDate),
      DashboardDispatchService.getDispatchStats(franchiseId),
      DashboardAnalyticsService.getAnalyticsStats({ franchiseId, startDate, endDate, period }),
      prisma.dealer.count({ where: franchiseId ? { franchiseId } : {} }),
      prisma.vendor.findMany({ include: { ledgerEntries: true } }),
      prisma.account.findMany({
        where: {
          type: { in: ['CASH', 'BANK'] },
          status: 'ACTIVE',
          ...(franchiseId ? { franchiseId } : {})
        }
      }),
      prisma.production.findMany({
        where: {
          status: 'COMPLETED',
          producedAt: { gte: today, lte: periodEnd },
          ...(franchiseId ? { franchiseId } : {})
        },
        select: {
          quantity: true,
          actualYield: true
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
      })
    ]);

    // Calculate vendorPayables
    let vendorPayables = 0;
    vendors.forEach(v => {
      const entries = v.ledgerEntries || [];
      const credits = entries.filter(e => e.type === 'CREDIT').reduce((s, e) => s + (e.amount || 0), 0);
      const debits = entries.filter(e => e.type === 'DEBIT').reduce((s, e) => s + (e.amount || 0), 0);
      const balance = credits - debits;
      if (balance > 0) vendorPayables += balance;
    });

    // Calculate dailyCashPosition
    const dailyCashPosition = cashAccounts.reduce((s, acc) => s + (acc.balance || 0), 0);

    // Calculate production KPIs
    const totalProducedQty = productions.reduce((s, p) => s + (p.actualYield || 0), 0);
    const plannedQty = productions.reduce((s, p) => s + (p.quantity || 0), 0);
    const yieldPercentage = plannedQty > 0 ? ((totalProducedQty / plannedQty) * 100).toFixed(1) : "100.0";
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
        dailyCashPosition,
        productionQuantity: totalProducedQty,
        yieldPercentage: Number(yieldPercentage),
        wastage: totalWastage
      },
      
      // Detailed operational lists (Connected to DB, no hardcoding)
      recentOrders: ana.recentOrders,
      lowStockAlerts: inv.lowStockAlerts,
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
