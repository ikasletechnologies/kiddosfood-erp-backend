import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

type PaymentFilters = {
  entityType?: string;
  flowType?: string;
  type?: string;
  search?: string;
};

export class PaymentService {

  // 🔹 GET ALL PAYMENTS (Optimized filtering)
  static async getAll(filters: PaymentFilters) {
    const { entityType, flowType, type, search } = filters;

    const where: Prisma.FinancialPaymentWhereInput = {
      ...(entityType && { entityType }),
      ...(flowType && { flowType }),
      ...(type && { type }),
      ...(search && {
        OR: [
          { entity: { contains: search, mode: 'insensitive' } },
          { reference: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    return prisma.financialPayment.findMany({
      where,
      orderBy: { date: 'desc' },
    });
  }

  // 🔹 GET BY ID
  static async getById(id: string) {
    if (!id) throw new Error('Payment ID is required');

    return prisma.financialPayment.findUnique({
      where: { id },
    });
  }

  // 🔹 RECORD PAYMENT
  static async recordPayment(data: {
    entity: string;
    entityType: string;
    flowType: 'INFLOW' | 'OUTFLOW';
    amount: number;
    method: string;
    reference?: string;
    description?: string;
    type?: string;
  }) {

    if (!data.amount || data.amount <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    return prisma.financialPayment.create({
      data: {
        ...data,
        status: 'PAID',
        date: new Date(),
      },
    });
  }

  // 🔹 GET STATS (More efficient)
  static async getStats() {
    const result = await prisma.financialPayment.groupBy({
      by: ['flowType'],
      where: { status: 'PAID' },
      _sum: { amount: true },
    });

    const summary = result.reduce(
      (acc, curr) => {
        if (curr.flowType === 'INFLOW') acc.inflow = curr._sum.amount || 0;
        if (curr.flowType === 'OUTFLOW') acc.outflow = curr._sum.amount || 0;
        return acc;
      },
      { inflow: 0, outflow: 0 }
    );

    return {
      ...summary,
      balance: summary.inflow - summary.outflow,
    };
  }
}