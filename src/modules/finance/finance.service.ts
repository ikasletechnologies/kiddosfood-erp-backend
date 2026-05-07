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

  /**
   * Profit & Loss with COGS logic
   */
  static async getProfitAndLoss(filters: { franchiseId?: string; startDate?: Date; endDate?: Date }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    // 1. Revenue
    const sales = await prisma.invoice.findMany({
      where: {
        status: 'PAID',
        ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
        order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined
      },
      include: { order: { include: { orderItems: { include: { product: { include: { recipe: { include: { recipeItems: { include: { inventoryItem: { include: { vendors: true } } } } } } } } } } } } }
    });

    let totalRevenue = 0;
    let totalCOGS = 0;

    for (const inv of sales) {
      if (!inv.order) continue;
      totalRevenue += inv.finalAmount;
      for (const item of inv.order.orderItems) {
        const product = item.product;
        if (product && product.recipe) {
          const scalar = item.quantity / product.recipe.yieldQty;
          for (const ri of product.recipe.recipeItems) {
            const qtyUsed = ri.quantityRequired * scalar;
            // Use last supplied price as cost placeholder
            const costPerUnit = ri.inventoryItem.vendors[0]?.price || 0; 
            totalCOGS += (qtyUsed * costPerUnit);
          }
        }
      }
    }

    // 2. Expenses
    const expenses = await prisma.expense.aggregate({
      where: {
        ...(filters.startDate || filters.endDate ? { date: dateQuery } : {}),
        franchiseId: filters.franchiseId
      },
      _sum: { amount: true }
    });

    const totalExpenses = expenses._sum.amount || 0;
    const grossProfit = totalRevenue - totalCOGS;

    return {
      revenue: totalRevenue,
      cogs: totalCOGS,
      grossProfit: grossProfit,
      expenses: totalExpenses,
      netProfit: grossProfit - totalExpenses,
      period: filters
    };
  }

  /**
   * Cash Flow Status
   */
  static async getCashFlow() {
    // @ts-ignore
    const accounts = await prisma.account.findMany();

    const totalCash = accounts.filter(a => a.type === 'CASH').reduce((s, a) => s + a.balance, 0);
    const totalBank = accounts.filter(a => a.type === 'BANK').reduce((s, a) => s + a.balance, 0);
    const totalUPI = accounts.filter(a => a.type === 'UPI').reduce((s, a) => s + a.balance, 0);

    return {
      accounts,
      totalLiquidity: totalCash + totalBank + totalUPI,
      breakdown: { cash: totalCash, bank: totalBank, upi: totalUPI }
    };
  }

  static async getInvoices(franchiseId?: string) {
    return prisma.invoice.findMany({
      where: franchiseId ? { order: { franchiseId } } : undefined,
      include: { order: { include: { customer: true } }, payments: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async addExpense(data: any) {
    return prisma.expense.create({ 
      data: {
        franchiseId: data.franchiseId,
        category: data.category,
        amount: data.amount,
        description: data.note || data.description,
        date: data.date ? new Date(data.date) : new Date(),
      } 
    });
  }

  static async getExpenses(franchiseId?: string) {
    return prisma.expense.findMany({
      where: franchiseId ? { franchiseId } : undefined,
      orderBy: { date: 'desc' }
    });
  }

  static async getPayments(franchiseId?: string) {
    const payments = await prisma.payment.findMany({
      where: franchiseId ? { order: { franchiseId } } : undefined,
      // @ts-ignore
      include: { order: true, invoice: true, account: true },
      orderBy: { createdAt: 'desc' }
    });

    return payments.map(p => ({
      id: p.id,
      date: p.createdAt.toISOString(),
      // @ts-ignore
      entity: p.entityId || p.transactionRef || "Manual Entry",
      // @ts-ignore
      flow: p.entityType === 'VENDOR' ? 'OUT' : 'IN',
      method: p.paymentMode,
      amount: p.paidAmount,
      status: p.status,
      // @ts-ignore
      reference: p.transactionRef || "",
      // @ts-ignore
      type: p.type || "DIRECT"
    }));
  }

  static async createPayment(data: any) {
    const amount    = parseFloat(data.amount);
    const flow      = data.flow as 'IN' | 'OUT';       // 'IN' = customer receipt, 'OUT' = vendor/expense
    const status    = (data.status || 'PAID') as string;
    const sourceKey = data.sourceAccount as string;    // 'CASH_ACCOUNT' | 'BANK_ACCOUNT' | 'UPI_WALLET'

    // ── 1. Backend entity-direction guard ──────────────────────────────────────
    // Never trust the frontend alone — enforce at DB layer too.
    if (flow !== 'IN' && flow !== 'OUT') {
      throw new Error('Invalid payment direction. Must be IN or OUT.');
    }

    // ── 2. Map sourceAccount UI key → AccountType enum ───────────────────────
    const accountTypeMap: Record<string, string> = {
      CASH_ACCOUNT: 'CASH',
      BANK_ACCOUNT: 'BANK',
      UPI_WALLET:   'UPI',
    };
    const accountType = accountTypeMap[sourceKey] ?? 'CASH';

    return prisma.$transaction(async (tx) => {
      // ── 3. Resolve account (first matching type) ──────────────────────────
      // @ts-ignore
      const account = await tx.account.findFirst({ where: { type: accountType } });

      // ── 4. Balance check — only for OUTFLOW + PAID ────────────────────────
      // Pending/Failed payments don't move money → no check needed.
      if (flow === 'OUT' && status === 'PAID') {
        if (!account) {
          throw new Error(
            `No ${accountType} account found. Please ensure accounts are configured.`
          );
        }
        if (account.balance < amount) {
          throw new Error(
            `Insufficient ${accountType} balance. ` +
            `Available: ₹${account.balance.toFixed(2)}, Required: ₹${amount.toFixed(2)}.`
          );
        }
      }

      // ── 5. Create the payment record ──────────────────────────────────────
      // @ts-ignore
      const payment = await tx.payment.create({
        data: {
          paidAmount:     amount,
          type:           'DIRECT' as any,
          entityType:     flow === 'OUT' ? 'VENDOR' : 'CUSTOMER',
          entityId:       data.entity,
          paymentMode:    data.method as any,
          transactionRef: data.reference || data.note || undefined,
          status,
          accountId:      account?.id ?? undefined,
        },
      });

      // ── 6. Update account balance — ONLY if status is PAID ────────────────
      // PENDING → no money moves (liability recorded, not settled)
      // FAILED  → no money moves (transaction did not succeed)
      // PAID    → money actually moved, adjust the real balance
      if (account && status === 'PAID') {
        // @ts-ignore
        await tx.account.update({
          where: { id: account.id },
          data: {
            balance: {
              // IN  (customer pays us) → balance increases
              // OUT (we pay someone)   → balance decreases
              increment: flow === 'IN' ? amount : -amount,
            },
          },
        });
      }

      return payment;
    });
  }
}
