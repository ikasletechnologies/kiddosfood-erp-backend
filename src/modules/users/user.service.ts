import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../../middleware/error.middleware';
import { AuditService } from '../audit/audit.service';
import { UserRole } from '@prisma/client';

const CUSTOM_ROLE_INCLUDE = { customRole: { include: { permissions: { include: { permission: true } } } } };

export class UserService {
  static async getAll(skip = 0, take = 20) {
    return prisma.user.findMany({
      skip,
      take,
      include: { franchise: true, ...CUSTOM_ROLE_INCLUDE },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: { franchise: true, ...CUSTOM_ROLE_INCLUDE }
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
    customRoleId?: string;
  }, actingUserId?: string) {
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

      const customRoleId = (data.customRoleId && data.customRoleId.trim() !== '' && data.customRoleId !== 'undefined' && data.customRoleId !== 'null')
        ? data.customRoleId
        : null;
      if (customRoleId) {
        const role = await prisma.role.findUnique({ where: { id: customRoleId } });
        if (!role) throw new AppError('Assigned role not found', 400);
      }

      // 4. Create
      const created = await prisma.user.create({
        data: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          passwordHash,
          role: data.role || UserRole.FRANCHISE_ADMIN,
          franchiseId: franchiseId,
          branchId: branchId,
          customRoleId,
          is_active: true
        },
        include: { franchise: true, ...CUSTOM_ROLE_INCLUDE }
      });

      if (actingUserId) {
        await AuditService.log({
          userId: actingUserId,
          action: 'USER_CREATED',
          entityType: 'User',
          entityId: created.id,
          targetFranchiseId: franchiseId || undefined,
          details: { fullName: created.fullName, email: created.email, role: created.role, customRoleId },
        });
      }

      return created;
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

  static async update(id: string, data: any, actingUserId?: string) {
    try {
      const existingUser = await prisma.user.findUnique({ where: { id }, include: CUSTOM_ROLE_INCLUDE });
      if (!existingUser) throw new AppError('User not found', 404);

      const updateData = { ...data };
      if (updateData.franchiseId === '' || updateData.franchiseId === 'null' || updateData.franchiseId === 'undefined') {
        updateData.franchiseId = null;
      }
      if (updateData.branchId === '' || updateData.branchId === 'null' || updateData.branchId === 'undefined') {
        updateData.branchId = null;
      }
      if (updateData.customRoleId === '' || updateData.customRoleId === 'null' || updateData.customRoleId === 'undefined') {
        updateData.customRoleId = null;
      }
      if (updateData.customRoleId) {
        const role = await prisma.role.findUnique({ where: { id: updateData.customRoleId } });
        if (!role) throw new AppError('Assigned role not found', 400);
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

      const updated = await prisma.user.update({
        where: { id },
        data: updateData,
        include: { franchise: true, ...CUSTOM_ROLE_INCLUDE }
      });

      if (actingUserId) {
        const roleChanged = 'role' in updateData && updateData.role !== existingUser.role;
        const customRoleChanged = 'customRoleId' in updateData && updateData.customRoleId !== existingUser.customRoleId;
        if (roleChanged || customRoleChanged) {
          await AuditService.log({
            userId: actingUserId,
            action: 'USER_ROLE_CHANGED',
            entityType: 'User',
            entityId: id,
            targetFranchiseId: updated.franchiseId || undefined,
            details: {
              from: { role: existingUser.role, customRole: existingUser.customRole?.name || null },
              to: { role: updated.role, customRole: updated.customRole?.name || null },
            },
          });
        } else {
          await AuditService.log({
            userId: actingUserId,
            action: 'USER_UPDATED',
            entityType: 'User',
            entityId: id,
            targetFranchiseId: updated.franchiseId || undefined,
            details: { fields: Object.keys(updateData) },
          });
        }
      }

      return updated;
    } catch (error) {
      console.error('[UserService.update] Detailed Error:', error);
      throw error;
    }
  }

  static async delete(id: string, actingUserId?: string) {
    const existing = await prisma.user.findUnique({ where: { id } });
    const deleted = await prisma.user.delete({ where: { id } });
    if (actingUserId && existing) {
      await AuditService.log({
        userId: actingUserId,
        action: 'USER_DELETED',
        entityType: 'User',
        entityId: id,
        targetFranchiseId: existing.franchiseId || undefined,
        details: { fullName: existing.fullName, email: existing.email },
      });
    }
    return deleted;
  }
}
