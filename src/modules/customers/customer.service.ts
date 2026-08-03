import prisma from '../../lib/prisma';

export class CustomerService {
  static async getAll(search?: string, franchiseId?: string) {
    return prisma.customer.findMany({
      where: {
        ...(franchiseId && { franchiseId }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } }
          ]
        })
      },
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

  static async create(data: {
    name: string;
    phone?: string;
    email?: string;
    franchiseId?: string;
    address?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstNumber?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
    asOfDate?: string | Date;
    creditLimit?: number | null;
  }) {
    return prisma.customer.create({
      data: {
        ...data,
        asOfDate: data.asOfDate ? new Date(data.asOfDate) : undefined,
      }
    });
  }

  static async update(id: string, data: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstNumber?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
    asOfDate?: string | Date | null;
    creditLimit?: number | null;
  }) {
    return prisma.customer.update({
      where: { id },
      data: {
        ...data,
        asOfDate: data.asOfDate === null ? null : (data.asOfDate ? new Date(data.asOfDate) : undefined),
      }
    });
  }

  static async delete(id: string) {
    return prisma.customer.delete({ where: { id } });
  }

  /**
   * Bulk per-customer ledger totals for the Customer Ledger list page — avoids an
   * N+1 call per customer to the party-statement report. DEBIT = sale/invoice
   * (increases what the customer owes), CREDIT = payment received (reduces it).
   */
  static async getLedgerSummary(franchiseId?: string) {
    const customers = await prisma.customer.findMany({
      where: franchiseId ? { franchiseId } : undefined,
      include: { ledgerEntries: true }
    });

    return customers.map((c) => {
      let totalSales = 0;
      let totalPaid = 0;
      for (const entry of c.ledgerEntries) {
        if (entry.type === 'DEBIT') totalSales += entry.amount;
        else totalPaid += entry.amount;
      }
      return {
        customerId: c.id,
        totalSales,
        totalPaid,
        balance: totalSales - totalPaid
      };
    });
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
