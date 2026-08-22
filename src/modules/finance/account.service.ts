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
        // Only posted, non-cancelled payments count as "activity" — same
        // convention as the Day Book / All Transactions reports.
        payments: { where: { status: 'PAID', isCancelled: false }, orderBy: { createdAt: 'desc' }, take: 1 },
        expenses: { orderBy: { createdAt: 'desc' }, take: 1 }
      }
    });

    // Add a virtual 'lastTransaction' property for the UI
    return accounts.map(acc => {
      const lastPayment = acc.payments[0];
      const lastExpense = acc.expenses[0];

      let lastTransaction: any = null;
      if (lastPayment && (!lastExpense || lastPayment.createdAt > lastExpense.createdAt)) {
        // Same outflow classification as Cash Flow / Day Book — a Payment
        // row covers BOTH money in and money out, so it can't be labeled
        // "Payment Received" unconditionally.
        const isOutflow = lastPayment.entityType === 'VENDOR' || lastPayment.sourceModule === 'EXPENSE' || lastPayment.type === 'INTERNAL_TRANSFER';
        const note = !isOutflow
          ? 'Payment Received'
          : lastPayment.sourceModule === 'EXPENSE'
            ? 'Expense Paid'
            : 'Payment Made';
        lastTransaction = { type: isOutflow ? 'OUTFLOW' : 'INFLOW', amount: lastPayment.paidAmount, date: lastPayment.createdAt, note };
      } else if (lastExpense) {
        lastTransaction = { type: 'OUTFLOW', amount: lastExpense.amount, date: lastExpense.createdAt, note: lastExpense.description || 'Business Expense' };
      }

      return { ...acc, lastTransaction };
    });
  }

  // Above this, an opening balance is almost certainly a typo (extra zeros,
  // a pasted value) rather than a real business figure — nothing in this
  // codebase validated `balance` before, which is how one account ended up
  // with a ~2e16 opening balance that then propagated into every summary card.
  static readonly MAX_ACCOUNT_BALANCE = 1_000_000_000_000; // ₹1 trillion

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

    const balance = data.balance || 0;
    if (!Number.isFinite(balance) || Math.abs(balance) > this.MAX_ACCOUNT_BALANCE) {
      throw new Error(`Opening balance ₹${balance.toLocaleString('en-IN')} is out of range. Please check the value (max ₹${this.MAX_ACCOUNT_BALANCE.toLocaleString('en-IN')}).`);
    }

    // 2. Generate ERP account code
    const count = await prisma.account.count();
    const accountCode = `ACC-${(count + 1).toString().padStart(3, '0')}`;

    return prisma.account.create({
      data: {
        name: data.name,
        type: data.type as any,
        balance,
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
