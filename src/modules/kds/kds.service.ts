import prisma from '../../lib/prisma';

export class KDSService {
  static async getActiveOrders() {
    return prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PREPARING'] }
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

  static async updateOrderStatus(id: string, status: 'PENDING' | 'PREPARING' | 'COMPLETED') {
    return prisma.order.update({
      where: { id },
      data: { status },
      include: {
        orderItems: { include: { product: true } },
        customer: true
      }
    });
  }
}
