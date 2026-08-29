import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';

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
    // No explicit scope requested (SUPER_ADMIN's default "give me my own
    // accounts" view) means "HQ's accounts". Account uses the literal-HQ-id
    // convention — createAccount (via IsolationUtil.enforceFranchiseMatch)
    // stores the real HQ franchise id, never null — unlike InventoryItem,
    // which uses franchiseId=NULL for HQ. Resolving through
    // FranchiseService here keeps list and create consistent instead of
    // querying for a franchiseId value no HQ account actually has.
    const scopeFranchiseId = franchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id || null;
    const accounts = await prisma.account.findMany({
      where: { franchiseId: scopeFranchiseId },
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
        lastTransaction = { type: 'INFLOW', amount: lastPayment.paidAmount, date: lastPayment.createdAt, note: 'Payment Received' };
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
    const account = await prisma.account.findUnique({
      where: { id },
      include: {
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          // Additive join purely for transaction-history traceability (does
          // not affect balance/routing logic below). Payment already stores
          // its own copies of the bill number (linkedDocId) and party type
          // (entityType), but has no FK for a display name — entityId is a
          // generic id into whichever master table entityType names, with
          // no `include`-able relation. Order.customerName is the snapshot
          // POSService.checkout() already writes at sale time for every
          // party type (Customer/Dealer/Franchise alike — see
          // Order.customerName's schema comment), so this join resolves
          // "who paid" with zero extra per-payment lookups instead of a
          // three-way Customer/Dealer/Franchise special case here.
          include: { order: { select: { invoiceNum: true, partyType: true, customerName: true } } }
        },
        expenses: { orderBy: { date: 'desc' }, take: 20 },
        vendorLedgers: { orderBy: { createdAt: 'desc' }, take: 20 },
        customerLedgers: { orderBy: { createdAt: 'desc' }, take: 20 }
      }
    });

    if (!account) return null;

    return {
      ...account,
      // Reference fields the account-detail transaction history row needs
      // to trace a POS-generated payment back to its sale: Bill Number,
      // Party Type, Party Name. Falls back to the payment's own fields for
      // any row not linked to an Order (e.g. a manual/expense entry), so
      // existing non-POS rows keep rendering exactly as before.
      payments: account.payments.map((p) => ({
        ...p,
        billNumber: p.linkedDocId || p.order?.invoiceNum || null,
        partyType: p.entityType || p.order?.partyType || null,
        partyName: p.order?.customerName || p.transactionRef || null,
      }))
    };
  }
}
