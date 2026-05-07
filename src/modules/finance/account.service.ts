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

  static async getAccounts() {
    return prisma.account.findMany({
      orderBy: { name: 'asc' }
    });
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
