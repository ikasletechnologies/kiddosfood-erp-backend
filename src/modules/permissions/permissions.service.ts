import prisma from '../../lib/prisma';

export class PermissionsService {
  static async getAll() {
    return prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { action: 'asc' }],
      include: {
        roles: { include: { role: { select: { id: true, name: true } } } },
      },
    });
  }
}
