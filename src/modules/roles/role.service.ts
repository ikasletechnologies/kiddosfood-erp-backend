import { UserRole } from '@prisma/client';

export class RoleService {
  static async getRoles() {
    return Object.values(UserRole).map(role => ({
      id: role,
      name: role,
      description: `${role} system role`
    }));
  }

  static async getRoleById(id: string) {
    if (Object.values(UserRole).includes(id as any)) {
      return {
        id,
        name: id,
        description: `${id} system role`
      };
    }
    return null;
  }

  static async createRole(data: any) {
    throw new Error('Dynamic roles are not supported in the current schema (using Enum-based RBAC)');
  }

  static async updateRole(id: string, data: any) {
    throw new Error('Dynamic roles are not supported in the current schema (using Enum-based RBAC)');
  }

  static async deleteRole(id: string) {
    throw new Error('Dynamic roles are not supported in the current schema (using Enum-based RBAC)');
  }
}
