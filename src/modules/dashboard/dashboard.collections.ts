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
    const customerWhere: Prisma.CustomerWhereInput = franchiseId ? { franchiseId } : {};

    // Previously this fetched dealers, then per-dealer ran a customer lookup
    // + unpaid-orders fetch + last-payment fetch (3 queries × every dealer) —
    // unbounded and grows linearly with the dealer network. Batched below:
    // one customer fetch, then match dealers to customers in memory, then
    // one order fetch and one payment fetch across every matched customer.
    const [paymentsToday, returnsToday, pendingCollectionsAggregate, dealers, customers] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          status: 'SUCCESS',
          createdAt: { gte: today, lte: periodEnd },
          order: franchiseId ? { franchiseId } : undefined
        },
        _sum: { paidAmount: true }
      }),
      prisma.returnOrder.aggregate({
        where: {
          createdAt: { gte: today, lte: periodEnd },
          ...returnWhere
        },
        _sum: { refundAmount: true }
      }),
      prisma.order.aggregate({
        where: {
          ...orderWhere,
          paymentStatus: { in: ['UNPAID', 'PARTIAL'] }
        },
        _sum: { totalAmount: true }
      }),
      prisma.dealer.findMany({
        where: franchiseId ? { franchiseId } : {},
        orderBy: { name: 'asc' }
      }),
      prisma.customer.findMany({
        where: customerWhere,
        select: { id: true, name: true, phone: true }
      }),
    ]);

    // Same match rule as before (phone match, else case-insensitive name
    // match), just resolved in memory against one customer fetch instead of
    // a findFirst query per dealer.
    const dealerToCustomerId = new Map<string, string>();
    for (const dealer of dealers) {
      const match = customers.find(c =>
        (dealer.phone && c.phone === dealer.phone) ||
        c.name?.toLowerCase() === dealer.name?.toLowerCase()
      );
      if (match) dealerToCustomerId.set(dealer.id, match.id);
    }
    const matchedCustomerIds = Array.from(new Set(dealerToCustomerId.values()));

    const [unpaidOrders, recentPayments] = matchedCustomerIds.length
      ? await Promise.all([
          prisma.order.findMany({
            where: { customerId: { in: matchedCustomerIds }, paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
            orderBy: { createdAt: 'asc' },
            select: { customerId: true, totalAmount: true, createdAt: true }
          }),
          prisma.payment.findMany({
            where: { status: 'SUCCESS', order: { customerId: { in: matchedCustomerIds } } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, order: { select: { customerId: true } } }
          }),
        ])
      : [[], []];

    const unpaidByCustomer = new Map<string, typeof unpaidOrders>();
    for (const o of unpaidOrders) {
      if (!o.customerId) continue;
      const list = unpaidByCustomer.get(o.customerId);
      if (list) list.push(o); else unpaidByCustomer.set(o.customerId, [o]);
    }

    // recentPayments is ordered desc, so the first one seen per customer is
    // their most recent — same result as the old per-customer findFirst.
    const lastPaymentByCustomer = new Map<string, Date>();
    for (const p of recentPayments) {
      const cid = p.order?.customerId;
      if (cid && !lastPaymentByCustomer.has(cid)) lastPaymentByCustomer.set(cid, p.createdAt);
    }

    const dealerOutstandingList = dealers.map((dealer) => {
      const customerId = dealerToCustomerId.get(dealer.id);
      if (!customerId) {
        return { dealer: dealer.name, due: 0, lastPayment: 'N/A', status: 'GREEN', priority: 'LOW' };
      }

      const unpaid = unpaidByCustomer.get(customerId) || [];
      const totalDue = unpaid.reduce((sum, order) => sum + order.totalAmount, 0);
      const lastPaymentAt = lastPaymentByCustomer.get(customerId);

      let status = 'GREEN';
      let priority = 'LOW';
      let agingDays = 0;

      if (unpaid.length > 0) {
        const oldestOrderDate = new Date(unpaid[0].createdAt);
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
        lastPayment: lastPaymentAt ? lastPaymentAt.toLocaleDateString() : 'No Payments',
        status,
        priority,
        agingDays
      };
    });

    const totalDealerOutstanding = dealerOutstandingList.reduce((sum, d) => sum + d.due, 0);
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
