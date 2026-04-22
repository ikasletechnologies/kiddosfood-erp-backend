import prisma from '../../lib/prisma';

export class RoleService {
  static async getRoles() {
    return prisma.role.findMany({
      orderBy: { name: 'asc' }
    });
  }

  static async getRoleById(id: string) {
    return prisma.role.findUnique({
      where: { id }
    });
  }

  static async createRole(data: any) {
    return prisma.role.create({
      data: {
        name: data.name,
        description: data.description,
        permissions: data.permissions || []
      }
    });
  }

  static async updateRole(id: string, data: any) {
    return prisma.role.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        permissions: data.permissions
      }
    });
  }

  static async deleteRole(id: string) {
    return prisma.role.delete({
      where: { id }
    });
  }
}
