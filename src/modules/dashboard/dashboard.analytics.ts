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

    const cogsWindowStart = (period === 'all' || period === 'year')
      ? (() => { const d = new Date(periodEnd); d.setMonth(d.getMonth() - 12); d.setDate(1); d.setHours(0, 0, 0, 0); return d; })()
      : today;

    const daysCount = period === 'month' ? 30 : 7;
    const bucketsWindowStart = period === 'today'
      ? today
      : (period === 'all' || period === 'year')
        ? cogsWindowStart
        : (() => { const d = new Date(periodEnd); d.setDate(d.getDate() - (daysCount - 1)); d.setHours(0, 0, 0, 0); return d; })();

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
      orderItemsForPeriod,
    ] = await Promise.all([
      prisma.order.aggregate({
        where: { ...whereClause, status: { not: 'CANCELLED' }, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: { id: true }
      }),
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, status: { in: ['DELIVERED', 'DISPATCHED'] as any }, createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true },
        _count: true
      }),
      prisma.order.aggregate({
        where: { ...whereClause, status: { not: 'CANCELLED' }, createdAt: { gte: prevPeriodStart, lte: prevPeriodEnd } },
        _sum: { totalAmount: true }
      }),
      prisma.franchiseOrder.aggregate({
        where: { ...fOrderWhere, status: { in: ['DELIVERED', 'DISPATCHED'] as any }, createdAt: { gte: prevPeriodStart, lte: prevPeriodEnd } },
        _sum: { totalAmount: true }
      }),
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
        where: { ...whereClause, status: { not: 'CANCELLED' }, createdAt: { gte: bucketsWindowStart, lte: periodEnd } },
        select: { totalAmount: true, createdAt: true }
      }),
      prisma.franchiseOrder.findMany({
        where: { ...fOrderWhere, status: { in: ['DELIVERED', 'DISPATCHED'] as any }, createdAt: { gte: bucketsWindowStart, lte: periodEnd } },
        select: { totalAmount: true, createdAt: true }
      }),
      prisma.order.aggregate({
        where: { ...whereClause, orderType: 'B2B', status: { not: 'CANCELLED' }, createdAt: { gte: today, lte: periodEnd } },
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
        where: { order: { ...whereClause, status: { not: 'CANCELLED' }, createdAt: { gte: today, lte: periodEnd } } },
        _sum: { quantity: true, totalAmount: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 5
      }),
      prisma.order.findMany({
        where: { ...whereClause, status: { not: 'CANCELLED' } },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: true }
      }),
      prisma.orderItem.findMany({
        where: { order: { ...whereClause, status: { not: 'CANCELLED' }, createdAt: { gte: today, lte: periodEnd } } },
        select: {
          quantity: true,
          unitCost: true,
          price: true,
          product: { select: { basePrice: true } }
        }
      }),
    ]);

    const posSum = posRevenue._sum?.totalAmount || 0;
    const fSum = franchiseOrdersToday._sum?.totalAmount || 0;
    const totalRevenueToday = franchiseId ? posSum : (posSum + fSum);

    const posCount = posRevenue._count?.id || 0;
    const fCount = franchiseOrdersToday._count || 0;
    const totalSalesCount = franchiseId ? posCount : (posCount + fCount);

    const prevPosSum = prevOrderRevenue._sum?.totalAmount || 0;
    const prevFSum = prevFranchiseOrderRevenue._sum?.totalAmount || 0;
    const prevRevenue = franchiseId ? prevPosSum : (prevPosSum + prevFSum);

    const revenueChangePct = prevRevenue > 0
      ? (((totalRevenueToday - prevRevenue) / prevRevenue) * 100).toFixed(1)
      : "0.0";

    function getBucketCOGS(from: Date, to: Date): number {
      return cogsMovements
        .filter(m => m.createdAt >= from && m.createdAt <= to)
        .reduce((sum, m) => sum + Math.abs(m.quantity) * (m.item.costPrice || 0), 0);
    }

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
          { label: "Counter POS", value: posSum }
        ]
      : [
          { label: "Counter POS", value: posSum },
          { label: "Franchise supply", value: fSum },
          { label: "Wholesale B2B", value: b2bRevenue._sum?.totalAmount || 0 }
        ];

    const stockMovementCOGS = cogsMovements.reduce((sum, m) => sum + Math.abs(m.quantity) * (m.item.costPrice || 0), 0);
    const orderItemsCOGS = (orderItemsForPeriod || []).reduce(
      (sum, item) => sum + (item.quantity || 0) * (item.unitCost || item.product?.basePrice || item.price * 0.6 || 0),
      0
    );
    const totalCOGS = stockMovementCOGS > 0 ? stockMovementCOGS : orderItemsCOGS;
    const franchisePurchaseTotal = franchiseId ? fSum : 0;
    const totalPurchase = ((periodPurchase._sum?.totalAmount || 0) > 0
      ? (periodPurchase._sum?.totalAmount || 0)
      : totalCOGS) + franchisePurchaseTotal;

    const topSellerProductIds = topSellerGroups.map(g => g.productId);
    const topSellerProducts = topSellerProductIds.length
      ? await prisma.product.findMany({ where: { id: { in: topSellerProductIds } }, select: { id: true, name: true } })
      : [];
    const productNameById = new Map(topSellerProducts.map(p => [p.id, p.name]));
    const topSellers = topSellerGroups.map(g => ({
      name: productNameById.get(g.productId) || "Unknown",
      value: g._sum?.quantity || 0,
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
      totalSales: franchiseId ? posSum : (posSum + fSum),
      totalSalesCount,
      totalPurchase,
      revenueChangePct,
      expensesToday: periodExpenses._sum?.amount || 0,
      historicalSales,
      revenueBreakdown,
      topSellers,
      recentOrders,
      ordersCountToday: posCount
    };
  }
}
