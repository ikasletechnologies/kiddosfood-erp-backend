import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../../middleware/error.middleware';

export class UserService {
  static async getAll(skip = 0, take = 20) {
    return prisma.user.findMany({
      skip,
      take,
      include: { role: true, franchise: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { role: true, franchise: true }
    });
  }

  static async getByFranchise(franchiseId: string) {
    return prisma.user.findMany({
      where: { franchiseId },
      include: { role: true },
    });
  }

  static async create(data: {
    fullName: string;
    email: string;
    phone?: string;
    password?: string;
    roleId?: string;
    roleName?: string;
    franchiseId?: string;
    branchId?: string;
  }) {
    try {
      // 1. Check if user exists
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) throw new AppError('User with this email already exists', 400);

      // 2. Find Role
      let roleId = data.roleId;
      if (!roleId && data.roleName && typeof data.roleName === 'string') {
        const role = await prisma.role.findUnique({ where: { name: data.roleName.toUpperCase() } });
        if (!role) throw new AppError(`Role [${data.roleName}] not found`, 404);
        roleId = role.id;
      }

      if (!roleId) {
        throw new AppError('Role is required (either roleId or roleName)', 400);
      }

      // 3. Hash Password (default to admin123 if not provided)
      const passwordHash = await AuthService.hashPassword(data.password || 'admin123');

      // 4. Create
      const franchiseId = (data.franchiseId && data.franchiseId.trim() !== '' && data.franchiseId !== 'undefined' && data.franchiseId !== 'null') 
        ? data.franchiseId 
        : null;
      
      const branchId = (data.branchId && data.branchId.trim() !== '' && data.branchId !== 'undefined' && data.branchId !== 'null')
        ? data.branchId
        : null;

      return await prisma.user.create({
        data: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          passwordHash,
          roleId: roleId,
          franchiseId: franchiseId,
          branchId: branchId,
          is_active: true
        },
        include: { role: true, franchise: true }
      });
    } catch (error) {
      console.error('[UserService.create] Detailed Error:', error);
      throw error;
    }
  }

  static async updatePassword(userId: string, newPassword: string) {
    const passwordHash = await AuthService.hashPassword(newPassword);
    return prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });
  }

  static async update(id: string, data: any) {
    try {
      const updateData = { ...data };
      if (updateData.franchiseId === '' || updateData.franchiseId === 'null' || updateData.franchiseId === 'undefined') {
        updateData.franchiseId = null;
      }
      if (updateData.branchId === '' || updateData.branchId === 'null' || updateData.branchId === 'undefined') {
        updateData.branchId = null;
      }

      if (updateData.email) {
          const existing = await prisma.user.findFirst({
              where: { email: updateData.email, id: { not: id } }
          });
          if (existing) throw new AppError('Email already in use', 400);
      }

      return await prisma.user.update({
        where: { id },
        data: updateData,
        include: { role: true }
      });
    } catch (error) {
      console.error('[UserService.update] Detailed Error:', error);
      throw error;
    }
  }

  static async delete(id: string) {
    return prisma.user.delete({ where: { id } });
  }
}
