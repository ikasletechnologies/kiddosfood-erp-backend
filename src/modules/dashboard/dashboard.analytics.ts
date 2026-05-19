import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

export class DashboardAnalyticsService {
  static async getAnalyticsStats(params: { franchiseId?: string; startDate?: string; endDate?: string; period?: string }) {
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
    const poWhere: Prisma.ProcurementOrderWhereInput = franchiseId ? { franchiseId } : {};

    // Period revenue
    const [posRevenue, franchiseOrdersToday] = await Promise.all([
      prisma.order.aggregate({
        where: { ...whereClause, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: { id: true }
      }),
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: { id: true }
      })
    ]);

    const totalRevenueToday = franchiseId
      ? (posRevenue._sum.totalAmount || 0)
      : (posRevenue._sum.totalAmount || 0) + (franchiseOrdersToday._sum.totalAmount || 0);

    const totalSalesCount = franchiseId
      ? (posRevenue._count.id || 0)
      : (posRevenue._count.id || 0) + (franchiseOrdersToday._count.id || 0);

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
    ]).then(([r1, r2]) => franchiseId
      ? (r1._sum.totalAmount || 0)
      : (r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0));

    const revenueChangePct = prevRevenue > 0
      ? (((totalRevenueToday - prevRevenue) / prevRevenue) * 100).toFixed(1)
      : "0.0";

    // Pre-fetch SALES_OUT stock movements for the period (single query, avoids N+1 per bucket)
    // For 'all'/'year' periods, limit to last 12 months to avoid loading years of data
    const cogsWindowStart = (period === 'all' || period === 'year')
      ? (() => { const d = new Date(periodEnd); d.setMonth(d.getMonth() - 12); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })()
      : today;

    const cogsMovements = await prisma.stockMovement.findMany({
      where: {
        movementType: 'SALES_OUT',
        createdAt: { gte: cogsWindowStart, lte: periodEnd },
        ...(franchiseId ? { item: { franchiseId } } : {})
      },
      select: {
        quantity: true,
        createdAt: true,
        item: { select: { costPrice: true } }
      }
    });

    // COGS for a time bucket: sum of |qty| × costPrice for all SALES_OUT in range
    function getBucketCOGS(from: Date, to: Date): number {
      return cogsMovements
        .filter(m => m.createdAt >= from && m.createdAt <= to)
        .reduce((sum, m) => sum + Math.abs(m.quantity) * (m.item.costPrice || 0), 0);
    }

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let historicalSales: any[] = [];

    if (period === 'today') {
      historicalSales = await Promise.all(
        Array.from({ length: 24 }, (_, i) => {
          const d = new Date(today);
          d.setHours(i, 0, 0, 0);
          const de = new Date(d);
          de.setHours(i, 59, 59, 999);

          return Promise.all([
            prisma.order.aggregate({ where: { ...whereClause, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.franchiseOrder.aggregate({ where: { ...fOrderWhere, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            Promise.resolve(getBucketCOGS(d, de))
          ]).then(([r1, r2, cogs]) => {
            const sales = franchiseId ? (r1._sum.totalAmount || 0) : ((r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0));
            const purchase = franchiseId ? (cogs + (r2._sum.totalAmount || 0)) : cogs;
            return {
              date: `${i}:00`,
              sales,
              purchase,
              profit: sales - purchase,
              orders: (r1._count.id || 0) + (franchiseId ? 0 : (r2._count.id || 0))
            };
          });
        })
      );
    } else if (period === 'all' || period === 'year') {
      historicalSales = await Promise.all(
        Array.from({ length: 12 }, (_, i) => {
          const d = new Date(periodEnd);
          d.setMonth(d.getMonth() - (11 - i));
          d.setDate(1); d.setHours(0, 0, 0, 0);
          const de = new Date(d); de.setMonth(de.getMonth() + 1); de.setDate(0); de.setHours(23, 59, 59, 999);

          return Promise.all([
            prisma.order.aggregate({ where: { ...whereClause, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.franchiseOrder.aggregate({ where: { ...fOrderWhere, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            Promise.resolve(getBucketCOGS(d, de))
          ]).then(([r1, r2, cogs]) => {
            const sales = franchiseId ? (r1._sum.totalAmount || 0) : ((r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0));
            const purchase = franchiseId ? (cogs + (r2._sum.totalAmount || 0)) : cogs;
            return {
              date: MONTHS[d.getMonth()],
              sales,
              purchase,
              profit: sales - purchase,
              orders: (r1._count.id || 0) + (franchiseId ? 0 : (r2._count.id || 0))
            };
          });
        })
      );
    } else {
      const daysCount = period === 'month' ? 30 : 7;
      historicalSales = await Promise.all(
        Array.from({ length: daysCount }, (_, i) => {
          const d = new Date(periodEnd);
          d.setDate(d.getDate() - (daysCount - 1 - i));
          d.setHours(0, 0, 0, 0);
          const de = new Date(d); de.setHours(23, 59, 59, 999);

          return Promise.all([
            prisma.order.aggregate({ where: { ...whereClause, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            prisma.franchiseOrder.aggregate({ where: { ...fOrderWhere, createdAt: { gte: d, lte: de } }, _sum: { totalAmount: true }, _count: { id: true } }),
            Promise.resolve(getBucketCOGS(d, de))
          ]).then(([r1, r2, cogs]) => {
            const sales = franchiseId ? (r1._sum.totalAmount || 0) : ((r1._sum.totalAmount || 0) + (r2._sum.totalAmount || 0));
            const purchase = franchiseId ? (cogs + (r2._sum.totalAmount || 0)) : cogs;
            return {
              date: daysCount > 7 ? `${d.getDate()}/${d.getMonth() + 1}` : DAYS[d.getDay()],
              sales,
              purchase,
              profit: sales - purchase,
              orders: (r1._count.id || 0) + (franchiseId ? 0 : (r2._count.id || 0))
            };
          });
        })
      );
    }

    const b2bRevenue = await prisma.order.aggregate({
      where: { ...whereClause, orderType: 'B2B', createdAt: { gte: today, lte: periodEnd } },
      _sum: { totalAmount: true }
    });

    const revenueBreakdown = franchiseId
      ? [
          { label: "Counter POS", value: posRevenue._sum.totalAmount || 0 }
        ]
      : [
          { label: "Counter POS", value: posRevenue._sum.totalAmount || 0 },
          { label: "Franchise supply", value: franchiseOrdersToday._sum.totalAmount || 0 },
          { label: "Wholesale B2B", value: b2bRevenue._sum.totalAmount || 0 }
        ];

    // Period expenses
    const periodExpenses = await prisma.expense.aggregate({
      where: { ...(franchiseId ? { franchiseId } : {}), date: { gte: today, lte: periodEnd } },
      _sum: { amount: true }
    });

    // Procurement PO total (actual vendor payments — used for KPI card)
    const periodPurchase = await prisma.procurementOrder.aggregate({
      where: { ...poWhere, createdAt: { gte: today, lte: periodEnd }, status: { not: 'CANCELLED' } },
      _sum: { totalAmount: true }
    });

    // Total COGS for the period (used for KPI card if no POs exist)
    const totalCOGS = cogsMovements.reduce((sum, m) => sum + Math.abs(m.quantity) * (m.item.costPrice || 0), 0);
    const franchisePurchaseTotal = franchiseId ? (franchiseOrdersToday._sum.totalAmount || 0) : 0;
    const totalPurchase = ((periodPurchase._sum.totalAmount || 0) > 0
      ? periodPurchase._sum.totalAmount || 0
      : totalCOGS) + franchisePurchaseTotal;

    // Top selling products
    const topSellers = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: { order: { ...whereClause, createdAt: { gte: today, lte: periodEnd } } },
      _sum: { quantity: true, totalAmount: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5
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
    });

    // Recent orders
    const recentOrders = await prisma.order.findMany({
      where: whereClause,
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: { customer: true }
    }).then(orders => orders.map(o => ({
      id: o.invoiceNum,
      amount: o.totalAmount,
      status: o.status.toLowerCase(),
      customerName: o.customer?.name || "Walk-in"
    })));

    return {
      revenueToday: totalRevenueToday,
      totalSales: franchiseId ? (posRevenue._sum.totalAmount || 0) : ((posRevenue._sum.totalAmount || 0) + (franchiseOrdersToday._sum.totalAmount || 0)),
      totalSalesCount,
      totalPurchase,
      revenueChangePct,
      expensesToday: periodExpenses._sum.amount || 0,
      historicalSales,
      revenueBreakdown,
      topSellers,
      recentOrders,
      ordersCountToday: posRevenue._count.id || 0
    };
  }
}
