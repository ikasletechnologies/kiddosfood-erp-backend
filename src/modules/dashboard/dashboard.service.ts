import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

export class DashboardService {
  static async getSummary(params: { franchiseId?: string; startDate?: string; endDate?: string }) {
    const { franchiseId, startDate, endDate } = params;
    
    const today = startDate ? new Date(startDate) : new Date();
    if (!startDate) today.setHours(0, 0, 0, 0);

    const periodEnd = endDate ? new Date(endDate) : new Date();
    // If no end date given but start date given, maybe end is end of that start day
    if (startDate && !endDate) periodEnd.setHours(23, 59, 59, 999);

    const timeDiff = periodEnd.getTime() - today.getTime();
    
    const previousPeriodStart = new Date(today.getTime() - timeDiff - (1000 * 60 * 60 * 24));
    const previousPeriodEnd = new Date(today.getTime() - 1);

    const whereClause: Prisma.OrderWhereInput = franchiseId ? { franchiseId } : {};
    const itemWhereClause: Prisma.InventoryItemWhereInput = franchiseId ? { franchiseId } : {};
    const expenseWhereClause: Prisma.ExpenseWhereInput = franchiseId ? { franchiseId } : {};

    const [
      ordersToday,
      revenueToday,
      revenueYesterday,
      inventoryCount,
      vendorCount,
      kitchenCounts,
      lowStockItems,
      periodExpenses,
      paymentData,
    ] = await Promise.all([
      // 0
      prisma.order.count({
        where: { ...whereClause, createdAt: { gte: today, lte: periodEnd } }
      }),
      // 1
      prisma.order.aggregate({
        where: { ...whereClause, status: 'COMPLETED', createdAt: { gte: today, lte: periodEnd } },
        _sum: { totalAmount: true }
      }),
      // 2
      prisma.order.aggregate({
        where: { ...whereClause, status: 'COMPLETED', createdAt: { gte: previousPeriodStart, lte: previousPeriodEnd } },
        _sum: { totalAmount: true }
      }),
      // 3
      prisma.inventoryItem.count({ where: itemWhereClause }),
      // 4
      prisma.vendor.count(),
      // 5
      prisma.order.groupBy({
        by: ['status'],
        where: { ...whereClause, status: { in: ['PENDING', 'PREPARING', 'COMPLETED', 'CANCELLED'] }, createdAt: { gte: today, lte: periodEnd } },
        _count: { id: true }
      }),
      // 6
      prisma.inventoryItem.findMany({ where: itemWhereClause })
        .then(items => items.filter(i => i.currentStock <= i.minimumStock)),
      // 7
      prisma.expense.aggregate({
        where: { ...expenseWhereClause, date: { gte: today, lte: periodEnd } },
        _sum: { amount: true }
      }),
      // 8: Payment Modes Breakdown
      prisma.payment.groupBy({
        by: ['paymentMode'],
        where: {
          createdAt: { gte: today, lte: periodEnd },
          status: 'SUCCESS',
          ...(franchiseId ? { order: { franchiseId } } : {})
        },
        _sum: { paidAmount: true }
      })
    ]);
    
    // Process order status counts
    let kitchenQueue = 0;
    const orderStages = { PENDING: 0, PREPARING: 0, COMPLETED: 0, CANCELLED: 0 };
    kitchenCounts.forEach(k => {
      if (k.status === 'PENDING' || k.status === 'PREPARING') kitchenQueue += k._count.id;
      if (orderStages[k.status as keyof typeof orderStages] !== undefined) {
        orderStages[k.status as keyof typeof orderStages] = k._count.id;
      }
    });

    // Recent orders with items
    const recentOrders = await prisma.order.findMany({
      where: whereClause,
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        orderItems: { include: { product: true } },
        franchise: true
      }
    });

    // Top sellers
    const topSellersAgg = await prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        order: { ...whereClause, createdAt: { gte: today, lte: periodEnd } }
      },
      _sum: { quantity: true, totalAmount: true },
      orderBy: { _sum: { quantity: 'desc' } },
    });

    const topSellersWithNames = await Promise.all(
      topSellersAgg.map(async (ts) => {
        const product = await prisma.product.findUnique({ where: { id: ts.productId } });
        return {
          name: product?.name || 'Unknown',
          count: ts._sum.quantity || 0,
          revenue: ts._sum.totalAmount || 0
        };
      })
    );

    const topSellers = topSellersWithNames.slice(0, 4);
    const lowSellers = [...topSellersWithNames].sort((a,b) => a.count - b.count).slice(0, 3);
    const suggestedRestock = lowStockItems.slice(0, 3).map(i => i.name);

    // Normalise top sellers to percentages
    const maxCount = topSellers[0]?.count || 1;
    const topSellersFormatted = topSellers.map(ts => ({
      ...ts,
      pct: Math.round((ts.count / maxCount) * 100)
    }));

    // Weekly sales (last 7 days from periodEnd)
    const weeklyData: { day: string; value: number; height: number }[] = [];
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let weekMax = 0;

    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(periodEnd);
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0,0,0,0);
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const revenue = await prisma.order.aggregate({
        where: { ...whereClause, status: 'COMPLETED', createdAt: { gte: dayStart, lte: dayEnd } },
        _sum: { totalAmount: true }
      });

      const val = revenue._sum.totalAmount || 0;
      if (val > weekMax) weekMax = val;
      weeklyData.push({ day: DAYS[dayStart.getDay()], value: val, height: 0 });
    }

    // Calculate heights relative to max
    const weekly = weeklyData.map(d => ({
      ...d,
      height: weekMax > 0 ? Math.round((d.value / weekMax) * 100) : 0
    }));

    const weekTotal = weekly.reduce((acc, d) => acc + d.value, 0);
    const avgPerDay = weekly.length > 0 ? weekTotal / weekly.length : 0;
    const bestDay = [...weekly].sort((a, b) => b.value - a.value)[0];

    // Revenue change % vs prev period
    const todayRevenue = revenueToday._sum.totalAmount || 0;
    const yestRevenue = revenueYesterday._sum.totalAmount || 0;
    const revenueChangePct = yestRevenue > 0
      ? (((todayRevenue - yestRevenue) / yestRevenue) * 100).toFixed(1)
      : null;

    // Gross Profit calculation (assuming basic 40% margin on revenue for illustration if COGS isn't tracked perfectly)
    // You have expenses however, so net profit = Gross Margin - Expenses
    // For a food business, let's assume a 60% gross margin on revenue, minus expenses.
    const expenses = periodExpenses._sum.amount || 0;
    const estimatedCOGS = todayRevenue * 0.40; 
    const profitToday = todayRevenue - estimatedCOGS - expenses;

    return {
      stats: {
        ordersToday,
        inventoryItems: inventoryCount,
        activeSuppliers: vendorCount,
        revenueToday: todayRevenue,
        revenueYesterday: yestRevenue,
        revenueChangePct,
        expensesToday: expenses,
        profitToday: profitToday,
        paymentBreakdown: paymentData.map(p => ({
          mode: p.paymentMode,
          amount: p._sum.paidAmount || 0
        })),
        kitchenQueue,
        lowStockCount: lowStockItems.length,
        orderStages 
      },
      insights: {
        lowSellers,
        suggestedRestock
      },
      lowStock: lowStockItems.slice(0, 5).map(item => ({
        name: item.name,
        currentStock: item.currentStock,
        minimumStock: item.minimumStock,
        unit: item.unit,
        severity: item.currentStock === 0 ? 'critical' : 'warning'
      })),
      recentOrders: recentOrders.map(o => {
        const itemsSummary = o.orderItems
          .map(i => `${i.product?.name} x${i.quantity}`)
          .join(', ');
        const minutesAgo = Math.floor((Date.now() - new Date(o.createdAt).getTime()) / 60000);
        return {
          id: o.invoiceNum,
          table: o.orderType === 'DELIVERY' ? 'Delivery' : o.orderType === 'TAKEAWAY' ? 'Takeaway' : `Table`,
          items: itemsSummary || 'No items',
          amount: o.totalAmount,
          status: o.status.toLowerCase(),
          time: minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.floor(minutesAgo / 60)}h ago`,
          franchiseName: o.franchise?.name
        };
      }),
      topSellers: topSellersFormatted,
      weeklySales: weekly,
      weeklyStats: {
        total: weekTotal,
        avgPerDay: Math.round(avgPerDay),
        bestDay: bestDay?.day || '-',
        bestDayValue: bestDay?.value || 0
      }
    };
  }
}
