import prisma from '../../lib/prisma';

export class DealerService {
  static async getAll(franchiseId?: string) {
    return prisma.dealer.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: { franchise: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async create(data: { name: string; email?: string; phone?: string; address?: string; franchiseId: string }) {
    return prisma.dealer.create({
      data
    });
  }

  static async delete(id: string, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }
    return prisma.dealer.delete({ where: { id } });
  }
}
