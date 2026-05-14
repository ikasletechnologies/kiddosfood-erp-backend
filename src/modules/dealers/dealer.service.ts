import prisma from '../../lib/prisma';

export class DealerService {
  static async getAll(franchiseId?: string) {
    return prisma.dealer.findMany({
      where: franchiseId ? { franchiseId } : {},
      orderBy: { createdAt: 'desc' }
    });
  }

  static async create(data: { name: string; email?: string; phone?: string; address?: string; franchiseId: string }) {
    return prisma.dealer.create({
      data
    });
  }

  static async delete(id: string) {
    return prisma.dealer.delete({ where: { id } });
  }
}
