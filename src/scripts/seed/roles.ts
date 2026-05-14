import prisma from '../../lib/prisma';

export async function seedRoles() {
  console.log('🔑 Seeding Permissions and Roles...');
  const permissionsData = [
    { key: 'manage_users' },
    { key: 'approve_stock' },
    { key: 'create_bill' },
    { key: 'view_reports' },
    { key: 'manage_franchise' },
    { key: 'manage_inventory' },
    { key: 'manage_production' },
  ];

  for (const p of permissionsData) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: {},
      create: p,
    });
  }

  const roles = ['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'BRANCH_MANAGER'];
  const roleMap: Record<string, any> = {};

  for (const roleName of roles) {
    roleMap[roleName] = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName, description: `${roleName} role` },
    });
  }

  // Link Permissions
  const allPerms = await prisma.permission.findMany();
  for (const p of allPerms) {
    // Super Admin gets everything
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: roleMap['SUPER_ADMIN'].id, permissionId: p.id } },
      update: {},
      create: { roleId: roleMap['SUPER_ADMIN'].id, permissionId: p.id },
    });

    // Franchise Admin gets most
    if (p.key !== 'manage_users' && p.key !== 'manage_franchise') {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: roleMap['FRANCHISE_ADMIN'].id, permissionId: p.id } },
        update: {},
        create: { roleId: roleMap['FRANCHISE_ADMIN'].id, permissionId: p.id },
      });
    }
  }
  console.log('✅ Permissions and Roles synchronized');
  return roleMap;
}
