import prisma from '../../lib/prisma';
import { ChequeStatus, ChequeType } from '@prisma/client';
import { FinanceService } from './finance.service';

export class ChequeService {
  static async getAll(franchiseId?: string) {
    return prisma.cheque.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: { franchise: true },
      orderBy: { dueDate: 'asc' },
    });
  }

  static async create(data: any) {
    return prisma.cheque.create({
      data: {
        chequeNumber: data.chequeNumber,
        bankName: data.bankName,
        payeeName: data.payeeName,
        entityBranch: data.entityBranch,
        amount: parseFloat(data.amount),
        type: data.type as ChequeType,
        issueDate: new Date(data.issueDate),
        dueDate: new Date(data.dueDate),
        status: (data.status as ChequeStatus) || 'PENDING',
        franchiseId: data.franchiseId,
        notes: data.notes,
      },
    });
  }

  /**
   * Clearing a cheque must actually move money — previously this only flipped
   * the status enum with no effect on any Account balance or ledger. Bouncing
   * or re-marking Pending has no cash effect (money never moved), but clearing
   * a RECEIVABLE cheque is an inflow and clearing a PAYABLE cheque is an
   * outflow, posted through the same central FinanceService.createPayment used
   * everywhere else in the app.
   */
  static async updateStatus(id: string, status: ChequeStatus, accountId?: string) {
    const cheque = await prisma.cheque.findUnique({ where: { id } });
    if (!cheque) throw new Error('Cheque not found');

    if (status === 'CLEARED' && cheque.status !== 'CLEARED') {
      const clearingAccountId = accountId || cheque.accountId || undefined;
      if (!clearingAccountId) {
        throw new Error('An account is required to clear a cheque.');
      }

      await FinanceService.createPayment({
        amount: cheque.amount,
        flow: cheque.type === 'RECEIVABLE' ? 'IN' : 'OUT',
        status: 'PAID',
        sourceAccount: clearingAccountId,
        method: 'CHEQUE',
        sourceModule: 'MANUAL',
        linkedDocType: 'DIRECT',
        linkedDocId: cheque.id,
        entity: cheque.payeeName,
        transactionRef: cheque.chequeNumber,
        note: `Cheque ${cheque.chequeNumber} (${cheque.payeeName}) cleared`,
        createdBy: 'SYSTEM_CHEQUE'
      });

      return prisma.cheque.update({
        where: { id },
        data: { status, accountId: clearingAccountId },
      });
    }

    return prisma.cheque.update({
      where: { id },
      data: { status },
    });
  }

  static async getStats(franchiseId?: string) {
    const cheques = await prisma.cheque.findMany({
      where: franchiseId ? { franchiseId } : {},
    });

    const totalVolume = cheques.reduce((acc, c) => acc + c.amount, 0);
    const pendingClearance = cheques
      .filter((c) => c.status === 'PENDING')
      .reduce((acc, c) => acc + c.amount, 0);
    
    const today = new Date().toDateString();
    const clearedToday = cheques
      .filter(
        (c) =>
          c.status === 'CLEARED' &&
          new Date(c.updatedAt).toDateString() === today,
      )
      .reduce((acc, c) => acc + c.amount, 0);
    
    const bouncedRisk = cheques
      .filter((c) => c.status === 'BOUNCED')
      .reduce((acc, c) => acc + c.amount, 0);

    return {
      totalVolume,
      pendingClearance,
      clearedToday,
      bouncedRisk,
    };
  }
}
