import prisma from '../../lib/prisma';
import { Prisma, OrderStatus, FranchiseOrderStatus, POStatus, ProductionStatus } from '@prisma/client';

export class DashboardService {
  static async getSummary(params: { franchiseId?: string; startDate?: string; endDate?: string; period?: string }) {
    const { franchiseId, startDate, endDate, period = 'month' } = params;
    
    const today = startDate ? new Date(startDate) : new Date();
    if (!startDate) today.setHours(0, 0, 0, 0);

    const periodEnd = endDate ? new Date(endDate) : new Date();
    if (startDate && !endDate) periodEnd.setHours(23, 59, 59, 999);

    const timeDiff = periodEnd.getTime() - today.getTime();
    const prevPeriodStart = new Date(today.getTime() - timeDiff - 86400000);
    const prevPeriodEnd = new Date(today.getTime() - 1);

    const whereClause: Prisma.OrderWhereInput = franchiseId ? { franchiseId } : {};
    const fOrderWhere: Prisma.FranchiseOrderWhereInput = franchiseId ? { franchiseId } : {};
    const itemWhere: Prisma.InventoryItemWhereInput = franchiseId ? { franchiseId } : {};

    // ─── 1. AGGREGATE CALCULATIONS ───
    const [
      ordersToday,
      franchiseOrdersToday,
      inventoryItems,
      lowStockItems,
      periodExpenses,
      outstandingOrders,
      outstandingFranchiseOrders,
      procurementPayables,
      recentActivity,
      dealerCount,
      franchiseStats,
      productionRunningRaw
    ] = await Promise.all([
      // 0: POS/B2B Orders Count
      prisma.order.count({ where: { ...whereClause, createdAt: { gte: today, lte: periodEnd } } }),
      
      // 1: Franchise Orders today
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: { id: true }
      }),

      // 2: All Inventory Items for Valuation
      prisma.inventoryItem.findMany({ where: itemWhere }),

      // 3: Low Stock List
      prisma.inventoryItem.findMany({ 
        where: { ...itemWhere, currentStock: { lte: 10 } } // Fallback to 10 if minimumStock logic is complex
      }),

      // 4: Period Expenses
      prisma.expense.aggregate({
        where: { ...(franchiseId ? { franchiseId } : {}), date: { gte: today, lte: periodEnd } },
        _sum: { amount: true }
      }),

      // 5: Unpaid Orders (Receivables)
      prisma.order.aggregate({
        where: { ...whereClause, paymentStatus: 'UNPAID' },
        _sum: { totalAmount: true }
      }),

      // 6: Unpaid Franchise Orders (Receivables)
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, paymentStatus: 'UNPAID' },
        _sum: { totalAmount: true }
      }),

      // 7: Procurement Payables (Vendor Obligations)
      prisma.procurementOrder.aggregate({
        where: { status: { notIn: [POStatus.CANCELLED] }, paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
        _sum: { totalAmount: true, paid: true }
      }),

      // 8: Recent Activity Feed
      prisma.activityLog.findMany({ take: 10, orderBy: { createdAt: 'desc' } }),

      // 9: Dealer Count
      prisma.dealer.count({ where: franchiseId ? { franchiseId } : {} }),

      // 10: Franchise Performance
      prisma.franchise.findMany({
        select: {
          id: true,
          name: true,
          outstandingAmount: true,
          orders: { where: { createdAt: { gte: today, lte: periodEnd } }, select: { totalAmount: true } }
        }
      }),

      // 11: Production Running
      prisma.production.findMany({
        where: { status: { in: [ProductionStatus.PENDING, ProductionStatus.IN_PROGRESS] } },
        take: 3,
        include: { recipe: true }
      })
    ]);

    // ─── 2. REVENUE LOGIC (Combined Intelligence) ───
    const posRevenue = await prisma.order.aggregate({
      where: { ...whereClause, createdAt: { gte: today, lte: periodEnd } },
      _sum: { totalAmount: true }
    });

    const totalRevenueToday = (posRevenue._sum.totalAmount || 0) + (franchiseOrdersToday._sum.totalAmount || 0);

    // Prev period revenue for trend
    const prevRevenue = await Promise.all([
      prisma.order.aggregate({
        where: { ...whereClause, createdAt: { gte: prevPeriodStart, lte: prevPeriodEnd } },
        _sum: { totalAmount: true }
      }),
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, createdAt: { gte: prevPeriodStart, lte: prevPeriodEnd } },
        _sum: { totalAmount: true }
      })
    ]).then(([r1, r2]) => (r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0));

    const revenueChangePct = prevRevenue > 0 
      ? (((totalRevenueToday - prevRevenue) / prevRevenue) * 100).toFixed(1) 
      : "0.0";

    // ─── 3. ASSET VALUATION ───
    const inventoryValue = inventoryItems.reduce((sum, item) => sum + (item.currentStock * (item.costPrice || item.basePrice || 0)), 0);

    // ─── 4. MISSION CRITICAL ALERTS (Risk Radar) ───
    const alerts = {
      lowStock: lowStockItems.length,
      overdueReceivables: await prisma.order.count({ where: { ...whereClause, paymentStatus: 'UNPAID', createdAt: { lt: new Date(Date.now() - 7 * 86400000) } } }),
      vendorDues: await prisma.procurementOrder.count({ where: { paymentStatus: { in: ['UNPAID', 'PARTIAL'] }, expectedDeliveryDate: { lt: new Date() } } }),
      pendingDispatches: await prisma.franchiseOrder.count({ where: { status: 'PENDING' } })
    };

    const missionCriticalCount = alerts.lowStock + alerts.overdueReceivables + alerts.vendorDues + alerts.pendingDispatches;

    // ─── 5. HISTORICAL INTELLIGENCE (Dynamic Granularity) ───
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    let historicalSales = [];
    
    if (period === 'today') {
      // Hourly Granularity for Today
      historicalSales = await Promise.all(
        Array.from({ length: 24 }, (_, i) => {
          const d = new Date(today);
          d.setHours(i, 0, 0, 0);
          const de = new Date(d);
          de.setHours(i, 59, 59, 999);
          
          return Promise.all([
            prisma.order.aggregate({ where: { ...whereClause, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.franchiseOrder.aggregate({ where: { ...fOrderWhere, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.procurementOrder.aggregate({ where: { createdAt: { gte: d, lte: de }, status: { not: 'CANCELLED' } }, _sum: { totalAmount: true } })
          ]).then(([r1, r2, p]) => {
            const sales = (r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0);
            const purchase = p._sum.totalAmount || 0;
            return {
              date: `${i}:00`,
              sales,
              purchase,
              profit: sales - purchase,
              orders: (r1._count.id || 0) + (r2._count.id || 0)
            };
          });
        })
      );
    } else if (period === 'all' || period === 'year') {
      // Monthly Granularity for 1 Year
      historicalSales = await Promise.all(
        Array.from({ length: 12 }, (_, i) => {
          const d = new Date(periodEnd);
          d.setMonth(d.getMonth() - (11 - i));
          d.setDate(1); d.setHours(0,0,0,0);
          const de = new Date(d); de.setMonth(de.getMonth() + 1); de.setDate(0); de.setHours(23,59,59,999);
          
          return Promise.all([
            prisma.order.aggregate({ where: { ...whereClause, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.franchiseOrder.aggregate({ where: { ...fOrderWhere, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.procurementOrder.aggregate({ where: { createdAt: { gte: d, lte: de }, status: { not: 'CANCELLED' } }, _sum: { totalAmount: true } })
          ]).then(([r1, r2, p]) => {
            const sales = (r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0);
            const purchase = p._sum.totalAmount || 0;
            return {
              date: MONTHS[d.getMonth()],
              sales,
              purchase,
              profit: sales - purchase,
              orders: (r1._count.id || 0) + (r2._count.id || 0)
            };
          });
        })
      );
    } else {
      // Daily Granularity for 7-30 days
      const daysCount = period === 'month' ? 30 : 7;
      historicalSales = await Promise.all(
        Array.from({ length: daysCount }, (_, i) => {
          const d = new Date(periodEnd);
          d.setDate(d.getDate() - (daysCount - 1 - i));
          d.setHours(0,0,0,0);
          const de = new Date(d); de.setHours(23,59,59,999);
          
          return Promise.all([
            prisma.order.aggregate({ where: { ...whereClause, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.franchiseOrder.aggregate({ where: { ...fOrderWhere, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.procurementOrder.aggregate({ where: { createdAt: { gte: d, lte: de }, status: { not: 'CANCELLED' } }, _sum: { totalAmount: true } })
          ]).then(([r1, r2, p]) => {
            const sales = (r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0);
            const purchase = p._sum.totalAmount || 0;
            return {
              date: daysCount > 7 ? `${d.getDate()}/${d.getMonth()+1}` : DAYS[d.getDay()],
              sales,
              purchase,
              profit: sales - purchase,
              orders: (r1._count.id || 0) + (r2._count.id || 0)
            };
          });
        })
      );
    }

    // ─── 6. REVENUE SOURCES (Breakdown) ───
    const b2bRevenue = await prisma.order.aggregate({
      where: { ...whereClause, orderType: 'B2B', createdAt: { gte: today, lte: periodEnd } },
      _sum: { totalAmount: true }
    });

    const revenueBreakdown = [
      { label: "HQ POS Revenue", value: posRevenue._sum.totalAmount || 0 },
      { label: "Franchise Orders", value: franchiseOrdersToday._sum.totalAmount || 0 },
      { label: "Direct B2B Sales", value: b2bRevenue._sum.totalAmount || 0 }
    ];

    // Total Period Revenue (Based on filter)
    const totalPeriodSales = (posRevenue._sum.totalAmount || 0) + (franchiseOrdersToday._sum.totalAmount || 0);

    const periodPurchase = await prisma.procurementOrder.aggregate({
      where: { createdAt: { gte: today, lte: periodEnd }, status: { not: 'CANCELLED' } },
      _sum: { totalAmount: true }
    });

    return {
      stats: {
        revenueToday: totalRevenueToday,
        totalSales: totalPeriodSales,
        totalPurchase: periodPurchase._sum.totalAmount || 0,
        revenueChangePct,
        outstandingAmount: (outstandingOrders._sum.totalAmount || 0) + (outstandingFranchiseOrders._sum.totalAmount || 0),
        vendorPayables: (procurementPayables._sum.totalAmount || 0) - (procurementPayables._sum.paid || 0),
        inventoryValue,
        activeFranchiseOrders: await prisma.franchiseOrder.count({ where: { status: { in: [FranchiseOrderStatus.PENDING, FranchiseOrderStatus.APPROVED, FranchiseOrderStatus.IN_PRODUCTION] } } }),
        missionCriticalCount,
        lowStockCount: alerts.lowStock,
        expensesToday: periodExpenses._sum.amount || 0,
        profitToday: totalRevenueToday - (periodExpenses._sum.amount || 0), // Real Net Profit (Revenue - Expenses)
        dealerCount,
        // Insights
        orderCountToday: ordersToday,
        poCountPeriod: await prisma.procurementOrder.count({ where: { createdAt: { gte: today, lte: periodEnd } } }),
        vendorCountActive: await prisma.vendor.count({ where: { status: 'ACTIVE' } }),
        inventoryItemCount: inventoryItems.length,
        totalInvoiceCount: await prisma.order.count({ where: { createdAt: { gte: today, lte: periodEnd } } })
      },
      revenueBreakdown,
      productionRunning: (productionRunningRaw as any[] || []).map((p: any) => ({
        label: p.recipe?.name || "Standard Production",
        sublabel: `Batch #${p.id.slice(0, 4)}`,
        value: p.status === 'IN_PROGRESS' ? "85% Completed" : "Pending",
        status: p.status,
        badgeColor: p.status === 'IN_PROGRESS' ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"
      })),
      historicalSales,
      lowStock: lowStockItems.slice(0, 5).map(i => ({
        name: i.name,
        currentStock: i.currentStock,
        minimumStock: i.minimumStock,
        unit: i.unit,
        action: i.currentStock === 0 ? "Critical" : "Produce"
      })),
      franchisePerformance: franchiseStats.map(f => ({
        name: f.name,
        salesToday: f.orders.reduce((s, o) => s + o.totalAmount, 0),
        outstanding: f.outstandingAmount,
        stockHealth: 100, // Derived from real stock soon
        lastOrder: "Active"
      })),
      recentOrders: await prisma.order.findMany({
        where: whereClause,
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { franchise: true }
      }).then(orders => orders.map(o => ({
        id: o.invoiceNum,
        amount: o.totalAmount,
        status: o.status.toLowerCase(),
        franchiseName: o.franchise?.name || "HQ"
      }))),
      topSellers: await prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { ...whereClause, createdAt: { gte: today, lte: periodEnd } } },
        _sum: { quantity: true, totalAmount: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 4
      }).then(async (groups) => {
        return Promise.all(groups.map(async (g) => {
          const product = await prisma.product.findUnique({ where: { id: g.productId } });
          return {
            name: product?.name || "Unknown",
            value: g._sum.quantity || 0,
            unit: "Units",
            growth: "0" 
          };
        }));
      }),
      periodStats: {
        total: (historicalSales as any[]).reduce((acc, curr) => acc + curr.sales, 0),
        average: (historicalSales as any[]).length > 0 
          ? (historicalSales as any[]).reduce((acc, curr) => acc + curr.sales, 0) / (historicalSales as any[]).length 
          : 0,
        bestDay: [...(historicalSales as any[])].sort((a,b) => b.sales - a.sales)[0] || { date: '-', sales: 0 }
      },
      recentB2BSales: await prisma.order.findMany({
        where: { ...whereClause, orderType: 'B2B' },
        take: 3,
        orderBy: { createdAt: 'desc' },
        select: { invoiceNum: true, totalAmount: true, customer: { select: { name: true } } }
      }).then(orders => orders.map(o => ({ ...o, customerName: o.customer?.name }))),
      recentB2CBills: await prisma.order.findMany({
        where: { ...whereClause, orderType: 'POS' },
        take: 3,
        orderBy: { createdAt: 'desc' },
        select: { invoiceNum: true, totalAmount: true }
      }),
      supplierPaymentsDue: await prisma.procurementOrder.findMany({
        where: { status: { notIn: [POStatus.CANCELLED] }, paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
        take: 3,
        orderBy: { expectedDeliveryDate: 'asc' },
        select: { poNumber: true, totalAmount: true, vendor: { select: { name: true } } }
      }),
      recentPurchases: await prisma.procurementOrder.findMany({
        take: 3,
        orderBy: { createdAt: 'desc' },
        select: { poNumber: true, totalAmount: true, vendor: { select: { name: true } } }
      }),
      pendingDispatches: await prisma.franchiseOrder.findMany({
        where: { status: 'PENDING' },
        take: 4,
        orderBy: { createdAt: 'desc' },
        select: { orderNumber: true, status: true, franchise: { select: { name: true } } }
      })
    };
  }
}
