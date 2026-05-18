import prisma from '../../lib/prisma';
import { DashboardInventoryService } from './dashboard.inventory';
import { DashboardCollectionsService } from './dashboard.collections';
import { DashboardDispatchService } from './dashboard.dispatch';
import { DashboardAnalyticsService } from './dashboard.analytics';

export class DashboardService {
  static async getSummary(params: { franchiseId?: string; startDate?: string; endDate?: string; period?: string }) {
    const { franchiseId, startDate, endDate, period = 'month' } = params;

    // Fetch stats in parallel using optimized domain services
    const [inv, col, disp, ana, dealerCount] = await Promise.all([
      DashboardInventoryService.getInventoryStats(franchiseId),
      DashboardCollectionsService.getCollectionsStats(franchiseId, startDate, endDate),
      DashboardDispatchService.getDispatchStats(franchiseId),
      DashboardAnalyticsService.getAnalyticsStats({ franchiseId, startDate, endDate, period }),
      prisma.dealer.count({ where: franchiseId ? { franchiseId } : {} })
    ]);

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
        totalPurchase: ana.totalPurchase,
        revenueChangePct: ana.revenueChangePct,
        expensesToday: ana.expensesToday,
        inventoryValue: inv.inventoryValue,
        inventoryItemCount: inv.inventoryItemCount,
        activeFranchiseOrders: disp.pendingDeliveries,
        orderCountToday: ana.ordersCountToday
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
