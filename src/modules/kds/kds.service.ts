import prisma from '../../lib/prisma';

export class KDSService {
  /** Open kitchen orders, scoped to one branch when franchiseId is given. */
  static async getActiveOrders(franchiseId?: string) {
    return prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PREPARING'] },
        ...(franchiseId ? { franchiseId } : {})
      },
      include: {
        orderItems: {
          include: { product: { include: { recipe: true } } }
        },
        customer: true
      },
      orderBy: { createdAt: 'asc' }
    });
  }
  // Status changes go through POSService.updateOrderStatus (guarded, audited).
}
