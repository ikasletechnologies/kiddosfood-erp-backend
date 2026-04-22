import prisma from '../../lib/prisma';

export class CustomerService {
  static async getAll(search?: string) {
    return prisma.customer.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { email: { contains: search, mode: 'insensitive' } }
            ]
          }
        : undefined,
      include: {
        orders: {
          select: { id: true, totalAmount: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.customer.findUnique({
      where: { id },
      include: {
        orders: {
          include: { orderItems: { include: { product: true } }, payments: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
  }

  static async create(data: { name: string; phone?: string; email?: string }) {
    return prisma.customer.create({ data });
  }

  static async update(id: string, data: { name?: string; phone?: string; email?: string }) {
    return prisma.customer.update({ where: { id }, data });
  }

  static async delete(id: string) {
    return prisma.customer.delete({ where: { id } });
  }

  static async getLoyalty(customerId: string) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, phone: true, loyaltyPoints: true }
    });
    if (!customer) return null;

    const totalSpend = await prisma.order.aggregate({
      where: { customerId },
      _sum: { totalAmount: true }
    });

    const totalOrders = await prisma.order.count({ where: { customerId } });

    const tier =
      (customer.loyaltyPoints >= 4000 && 'PLATINUM') ||
      (customer.loyaltyPoints >= 2000 && 'GOLD') ||
      (customer.loyaltyPoints >= 1000 && 'SILVER') ||
      'BRONZE';

    return {
      ...customer,
      totalSpend: totalSpend._sum.totalAmount || 0,
      totalOrders,
      tier
    };
  }

  static async addPoints(customerId: string, points: number) {
    return prisma.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: { increment: points } }
    });
  }

  static async redeemPoints(customerId: string, points: number) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new Error('Customer not found');
    if (customer.loyaltyPoints < points) throw new Error('Insufficient loyalty points');
    return prisma.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: { decrement: points } }
    });
  }
}
