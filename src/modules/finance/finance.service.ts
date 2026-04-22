import prisma from '../../lib/prisma';

export class FinanceService {
  /**
   * Automatically generate an Invoice for a completed order
   */
  static async createInvoiceFromOrder(orderId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId }
      });

      if (!order) throw new Error('Order not found');

      // 1. Calculate Tax (5% GST as per Phase 5 instructions)
      const subTotal = order.subTotal;
      const taxAmount = Number((subTotal * 0.05).toFixed(2));
      const finalAmount = subTotal + taxAmount;

      // 2. Create Invoice
      const invoice = await tx.invoice.upsert({
        where: { orderId },
        update: {
          totalAmount: subTotal,
          taxAmount: taxAmount,
          finalAmount: finalAmount,
          status: 'PAID' // Default since POS orders are usually paid at completion
        },
        create: {
          orderId,
          totalAmount: subTotal,
          taxAmount: taxAmount,
          finalAmount: finalAmount,
          status: 'PAID'
        }
      });

      // 3. Link existing payments to this invoice (if any)
      await tx.payment.updateMany({
        where: { orderId },
        data: { invoiceId: invoice.id }
      });

      return invoice;
    });
  }

  /**
   * Automatically log an Expense when a Purchase is received
   */
  static async recordExpenseFromPurchase(poId: string) {
    const po = await prisma.procurementOrder.findUnique({
      where: { id: poId },
      include: { vendor: true }
    });

    if (!po) throw new Error('Purchase Order not found');

    return prisma.expense.create({
      data: {
        category: 'RAW_MATERIAL_PURCHASE',
        amount: po.totalAmount,
        description: `Purchase from ${po.vendor.name} (PO: ${po.id})`,
        purchaseOrderId: po.id
      }
    });
  }

  /**
   * Comprehensive Financial Reports
   */
  static async getFinancialReport(filters: { franchiseId?: string; startDate?: Date; endDate?: Date }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    // 1. Total Sales (from Invoices linked to Orders in specific branch)
    const sales = await prisma.invoice.aggregate({
      where: {
        status: 'PAID',
        ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
        order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined
      },
      _sum: { finalAmount: true }
    });

    // 2. Total Expenses
    const expenses = await prisma.expense.aggregate({
      where: {
        ...(filters.startDate || filters.endDate ? { date: dateQuery } : {}),
        franchiseId: filters.franchiseId
      },
      _sum: { amount: true }
    });

    const totalSales = sales._sum.finalAmount || 0;
    const totalExpenses = expenses._sum.amount || 0;

    return {
      revenue: totalSales,
      expenses: totalExpenses,
      netProfit: totalSales - totalExpenses,
      generatedAt: new Date()
    };
  }

  static async getInvoices(franchiseId?: string) {
    return prisma.invoice.findMany({
      where: franchiseId ? { order: { franchiseId } } : undefined,
      include: { order: { include: { customer: true } }, payments: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async addExpense(data: { franchiseId: string, category: string, amount: number, description?: string }) {
    return prisma.expense.create({ data });
  }
}
