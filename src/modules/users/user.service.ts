import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';
import { AppError } from '../../middleware/error.middleware';
import { AuditService } from '../audit/audit.service';
import { UserRole } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit-log';

export const MIN_PASSWORD_LENGTH = 8;

export function assertStrongPassword(password: unknown) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
}

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
  }, actingUserId?: string) {
    try {
      // 1. Check if user exists
      const existing = await prisma.user.findUnique({ where: { email: data.email } });
      if (existing) throw new AppError('User with this email already exists', 400);

      // 2. Hash Password — no default password: a missing/short one used to
      // silently become 'admin123'.
      assertStrongPassword(data.password);
      const passwordHash = await AuthService.hashPassword(data.password!);

      // 3. Cleanup IDs
      const franchiseId = (data.franchiseId && data.franchiseId.trim() !== '' && data.franchiseId !== 'undefined' && data.franchiseId !== 'null')
        ? data.franchiseId
        : null;

      const branchId = (data.branchId && data.branchId.trim() !== '' && data.branchId !== 'undefined' && data.branchId !== 'null')
        ? data.branchId
        : null;

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
          is_active: true
        },
        include: { franchise: true }
      });

      if (actingUserId) {
        await AuditService.log({
          userId: actingUserId,
          action: 'USER_CREATED',
          entityType: 'User',
          entityId: created.id,
          targetFranchiseId: franchiseId || undefined,
          details: { fullName: created.fullName, email: created.email, role: created.role },
        });
      }

      return created;
    } catch (error) {
      console.error('[UserService.create] Detailed Error:', error);
      throw error;
    }
  }

  static async updatePassword(userId: string, newPassword: string) {
    assertStrongPassword(newPassword);
    const passwordHash = await AuthService.hashPassword(newPassword);
    return prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
      select: { id: true }
    });
  }

  /**
   * Admin password reset (PATCH /api/users/:id/reset-password).
   * Audit C-01 follow-up: the route is open to FRANCHISE_ADMIN, and previously
   * any franchise admin could reset ANY account's password — including a
   * SUPER_ADMIN's — which is a direct account takeover. Now:
   *  - SUPER_ADMIN may reset any account;
   *  - FRANCHISE_ADMIN may reset only FRANCHISE_ADMIN accounts of their own
   *    franchise (never a SUPER_ADMIN, never another franchise).
   */
  static async resetPasswordAsActor(targetUserId: string, newPassword: string, actor: { userId?: string; role?: string; franchiseId?: string | null }) {
    assertStrongPassword(newPassword);
    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { id: true, role: true, franchiseId: true } });
    if (!target) throw new AppError('User not found', 404);

    if (actor.role !== 'SUPER_ADMIN') {
      const sameFranchise = !!actor.franchiseId && target.franchiseId === actor.franchiseId;
      if (actor.role !== 'FRANCHISE_ADMIN' || target.role === 'SUPER_ADMIN' || !sameFranchise) {
        throw new AppError('Forbidden: you can only reset passwords of users in your own franchise', 403);
      }
    }

    const passwordHash = await AuthService.hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: targetUserId }, data: { passwordHash } });
      // Existing sessions of the target must not survive a reset.
      await tx.refreshToken.updateMany({ where: { userId: targetUserId, isRevoked: false }, data: { isRevoked: true } });
      await writeAuditLog(tx, {
        module: 'USER',
        action: 'PASSWORD_RESET',
        recordId: targetUserId,
        newValue: { targetRole: target.role, targetFranchiseId: target.franchiseId },
        actor
      });
    });
  }

  /** GET /api/franchise/:id/users — franchise admins may only list their own franchise. */
  static async getByFranchiseAsActor(franchiseId: string, actor: { role?: string; franchiseId?: string | null }) {
    if (actor.role !== 'SUPER_ADMIN' && actor.franchiseId !== franchiseId) {
      throw new AppError('Forbidden: you can only view users of your own franchise', 403);
    }
    return this.getByFranchise(franchiseId);
  }

  static async update(id: string, data: any, actingUserId?: string) {
    try {
      const existingUser = await prisma.user.findUnique({ where: { id } });
      if (!existingUser) throw new AppError('User not found', 404);

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

      const updated = await prisma.user.update({
        where: { id },
        data: updateData,
        include: { franchise: true }
      });

      if (actingUserId) {
        const roleChanged = 'role' in updateData && updateData.role !== existingUser.role;
        if (roleChanged) {
          await AuditService.log({
            userId: actingUserId,
            action: 'USER_ROLE_CHANGED',
            entityType: 'User',
            entityId: id,
            targetFranchiseId: updated.franchiseId || undefined,
            details: {
              from: { role: existingUser.role },
              to: { role: updated.role },
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
