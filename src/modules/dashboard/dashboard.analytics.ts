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

    // For 'all'/'year' periods, limit COGS/bucket lookback to the last 12
    // months to avoid loading years of history.
    const cogsWindowStart = (period === 'all' || period === 'year')
      ? (() => { const d = new Date(periodEnd); d.setMonth(d.getMonth() - 12); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })()
      : today;

    // The historicalSales chart always covers a fixed trailing window ending
    // at periodEnd, independent of `today` (see the bucket-boundary math
    // below) — precompute that window's start once so the bucket-data
    // pre-fetch below covers exactly the range the loop will filter against.
    const daysCount = period === 'month' ? 30 : 7;
    const bucketsWindowStart = period === 'today'
      ? today
      : (period === 'all' || period === 'year')
        ? cogsWindowStart
        : (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - (daysCount - 1)); d.setHours(0, 0, 0, 0); return d; })();

    // Every query below is independent of every other's result — they only
    // depend on the date range/franchise filters computed above — so they're
    // all fired together instead of one after another. This is the single
    // biggest win for dashboard load time: previously the historicalSales
    // chart alone issued up to 60 sequential-per-bucket aggregate queries
    // (2 per hour/day/month bucket); it's now folded into one lean row-fetch
    // per model (orderRows/franchiseOrderRows, mirroring the cogsMovements
    // pre-fetch pattern already used below) and bucketed in memory.
    const [
      posRevenue,
      franchiseOrdersToday,
      prevOrderRevenue,
      prevFranchiseOrderRevenue,
      cogsMovements,
      orderRows,
      franchiseOrderRows,
      b2bRevenue,
      periodExpenses,
      periodPurchase,
      topSellerGroups,
      recentOrdersRaw,
    ] = await Promise.all([
      prisma.order.aggregate({
        where: { ...whereClause, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: { id: true }
      }),
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: { id: true }
      }),
      prisma.order.aggregate({
        where: { ...whereClause, createdAt: { gte: prevPeriodStart, lte: prevPeriodEnd } },
        _sum: { totalAmount: true }
      }),
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, createdAt: { gte: prevPeriodStart, lte: prevPeriodEnd } },
        _sum: { totalAmount: true }
      }),
      // Pre-fetch SALES_OUT stock movements for the period (single query,
      // avoids N+1 per bucket) — COGS for any bucket is derived by filtering
      // this in memory (see getBucketCOGS below).
      prisma.stockMovement.findMany({
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
      }),
      prisma.order.findMany({
        where: { ...whereClause, createdAt: { gte: bucketsWindowStart, lte: periodEnd } },
        select: { totalAmount: true, createdAt: true }
      }),
      prisma.franchiseOrder.findMany({
        where: { ...fOrderWhere, createdAt: { gte: bucketsWindowStart, lte: periodEnd } },
        select: { totalAmount: true, createdAt: true }
      }),
      prisma.order.aggregate({
        where: { ...whereClause, orderType: 'B2B', createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true }
      }),
      prisma.expense.aggregate({
        where: { ...(franchiseId ? { franchiseId } : {}), date: { gte: today, lte: periodEnd } },
        _sum: { amount: true }
      }),
      prisma.procurementOrder.aggregate({
        where: { ...poWhere, createdAt: { gte: today, lte: periodEnd }, status: { not: 'CANCELLED' } },
        _sum: { totalAmount: true }
      }),
      prisma.orderItem.groupBy({
        by: ['productId'],
        where: { order: { ...whereClause, createdAt: { gte: today, lte: periodEnd } } },
        _sum: { quantity: true, totalAmount: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5
      }),
      prisma.order.findMany({
        where: whereClause,
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: true }
      }),
    ]);

    const totalRevenueToday = franchiseId
      ? (posRevenue._sum.totalAmount || 0)
      : (posRevenue._sum.totalAmount || 0) + (franchiseOrdersToday._sum.totalAmount || 0);

    const totalSalesCount = franchiseId
      ? (posRevenue._count.id || 0)
      : (posRevenue._count.id || 0) + (franchiseOrdersToday._count.id || 0);

    const prevRevenue = franchiseId
      ? (prevOrderRevenue._sum.totalAmount || 0)
      : (prevOrderRevenue._sum.totalAmount || 0) + (prevFranchiseOrderRevenue._sum.totalAmount || 0);

    const revenueChangePct = prevRevenue > 0
      ? (((totalRevenueToday - prevRevenue) / prevRevenue) * 100).toFixed(1)
      : "0.0";

    // COGS for a time bucket: sum of |qty| × costPrice for all SALES_OUT in range
    function getBucketCOGS(from: Date, to: Date): number {
      return cogsMovements
        .filter(m => m.createdAt >= from && m.createdAt <= to)
        .reduce((sum, m) => sum + Math.abs(m.quantity) * (m.item.costPrice || 0), 0);
    }

    // Sales/orders for a time bucket, from the pre-fetched row sets above —
    // same in-memory-filter pattern as getBucketCOGS, so a bucket's window
    // never needs its own round trip.
    function getBucketOrders(from: Date, to: Date) {
      let sum = 0, count = 0;
      for (const o of orderRows) if (o.createdAt >= from && o.createdAt <= to) { sum += o.totalAmount; count++; }
      return { sum, count };
    }
    function getBucketFranchiseOrders(from: Date, to: Date) {
      let sum = 0, count = 0;
      for (const o of franchiseOrderRows) if (o.createdAt >= from && o.createdAt <= to) { sum += o.totalAmount; count++; }
      return { sum, count };
    }

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function buildBucket(label: string, d: Date, de: Date) {
      const r1 = getBucketOrders(d, de);
      const r2 = getBucketFranchiseOrders(d, de);
      const cogs = getBucketCOGS(d, de);
      const sales = franchiseId ? r1.sum : (r1.sum + r2.sum);
      const purchase = franchiseId ? (cogs + r2.sum) : cogs;
      return {
        date: label,
        sales,
        purchase,
        profit: sales - purchase,
        orders: r1.count + (franchiseId ? 0 : r2.count)
      };
    }

    let historicalSales: any[] = [];

    if (period === 'today') {
      historicalSales = Array.from({ length: 24 }, (_, i) => {
        const d = new Date(today);
        d.setHours(i, 0, 0, 0);
        const de = new Date(d);
        de.setHours(i, 59, 59, 999);
        return buildBucket(`${i}:00`, d, de);
      });
    } else if (period === 'all' || period === 'year') {
      historicalSales = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(periodEnd);
        d.setMonth(d.getMonth() - (11 - i));
        d.setDate(1); d.setHours(0, 0, 0, 0);
        const de = new Date(d); de.setMonth(de.getMonth() + 1); de.setDate(0); de.setHours(23, 59, 59, 999);
        return buildBucket(MONTHS[d.getMonth()], d, de);
      });
    } else {
      historicalSales = Array.from({ length: daysCount }, (_, i) => {
        const d = new Date(periodEnd);
        d.setDate(d.getDate() - (daysCount - 1 - i));
        d.setHours(0, 0, 0, 0);
        const de = new Date(d); de.setHours(23, 59, 59, 999);
        const label = daysCount > 7 ? `${d.getDate()}/${d.getMonth() + 1}` : DAYS[d.getDay()];
        return buildBucket(label, d, de);
      });
    }

    const revenueBreakdown = franchiseId
      ? [
          { label: "Counter POS", value: posRevenue._sum.totalAmount || 0 }
        ]
      : [
          { label: "Counter POS", value: posRevenue._sum.totalAmount || 0 },
          { label: "Franchise supply", value: franchiseOrdersToday._sum.totalAmount || 0 },
          { label: "Wholesale B2B", value: b2bRevenue._sum.totalAmount || 0 }
        ];

    // Total COGS for the period (used for KPI card if no POs exist)
    const totalCOGS = cogsMovements.reduce((sum, m) => sum + Math.abs(m.quantity) * (m.item.costPrice || 0), 0);
    const franchisePurchaseTotal = franchiseId ? (franchiseOrdersToday._sum.totalAmount || 0) : 0;
    const totalPurchase = ((periodPurchase._sum.totalAmount || 0) > 0
      ? periodPurchase._sum.totalAmount || 0
      : totalCOGS) + franchisePurchaseTotal;

    // Top selling products — batched product lookup instead of one
    // findUnique per group (was a 5-query N+1 on top of the groupBy).
    const topSellerProductIds = topSellerGroups.map(g => g.productId);
    const topSellerProducts = topSellerProductIds.length
      ? await prisma.product.findMany({ where: { id: { in: topSellerProductIds } }, select: { id: true, name: true } })
      : [];
    const productNameById = new Map(topSellerProducts.map(p => [p.id, p.name]));
    const topSellers = topSellerGroups.map(g => ({
      name: productNameById.get(g.productId) || "Unknown",
      value: g._sum.quantity || 0,
      unit: "Units",
      growth: "0"
    }));

    const recentOrders = recentOrdersRaw.map(o => ({
      id: o.invoiceNum,
      amount: o.totalAmount,
      status: o.status.toLowerCase(),
      customerName: o.customer?.name || "Walk-in"
    }));

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
