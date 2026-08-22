import prisma from '../lib/prisma';

export class PermissionUtil {
  /**
   * Always re-reads the acting user's custom role + permissions from the DB
   * rather than trusting the (possibly stale, up to 15min) JWT payload — a
   * revoked/changed permission then takes effect immediately instead of
   * waiting out the access-token lifetime.
   */
  static async getEffectivePermissions(userId: string): Promise<{ customRoleId: string | null; customRoleName: string | null; permissions: string[] }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { customRole: { include: { permissions: { include: { permission: true } } } } },
    });
    if (!user || !user.customRole) {
      return { customRoleId: null, customRoleName: null, permissions: [] };
    }
    return {
      customRoleId: user.customRole.id,
      customRoleName: user.customRole.name,
      permissions: user.customRole.permissions.map((rp) => rp.permission.key),
    };
  }
}
