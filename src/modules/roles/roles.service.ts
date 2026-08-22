import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { AuditService } from '../audit/audit.service';

export class RolesService {
  static async getAll() {
    const roles = await prisma.role.findMany({
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.users,
      permissions: r.permissions.map((rp) => rp.permission),
    }));
  }

  static async getOne(id: string) {
    const role = await prisma.role.findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } }, _count: { select: { users: true } } },
    });
    if (!role) return null;
    return {
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      userCount: role._count.users,
      permissions: role.permissions.map((rp) => rp.permission),
    };
  }

  static async create(
    data: { name: string; description?: string; permissionIds?: string[] },
    actingUserId: string
  ) {
    const name = data.name?.trim();
    if (!name) throw new AppError('Role name is required', 400);

    const existing = await prisma.role.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) throw new AppError('A role with this name already exists', 400);

    const role = await prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: { name, description: data.description, isSystem: false },
      });
      if (data.permissionIds?.length) {
        await tx.rolePermission.createMany({
          data: data.permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })),
          skipDuplicates: true,
        });
      }
      return created;
    });

    await AuditService.log({
      userId: actingUserId,
      action: 'ROLE_CREATED',
      entityType: 'Role',
      entityId: role.id,
      details: { name: role.name, permissionIds: data.permissionIds || [] },
    });

    return this.getOne(role.id);
  }

  static async update(
    id: string,
    data: { name?: string; description?: string; permissionIds?: string[] },
    actingUserId: string
  ) {
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw new AppError('Role not found', 404);

    const updateData: { name?: string; description?: string } = {};

    if (data.name !== undefined && data.name.trim() !== role.name) {
      if (role.isSystem) throw new AppError('System roles cannot be renamed', 400);
      const trimmed = data.name.trim();
      if (!trimmed) throw new AppError('Role name is required', 400);
      const existing = await prisma.role.findFirst({
        where: { name: { equals: trimmed, mode: 'insensitive' }, id: { not: id } },
      });
      if (existing) throw new AppError('A role with this name already exists', 400);
      updateData.name = trimmed;
    }

    if (data.description !== undefined) updateData.description = data.description;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length) {
        await tx.role.update({ where: { id }, data: updateData });
      }
      if (data.permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (data.permissionIds.length) {
          await tx.rolePermission.createMany({
            data: data.permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
            skipDuplicates: true,
          });
        }
      }
    });

    await AuditService.log({
      userId: actingUserId,
      action: 'ROLE_UPDATED',
      entityType: 'Role',
      entityId: id,
      details: { name: updateData.name || role.name, permissionIds: data.permissionIds },
    });

    return this.getOne(id);
  }

  static async delete(id: string, actingUserId: string) {
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new AppError('Role not found', 404);
    if (role.isSystem) throw new AppError('System roles cannot be deleted', 400);
    if (role._count.users > 0) {
      throw new AppError(
        `Cannot delete role: ${role._count.users} user(s) are assigned to it. Reassign them first.`,
        400
      );
    }

    await prisma.role.delete({ where: { id } });

    await AuditService.log({
      userId: actingUserId,
      action: 'ROLE_DELETED',
      entityType: 'Role',
      entityId: id,
      details: { name: role.name },
    });
  }
}
