import prisma from '../../lib/prisma';
import { AccountService } from './account.service';

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
   * Comprehensive Ledger Summary for Reports
   */
  static async getLedgerSummary(filters: { franchiseId?: string; startDate?: Date; endDate?: Date }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? { gte: filters.startDate, lte: filters.endDate } : {})
    };

    const [invoiced, collected, expenseBilled, expensePaid] = await Promise.all([
      // 1. Total Invoiced (Accrual)
      prisma.invoice.aggregate({
        where: { ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}), order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined },
        _sum: { finalAmount: true },
        _count: { id: true }
      }),
      // 2. Total Collected (Cash)
      prisma.payment.aggregate({
        where: { 
          entityType: 'CUSTOMER', 
          status: 'PAID', 
          ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}), 
          order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined 
        },
        _sum: { paidAmount: true }
      }),
      // 3. Total Expense Billed (Accrual)
      prisma.expense.aggregate({
        where: { ...(filters.startDate || filters.endDate ? { date: dateQuery } : {}), franchiseId: filters.franchiseId },
        _sum: { amount: true },
        _count: { id: true }
      }),
      // 4. Total Expense Paid (Cash)
      prisma.payment.aggregate({
        where: { 
          sourceModule: 'EXPENSE', 
          status: 'PAID', 
          ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}), 
          // Linkage check (optional if sourceModule is enough)
        },
        _sum: { paidAmount: true }
      })
    ]);

    const totalInvoiced = invoiced._sum?.finalAmount || 0;
    const totalCollected = collected._sum?.paidAmount || 0;
    const totalExpBilled = expenseBilled._sum?.amount || 0;
    const totalExpPaid = expensePaid._sum?.paidAmount || 0;

    return {
      invoices: {
        count: invoiced._count.id,
        total: totalInvoiced,
        received: totalCollected,
        due: Math.max(0, totalInvoiced - totalCollected)
      },
      expenses: {
        count: expenseBilled._count.id,
        total: totalExpBilled,
        paid: totalExpPaid,
        due: Math.max(0, totalExpBilled - totalExpPaid)
      },
      generatedAt: new Date()
    };
  }

  static async getCashFlow() {

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
    return prisma.$transaction(async (tx) => {
      // 1. Generate Expense Number
      const year = new Date().getFullYear();
      const count = await tx.expense.count({
        where: { date: { gte: new Date(year, 0, 1) } }
      });
      const expenseNumber = `EXP-${year}-${(count + 1).toString().padStart(4, "0")}`;

      const amount = data.amount;
      const initialPaidAmount = data.isPaidImmediately ? amount : 0;
      const status = data.isPaidImmediately ? "PAID" : "UNPAID";

      // 2. Create Expense
      const expense = await tx.expense.create({ 
        data: {
          expenseNumber,
          franchiseId: data.franchiseId,
          category: data.category,
          payee: data.payee,
          amount: amount,
          paidAmount: initialPaidAmount,
          description: data.note || data.description,
          date: data.date ? new Date(data.date) : new Date(),
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          status: status,
          accountId: data.accountId,
          paymentMode: data.paymentMode || 'CASH'
        } 
      });

      // 3. If PAID immediately and account provided, hit the ledger
      if (initialPaidAmount > 0 && data.accountId) {
        await this.createPayment({
          tx,
          amount: initialPaidAmount,
          flow: 'OUT',
          status: 'PAID',
          sourceAccount: data.accountId,
          method: expense.paymentMode || 'CASH',
          sourceModule: 'EXPENSE',
          linkedDocType: 'EXPENSE_BILL',
          linkedDocId: expense.id,
          entity: expense.payee || expense.category,
          createdBy: data.createdBy || 'SYSTEM'
        });
      }

      return expense;
    });
  }

  static async recordExpensePayment(expenseId: string, data: { amount: number, accountId: string, paymentMode: any, note?: string, createdBy?: string }) {
    return prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!expense) throw new Error("Expense not found");
      if (expense.isCancelled) throw new Error("Cannot pay a cancelled expense");

      const remaining = expense.amount - expense.paidAmount;
      if (data.amount > remaining + 0.01) { // small buffer for float
        throw new Error(`Payment amount ₹${data.amount} exceeds remaining balance ₹${remaining}`);
      }

      const newPaidAmount = expense.paidAmount + data.amount;
      const newStatus = newPaidAmount >= expense.amount - 0.01 ? "PAID" : "PARTIAL";

      // 1. Update Expense
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          paidAmount: newPaidAmount,
          status: newStatus,
          accountId: data.accountId, // Store last used account
          paymentMode: data.paymentMode
        }
      });

      // 2. Create Payment Record
      await this.createPayment({
        tx,
        amount: data.amount,
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: data.accountId,
        method: data.paymentMode,
        sourceModule: 'EXPENSE',
        linkedDocType: 'EXPENSE_BILL',
        linkedDocId: expense.id,
        entity: expense.payee || expense.category,
        transactionRef: data.note,
        createdBy: data.createdBy || 'SYSTEM'
      });

      return { success: true };
    });
  }

  static async cancelExpense(expenseId: string, cancelledBy?: string) {
    return prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!expense) throw new Error("Expense not found");
      if (expense.status === "PAID") throw new Error("Cannot cancel a fully paid expense. Please cancel the payments first.");

      // 1. Mark as cancelled
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          isCancelled: true,
          cancelledAt: new Date(),
          status: "CANCELLED"
        }
      });

      // 2. If there were partial payments, they should probably be reversed?
      // For now, enterprise logic usually requires manual reversal of payments to maintain audit trail.
      // But we can check if there are any payments linked and warn.

      return { success: true };
    });
  }

  static async getExpenseDetails(expenseId: string) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { account: true }
    });

    if (!expense) throw new Error("Expense not found");

    const payments = await prisma.payment.findMany({
      where: {
        linkedDocId: expenseId,
        linkedDocType: 'EXPENSE_BILL',
        isCancelled: false
      },
      orderBy: { createdAt: 'desc' }
    });

    return {
      ...expense,
      payments
    };
  }

  static async getExpenses(franchiseId?: string) {
    return prisma.expense.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        isCancelled: false
      },
      include: { account: true },
      orderBy: { date: 'desc' }
    });
  }

  static async getPayments(franchiseId?: string) {
    const payments = await prisma.payment.findMany({
      where: {
        ...(franchiseId ? { order: { franchiseId } } : {}),
      },
      include: { order: true, invoice: true, account: true },
      orderBy: { createdAt: 'desc' }
    });

    return payments.map(p => ({
      id: p.id,
      paymentNumber: p.paymentNumber,
      date: p.createdAt.toISOString(),
      entity: p.entityId || p.transactionRef || "Manual Entry",
      flow: p.entityType === 'VENDOR' ? 'OUT' : 'IN',
      method: p.paymentMode,
      amount: p.paidAmount,
      status: p.status,
      reference: p.transactionRef || "",
      type: p.type,
      sourceModule: p.sourceModule,
      linkedDocType: p.linkedDocType,
      linkedDocId: p.linkedDocId,
      isCancelled: p.isCancelled,
      accountName: p.account?.name || "Unknown",
    }));
  }

  /**
   * Central Ledger Entry Creation
   */
  static async createPayment(data: any) {
    const amount    = parseFloat(data.amount);
    const flow      = data.flow as 'IN' | 'OUT';       
    const status    = (data.status || 'PAID') as string;
    const sourceId = data.sourceAccount as string;    
    const sourceModule = (data.sourceModule || 'MANUAL');
    const linkedDocType = data.linkedDocType || 'DIRECT';
    const linkedDocId = data.linkedDocId;
    const entityId = data.entityId || data.entity; // Compatibility with both naming conventions

    // Robust type mapping for cross-module compatibility
    let paymentType = data.type || 'DIRECT';
    console.log(`[FinanceService] Incoming payment type: ${data.type}, Resolved to: ${paymentType}`);
    if (paymentType === 'PAYMENT') {
      paymentType = 'INVOICE_LINKED';
      console.log(`[FinanceService] Remapped PAYMENT to INVOICE_LINKED`);
    }

    if (flow !== 'IN' && flow !== 'OUT') {
      throw new Error('Invalid payment direction. Must be IN or OUT.');
    }

    const accountTypeMap: Record<string, string> = {
      CASH_ACCOUNT: 'CASH',
      BANK_ACCOUNT: 'BANK',
      UPI_WALLET:   'UPI',
      CASH: 'CASH',
      BANK: 'BANK',
      UPI: 'UPI',
      CARD: 'BANK', // Map CARD to BANK type
      WALLET: 'UPI'  // Map WALLET to UPI type
    };
    const accountType = accountTypeMap[sourceId] ?? accountTypeMap[data.method] ?? 'CASH';

    const operation = async (tx: any) => {
      // 1. Resolve account (Prefer ID, fallback to Type mapping)
      let account;
      if (sourceId && sourceId.length > 20) { // Likely a UUID
         account = await tx.account.findUnique({ where: { id: sourceId } });
      } 
      
      // Fallback if no account found by ID or if sourceId is a Type string
      if (!account) {
         account = await tx.account.findFirst({ where: { type: accountType as any } });
      }

      // 2. Balance check for OUTFLOW + PAID
      if (flow === 'OUT' && status === 'PAID') {
        if (!account) throw new Error(`Source account not found. Please create a ${accountType} account first.`);
        if (account.balance < amount) {
          throw new Error(`Insufficient balance in ${account.name}. Available: ₹${account.balance}`);
        }
      }

      // 3. Generate Payment Number
      const paymentNumber = await this.generatePaymentNumber(tx);

      // 4. Create the payment record
      const payment = await tx.payment.create({
        data: {
          paymentNumber,
          paidAmount:     amount,
          type:           paymentType as any,
          sourceModule:   sourceModule as any,
          linkedDocType:  linkedDocType as any,
          linkedDocId:    linkedDocId,
          vendorInvoiceId: data.vendorInvoiceId,
          entityType:     data.entityType || (flow === 'OUT' ? 'VENDOR' : 'CUSTOMER'),
          entityId:       entityId,
          paymentMode:    data.method as any,
          transactionRef: data.reference || data.note || undefined,
          status,
          accountId:      account?.id ?? undefined,
          createdBy:      data.createdBy,
        },
      });

      // 5. If this is a Vendor Payment, record in VendorLedger (CREDIT)
      if (data.entityType === 'VENDOR' || flow === 'OUT') {
        const vendorId = entityId;
        if (vendorId) {
          const lastEntry = await tx.vendorLedger.findFirst({
            where: { vendorId },
            orderBy: { createdAt: 'desc' }
          });
          const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
          
          await tx.vendorLedger.create({
            data: {
              vendorId,
              type: 'CREDIT',
              amount: amount,
              balanceAfterTransaction: currentBalance + amount,
              sourceModule: sourceModule as any,
              referenceType: data.type === 'ADVANCE' ? 'ADVANCE' : 'PAYMENT',
              referenceId: payment.id,
              invoiceId: data.vendorInvoiceId,
              paymentMode: data.method as any,
              note: data.note || `Payment #${paymentNumber} recorded`
            }
          });

          // Update Invoice Status if linked
          if (data.vendorInvoiceId) {
             const inv = await tx.vendorInvoice.findUnique({ where: { id: data.vendorInvoiceId } });
             if (inv) {
                // Check if fully paid (this is a simple check, better to sum all payments)
                const totalPaid = await tx.payment.aggregate({
                   where: { vendorInvoiceId: data.vendorInvoiceId, status: 'PAID', isCancelled: false },
                   _sum: { paidAmount: true }
                });
                const total = totalPaid._sum.paidAmount || 0;
                if (total >= inv.amount - 0.01) {
                   await tx.vendorInvoice.update({
                      where: { id: data.vendorInvoiceId },
                      data: { status: 'PAID' }
                   });
                }
             }
          }
        }
      }

      // 5. Update account balance — ONLY if status is PAID
      if (account && status === 'PAID') {
        await AccountService.adjustBalance(
          tx, 
          account.id, 
          amount, 
          flow === 'IN' ? 'INFLOW' : 'OUTFLOW'
        );
      }

      return payment;
    };

    if (data.tx) {
      return operation(data.tx);
    } else {
      return prisma.$transaction(async (tx) => operation(tx));
    }
  }

  /**
   * Internal Fund Transfer (Cash to Bank, etc)
   */
  static async transferFunds(data: { fromAccountId: string, toAccountId: string, amount: number, note?: string, createdBy?: string }) {
    return prisma.$transaction(async (tx) => {
      const fromAcc = await tx.account.findUnique({ where: { id: data.fromAccountId } });
      const toAcc = await tx.account.findUnique({ where: { id: data.toAccountId } });

      if (!fromAcc || !toAcc) throw new Error("Source or Destination account not found");
      if (fromAcc.balance < data.amount) throw new Error(`Insufficient balance in ${fromAcc.name}`);

      const pNum = await this.generatePaymentNumber(tx);

      // 1. Outflow from source
      await tx.payment.create({
        data: {
          paymentNumber: pNum,
          paidAmount: data.amount,
          type: 'INTERNAL_TRANSFER' as any,
          sourceModule: 'TRANSFER' as any,
          linkedDocType: 'TRANSFER' as any,
          paymentMode: fromAcc.type as any,
          status: 'PAID',
          accountId: fromAcc.id,
          transactionRef: `Transfer to ${toAcc.name}. ${data.note || ''}`,
          entityType: 'ACCOUNT',
          entityId: toAcc.id,
          createdBy: data.createdBy
        }
      });

      // 2. Inflow to destination
      await tx.payment.create({
        data: {
          paymentNumber: pNum + "-IN", // Sub-ref
          paidAmount: data.amount,
          type: 'INTERNAL_TRANSFER' as any,
          sourceModule: 'TRANSFER' as any,
          linkedDocType: 'TRANSFER' as any,
          paymentMode: toAcc.type as any,
          status: 'PAID',
          accountId: toAcc.id,
          transactionRef: `Transfer from ${fromAcc.name}. ${data.note || ''}`,
          entityType: 'ACCOUNT',
          entityId: fromAcc.id,
          createdBy: data.createdBy
        }
      });

      // 3. Update balances
      await tx.account.update({ where: { id: fromAcc.id }, data: { balance: { decrement: data.amount } } });
      await tx.account.update({ where: { id: toAcc.id }, data: { balance: { increment: data.amount } } });

      return { success: true };
    });
  }

  /**
   * Payment Cancellation (Soft Delete + Reversal Entry)
   */
  static async cancelPayment(paymentId: string, cancelledBy?: string) {
    return prisma.$transaction(async (tx) => {
      const original = await tx.payment.findUnique({ 
        where: { id: paymentId },
        include: { account: true }
      });

      if (!original) throw new Error("Payment not found");
      if (original.isCancelled) throw new Error("Payment already cancelled");

      // 1. Mark original as cancelled
      await tx.payment.update({
        where: { id: paymentId },
        data: { isCancelled: true, cancelledAt: new Date() }
      });

      // 2. If it was PAID, create reversal entry and restore balance
      if (original.status === 'PAID' && original.accountId) {
        const flow = original.entityType === 'VENDOR' ? 'OUT' : 'IN'; // Simplification
        const reversalAmount = original.paidAmount;

        const pNum = await this.generatePaymentNumber(tx);
        
        await tx.payment.create({
          data: {
            paymentNumber: pNum,
            type: 'REVERSAL' as any,
            sourceModule: original.sourceModule,
            linkedDocType: original.linkedDocType,
            linkedDocId: original.linkedDocId,
            paidAmount: reversalAmount,
            paymentMode: original.paymentMode,
            status: 'PAID',
            accountId: original.accountId,
            transactionRef: `REVERSAL of ${original.paymentNumber || original.id}`,
            reversalOfPaymentId: original.id,
            entityType: original.entityType,
            entityId: original.entityId,
            createdBy: cancelledBy
          }
        });

        // Restore balance: 
        // If original was OUT (decreased balance) -> Inflow (increase balance)
        // If original was IN (increased balance) -> Outflow (decrease balance)
        const isOriginalOutflow = (original.entityType === 'VENDOR' || original.type === 'EXPENSE');
        
        await tx.account.update({
          where: { id: original.accountId },
          data: {
            balance: {
              increment: isOriginalOutflow ? reversalAmount : -reversalAmount
            }
          }
        });
      }

      return { success: true };
    });
  }

  private static async generatePaymentNumber(tx: any): Promise<string> {
    const year = new Date().getFullYear();
    const count = await tx.payment.count({
      where: { createdAt: { gte: new Date(year, 0, 1) } }
    });
    return `PAY-${year}-${(count + 1).toString().padStart(4, '0')}`;
  }
}
