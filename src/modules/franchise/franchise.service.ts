import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';

export class FranchiseService {
  static async create(input: any) {
    const { adminUser, ...franchiseData } = input;
    
    return prisma.$transaction(async (tx) => {
      // 1. Create Franchise with sanitized data
      const franchise = await tx.franchise.create({
        data: {
          name: franchiseData.name,
          location: franchiseData.location,
          ownerName: franchiseData.ownerName,
          contactNum: franchiseData.contactNum,
          status: franchiseData.status || 'ACTIVE'
        }
      });

      // 2. Create Admin User if provided
      if (adminUser && adminUser.email) {
        const role = await tx.role.findUnique({ where: { name: 'ADMIN' } });
        if (!role) throw new Error('Role [ADMIN] not found. Please seed the database.');

        const passwordHash = await AuthService.hashPassword(adminUser.password || 'admin123');

        await tx.user.create({
          data: {
            fullName: adminUser.fullName,
            email: adminUser.email,
            passwordHash,
            roleId: role.id,
            franchiseId: franchise.id,
            is_active: true
          }
        });
      }

      return franchise;
    });
  }

  static async getAll() {
    return prisma.franchise.findMany({
      where: {
        status: { not: 'DELETED' }
      },
      include: {
        _count: {
          select: { users: true, orders: true, inventory: true }
        }
      }
    });
  }

  static async getById(id: string) {
    return prisma.franchise.findUnique({
      where: { id },
      include: { users: true, orders: true, expenses: true }
    });
  }

  static async updateStatus(id: string, status: string) {
    return prisma.franchise.update({
      where: { id },
      data: { status }
    });
  }
}
