import prisma from '../../lib/prisma';
import { ChequeStatus, ChequeType } from '@prisma/client';

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

  static async updateStatus(id: string, status: ChequeStatus) {
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
