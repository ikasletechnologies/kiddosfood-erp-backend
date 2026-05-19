import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

export class DashboardDispatchService {
  static async getDispatchStats(franchiseId?: string) {
    const orderWhere: Prisma.OrderWhereInput = franchiseId ? { franchiseId } : {};

    // Pending Deliveries: Orders that are not yet COMPLETED or CANCELLED
    const [pendingOrders, activeFranchiseOrders] = await Promise.all([
      prisma.order.findMany({
        where: {
          ...orderWhere,
          status: { in: ['PENDING', 'PREPARING', 'READY'] }
        },
        include: {
          customer: true
        }
      }),
      // FranchiseOrders (supply requests from HQ) not yet DELIVERED
      prisma.franchiseOrder.count({
        where: franchiseId
          ? { franchiseId, status: { in: ['PENDING', 'APPROVED', 'IN_PRODUCTION', 'DISPATCHED'] } }
          : { status: { in: ['PENDING', 'APPROVED', 'IN_PRODUCTION', 'DISPATCHED'] } }
      })
    ]);

    // Group B2B/Delivery orders by Customer to construct the Pending Dispatch Queue
    const dispatchMap = new Map<string, { dealer: string; invoices: string[]; status: string }>();

    for (const order of pendingOrders) {
      const customerName = order.customer?.name || order.customerId || 'Walk-in Customer';
      const existing = dispatchMap.get(customerName);

      if (existing) {
        existing.invoices.push(order.invoiceNum);
        // Elevate status priority (Preparing > Pending > Ready)
        if (order.status === 'PREPARING' && existing.status !== 'PREPARING') {
          existing.status = 'PREPARING';
        }
      } else {
        dispatchMap.set(customerName, {
          dealer: customerName,
          invoices: [order.invoiceNum],
          status: order.status
        });
      }
    }

    const pendingDispatchQueue = Array.from(dispatchMap.values()).map(item => ({
      dealer: item.dealer,
      invoiceCount: item.invoices.length,
      dispatchStatus: item.status === 'PENDING' ? 'Pending' : item.status === 'PREPARING' ? 'Preparing' : 'Ready to Dispatch'
    }));

    return {
      pendingDeliveries: pendingOrders.length + activeFranchiseOrders,
      pendingDispatchQueue: pendingDispatchQueue.slice(0, 10) // Limit dashboard view
    };
  }
}
