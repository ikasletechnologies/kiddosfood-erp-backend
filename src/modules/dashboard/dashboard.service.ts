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

    // Fetch stats and report tables in parallel using optimized domain services
    const [
      inv,
      col,
      disp,
      ana,
      dealerCount,
      vendorLedgerTotals,
      cashAccounts,
      productions,
      batches,
      recentPurchases,
      recentB2BOrders,
      recentFranchiseOrders,
      recentB2CBills,
      supplierPaymentsDue
    ] = await Promise.all([
      DashboardInventoryService.getInventoryStats(franchiseId),
      DashboardCollectionsService.getCollectionsStats(franchiseId, startDate, endDate),
      DashboardDispatchService.getDispatchStats(franchiseId),
      DashboardAnalyticsService.getAnalyticsStats({ franchiseId, startDate, endDate, period }),
      prisma.dealer.count({ where: franchiseId ? { franchiseId } : {} }),
      prisma.vendorLedger.groupBy({
        by: ['vendorId', 'type'],
        _sum: { amount: true }
      }),
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
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          orderType: 'B2B',
          status: { not: 'CANCELLED' },
          createdAt: { gte: today, lte: periodEnd }
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: { select: { name: true } } }
      }),
      prisma.franchiseOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { in: ['DELIVERED', 'DISPATCHED'] as any },
          createdAt: { gte: today, lte: periodEnd }
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { franchise: { select: { name: true } } }
      }),
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          orderType: { not: 'B2B' },
          status: { not: 'CANCELLED' },
          createdAt: { gte: today, lte: periodEnd }
        },
        take: 5,
        orderBy: { createdAt: 'desc' }
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

    // Format B2B Sales Details combining B2B orders & completed Franchise orders
    const recentB2BSales = [
      ...recentB2BOrders.map(o => ({
        invoiceNum: o.invoiceNum,
        customerName: o.customerName || o.customer?.name || "B2B Client",
        totalAmount: o.totalAmount
      })),
      ...recentFranchiseOrders.map(f => ({
        invoiceNum: f.orderNumber,
        customerName: (f as any).franchise?.name || "B2B Franchise Client",
        totalAmount: f.totalAmount
      }))
    ].slice(0, 5);

    // Calculate vendorPayables from ledger credit balances + unpaid PO balances
    const balanceByVendor = new Map<string, number>();
    for (const row of vendorLedgerTotals) {
      const delta = (row._sum.amount || 0) * (row.type === 'CREDIT' ? 1 : -1);
      balanceByVendor.set(row.vendorId, (balanceByVendor.get(row.vendorId) || 0) + delta);
    }
    let vendorPayables = 0;
    for (const balance of balanceByVendor.values()) {
      if (balance > 0) vendorPayables += balance;
    }
    const unpaidPoTotal = supplierPaymentsDue.reduce((sum, po) => sum + (po.balance || po.totalAmount || 0), 0);
    if (vendorPayables === 0 && unpaidPoTotal > 0) {
      vendorPayables = unpaidPoTotal;
    }

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
