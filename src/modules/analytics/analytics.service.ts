import prisma from '../../lib/prisma';
import { PaymentMode } from '@prisma/client';

export class AnalyticsService {
  /**
   * Product Performance: Best-sellers and revenue per product
   */
  static async getProductPerformance(filters: { startDate?: Date; endDate?: Date; franchiseId?: string }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const orderItems = await prisma.orderItem.findMany({
      where: {
        order: {
          createdAt: dateQuery,
          status: 'COMPLETED',
          ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {})
        }
      },
      include: {
        product: true
      }
    });

    const performance: Record<string, { name: string; quantity: number; revenue: number }> = {};

    for (const item of orderItems) {
      if (!performance[item.productId]) {
        performance[item.productId] = { name: item.product.name, quantity: 0, revenue: 0 };
      }
      performance[item.productId].quantity += item.quantity;
      performance[item.productId].revenue += item.totalAmount || 0;
    }

    return Object.values(performance).sort((a, b) => b.revenue - a.revenue);
  }

  /**
   * Payment Distribution: Totals per payment mode
   */
  static async getPaymentDistribution(filters: { startDate?: Date; endDate?: Date; franchiseId?: string }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const payments = await prisma.payment.groupBy({
      by: ['paymentMode'],
      where: {
        createdAt: dateQuery,
        status: 'SUCCESS',
        order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined
      },
      _sum: {
        paidAmount: true
      },
      _count: {
        id: true
      }
    });

    return payments.map(p => ({
      mode: p.paymentMode,
      total: p._sum.paidAmount || 0,
      count: p._count.id
    }));
  }

  /**
   * Wastage Summary: Total loss due to wastage
   */
  static async getWastageSummary(filters: { startDate?: Date; endDate?: Date; franchiseId?: string }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const wastage = await prisma.wastage.aggregate({
      where: {
        date: dateQuery,
        inventoryItem: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined
      },
      _sum: {
        cost: true,
        quantity: true
      }
    });

    return {
      totalCost: wastage._sum.cost || 0,
      totalQuantity: wastage._sum.quantity || 0
    };
  }

  /**
   * Daily Sales Summary: Day-by-day revenue breakdown
   */
  static async getDailySalesSummary(filters: { startDate?: Date; endDate?: Date; franchiseId?: string }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const orders = await prisma.order.findMany({
      where: {
        createdAt: dateQuery,
        status: 'COMPLETED',
        ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {})
      },
      select: {
        createdAt: true,
        totalAmount: true
      }
    });

    const summary: Record<string, number> = {};

    for (const order of orders) {
      const date = order.createdAt.toISOString().split('T')[0];
      summary[date] = (summary[date] || 0) + order.totalAmount;
    }

    return Object.entries(summary).map(([date, total]) => ({ date, total })).sort((a,b) => a.date.localeCompare(b.date));
  }
}
