import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../../middleware/error.middleware';
import { UserRole } from '@prisma/client';

export class UserService {
  static async getAll(skip = 0, take = 20) {
    return prisma.user.findMany({
      skip,
      take,
      include: { franchise: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { franchise: true }
    });
  }

  static async getByFranchise(franchiseId: string) {
    return prisma.user.findMany({
      where: { franchiseId }
    });
  }

  static async create(data: {
    fullName: string;
    email: string;
    phone?: string;
    password?: string;
    role?: UserRole;
    franchiseId?: string;
    branchId?: string;
  }) {
    try {
      // 1. Check if user exists
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) throw new AppError('User with this email already exists', 400);

      // 2. Hash Password (default to admin123 if not provided)
      const passwordHash = await AuthService.hashPassword(data.password || 'admin123');

      // 3. Cleanup IDs
      const franchiseId = (data.franchiseId && data.franchiseId.trim() !== '' && data.franchiseId !== 'undefined' && data.franchiseId !== 'null') 
        ? data.franchiseId 
        : null;
      
      const branchId = (data.branchId && data.branchId.trim() !== '' && data.branchId !== 'undefined' && data.branchId !== 'null')
        ? data.branchId
        : null;

      // 4. Create
      return await prisma.user.create({
        data: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          passwordHash,
          role: data.role || UserRole.FRANCHISE_ADMIN,
          franchiseId: franchiseId,
          branchId: branchId,
          is_active: true
        },
        include: { franchise: true }
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

      // Handle password update if provided
      if (updateData.password && updateData.password.trim() !== '') {
        updateData.passwordHash = await AuthService.hashPassword(updateData.password);
      }
      delete updateData.password;

      return await prisma.user.update({
        where: { id },
        data: updateData
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
