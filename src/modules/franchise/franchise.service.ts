import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';

export class FranchiseService {
  static async create(input: any) {
    const { adminUser, ...franchiseData } = input;
    
    return prisma.$transaction(async (tx) => {
      // 1. Create Franchise with sanitized data
      // Hash the dashboard password if provided
      const dashboardPasswordHash = franchiseData.dashboardPassword 
        ? await AuthService.hashPassword(franchiseData.dashboardPassword) 
        : null;

      const franchise = await tx.franchise.create({
        data: {
          name: franchiseData.name,
          location: franchiseData.location,
          ownerName: franchiseData.ownerName,
          contactNum: franchiseData.contactNum,
          status: franchiseData.status || 'ACTIVE',
          dashboardPassword: dashboardPasswordHash
        }
      });

      // 2. Create Franchise Admin User if provided (requires email or phone)
      if (adminUser && (adminUser.email || franchiseData.contactNum)) {
        const role = await tx.role.findUnique({ where: { name: 'FRANCHISE_ADMIN' } });
        if (!role) throw new Error('Role [FRANCHISE_ADMIN] not found. Please seed the database.');

        const passwordHash = await AuthService.hashPassword(adminUser.password || 'franchise123');

        await tx.user.create({
          data: {
            fullName: adminUser.fullName || franchiseData.ownerName,
            email: adminUser.email || null,
            phone: franchiseData.contactNum,
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
      select: {
        id: true,
        name: true,
        location: true,
        ownerName: true,
        contactNum: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { users: true, orders: true, inventory: true }
        }
      }
    });
  }

  static async getById(id: string) {
    const franchise = await prisma.franchise.findUnique({
      where: { id },
      include: { 
        users: {
          include: { role: true }
        }, 
        orders: true, 
        expenses: true 
      }
    });

    if (franchise) {
      const { dashboardPassword, ...safeFranchise } = franchise;
      return safeFranchise;
    }
    return null;
  }

  static async verifyDashboardPassword(id: string, password: string) {
    const franchise = await prisma.franchise.findUnique({
      where: { id },
      select: { dashboardPassword: true }
    });

    if (!franchise || !franchise.dashboardPassword) return false;
    
    return AuthService.comparePassword(password, franchise.dashboardPassword);
  }

  static async update(id: string, input: any) {
    const data: any = {
      name: input.name,
      location: input.location,
      ownerName: input.ownerName,
      contactNum: input.contactNum,
      status: input.status
    };

    if (input.dashboardPassword) {
      data.dashboardPassword = await AuthService.hashPassword(input.dashboardPassword);
    }

    return prisma.franchise.update({
      where: { id },
      data
    });
  }

  static async updateStatus(id: string, status: string) {
    return prisma.franchise.update({
      where: { id },
      data: { status }
    });
  }
}
