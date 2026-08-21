import prisma from '../../lib/prisma';

/**
 * AccountService
 * The central engine for managing money containers (Cash, Bank, UPI).
 * This service ensures that every balance change is tracked and atomic.
 */
export class AccountService {
  /**
   * Adjust an account balance.
   * This should only be called from within a transaction that also records
   * the source of the money movement (Payment, Expense, or Sale).
   */
  static async adjustBalance(
    tx: any, 
    accountId: string, 
    amount: number, 
    action: 'INFLOW' | 'OUTFLOW'
  ) {
    if (amount <= 0) return; // No zero or negative adjustments

    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) throw new Error(`Financial Account not found: ${accountId}`);

    const newBalance = action === 'INFLOW' 
      ? account.balance + amount 
      : account.balance - amount;

    // Safety: Prevent overdrafts if business rules require it (optional)
    // if (newBalance < 0 && account.type === 'CASH') {
    //   throw new Error(`Insufficient funds in account: ${account.name}`);
    // }

    return tx.account.update({
      where: { id: accountId },
      data: { balance: newBalance }
    });
  }

  static async getAccounts(franchiseId?: string | null) {
    const accounts = await prisma.account.findMany({
      where: franchiseId ? { franchiseId } : { franchiseId: null },
      orderBy: { name: 'asc' },
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        expenses: { orderBy: { createdAt: 'desc' }, take: 1 }
      }
    });

    // Add a virtual 'lastTransaction' property for the UI
    return accounts.map(acc => {
      const lastPayment = acc.payments[0];
      const lastExpense = acc.expenses[0];
      
      let lastTransaction: any = null;
      if (lastPayment && (!lastExpense || lastPayment.createdAt > lastExpense.createdAt)) {
        const isOutflow = lastPayment.entityType === 'VENDOR';
        lastTransaction = { type: isOutflow ? 'OUTFLOW' : 'INFLOW', amount: lastPayment.paidAmount, date: lastPayment.createdAt, note: isOutflow ? 'Payment Made' : 'Payment Received' };
      } else if (lastExpense) {
        lastTransaction = { type: 'OUTFLOW', amount: lastExpense.amount, date: lastExpense.createdAt, note: lastExpense.description || 'Business Expense' };
      }

      return { ...acc, lastTransaction };
    });
  }

  static async createAccount(data: { name: string, type: 'CASH' | 'BANK' | 'UPI', balance?: number, franchiseId?: string }) {
    // 1. Prevent duplicate accounts
    const existing = await prisma.account.findFirst({
      where: { 
        name: { equals: data.name, mode: 'insensitive' },
        franchiseId: data.franchiseId || null 
      }
    });

    if (existing) {
      throw new Error(`An account named "${data.name}" already exists.`);
    }

    // 2. Generate ERP account code
    const count = await prisma.account.count();
    const accountCode = `ACC-${(count + 1).toString().padStart(3, '0')}`;

    return prisma.account.create({
      data: {
        name: data.name,
        type: data.type as any,
        balance: data.balance || 0,
        accountCode,
        status: 'ACTIVE',
        franchiseId: data.franchiseId || null
      }
    });
  }

  static async deleteAccount(id: string) {
    // Check if account has transactions before deleting
    const account = await prisma.account.findUnique({
      where: { id },
      include: { _count: { select: { payments: true, vendorLedgers: true } } }
    });

    if (account && (account._count.payments > 0 || account._count.vendorLedgers > 0)) {
      throw new Error("Cannot delete account with existing transaction history.");
    }

    return prisma.account.delete({ where: { id } });
  }

  static async getAccountById(id: string) {
    return prisma.account.findUnique({
      where: { id },
      include: {
        payments: { orderBy: { createdAt: 'desc' }, take: 20 },
        expenses: { orderBy: { date: 'desc' }, take: 20 },
        vendorLedgers: { orderBy: { createdAt: 'desc' }, take: 20 },
        customerLedgers: { orderBy: { createdAt: 'desc' }, take: 20 }
      }
    });
  }
}
