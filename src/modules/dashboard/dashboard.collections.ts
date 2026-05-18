import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

export class DashboardCollectionsService {
  static async getCollectionsStats(franchiseId?: string, startDate?: string, endDate?: string) {
    const today = startDate ? new Date(startDate) : new Date();
    if (!startDate) today.setHours(0, 0, 0, 0);

    const periodEnd = endDate ? new Date(endDate) : new Date();
    if (startDate && !endDate) periodEnd.setHours(23, 59, 59, 999);

    const orderWhere: Prisma.OrderWhereInput = franchiseId ? { franchiseId } : {};
    const returnWhere: Prisma.ReturnOrderWhereInput = franchiseId ? { franchiseId } : {};

    // Fetch payments collected today
    const paymentsToday = await prisma.payment.aggregate({
      where: {
        status: 'SUCCESS',
        createdAt: { gte: today, lte: periodEnd },
        order: franchiseId ? { franchiseId } : undefined
      },
      _sum: { paidAmount: true }
    });

    // Fetch sales returns today
    const returnsToday = await prisma.returnOrder.aggregate({
      where: {
        createdAt: { gte: today, lte: periodEnd },
        ...returnWhere
      },
      _sum: { refundAmount: true }
    });

    // Unpaid B2B/Counter Sales total (Pending Collections)
    const pendingCollectionsAggregate = await prisma.order.aggregate({
      where: {
        ...orderWhere,
        paymentStatus: { in: ['UNPAID', 'PARTIAL'] }
      },
      _sum: { totalAmount: true }
    });

    // Fetch all dealers for this franchise
    const dealers = await prisma.dealer.findMany({
      where: franchiseId ? { franchiseId } : {},
      orderBy: { name: 'asc' }
    });

    // For each dealer, fetch matching Customer transactions
    const dealerOutstandingList = await Promise.all(
      dealers.map(async (dealer) => {
        // Find corresponding Customer record by name or phone
        const customer = await prisma.customer.findFirst({
          where: {
            franchiseId,
            OR: [
              { phone: dealer.phone || undefined },
              { name: { equals: dealer.name, mode: 'insensitive' } }
            ]
          }
        });

        if (!customer) {
          return {
            dealer: dealer.name,
            due: 0,
            lastPayment: 'N/A',
            status: 'GREEN',
            priority: 'LOW'
          };
        }

        // Fetch unpaid B2B/POS orders for this Customer
        const unpaidOrders = await prisma.order.findMany({
          where: {
            customerId: customer.id,
            paymentStatus: { in: ['UNPAID', 'PARTIAL'] }
          },
          orderBy: { createdAt: 'asc' } // Oldest first for aging calculation
        });

        const totalDue = unpaidOrders.reduce((sum, order) => sum + order.totalAmount, 0);

        // Fetch last payment
        const lastPayment = await prisma.payment.findFirst({
          where: {
            order: { customerId: customer.id },
            status: 'SUCCESS'
          },
          orderBy: { createdAt: 'desc' }
        });

        let status = 'GREEN';
        let priority = 'LOW';
        let agingDays = 0;

        if (unpaidOrders.length > 0) {
          const oldestOrderDate = new Date(unpaidOrders[0].createdAt);
          const diffTime = Math.abs(Date.now() - oldestOrderDate.getTime());
          agingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (agingDays > 15) {
            status = 'RED';
            priority = 'HIGH';
          } else if (agingDays > 7) {
            status = 'YELLOW';
            priority = 'MEDIUM';
          }
        }

        return {
          dealer: dealer.name,
          due: totalDue,
          lastPayment: lastPayment ? new Date(lastPayment.createdAt).toLocaleDateString() : 'No Payments',
          status,
          priority,
          agingDays
        };
      })
    );

    // Sum of all dealer dues
    const totalDealerOutstanding = dealerOutstandingList.reduce((sum, d) => sum + d.due, 0);

    // Overdue dealers count (unpaid invoices > 7 days old)
    const overdueDealersCount = dealerOutstandingList.filter(d => d.due > 0 && d.status !== 'GREEN').length;

    return {
      todayCollection: paymentsToday._sum.paidAmount || 0,
      salesReturnsToday: returnsToday._sum.refundAmount || 0,
      pendingCollections: pendingCollectionsAggregate._sum.totalAmount || 0,
      totalDealerOutstanding,
      overdueDealersCount,
      dealerOutstanding: dealerOutstandingList.slice(0, 10) // Limit dashboard view
    };
  }
}
