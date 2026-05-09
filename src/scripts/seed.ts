import dotenv from 'dotenv';
dotenv.config();

import prisma from '../lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Starting Database Seeding...');

  // 1. Create Permissions
  const permissionsData = [
    { key: 'manage_users' },
    { key: 'approve_stock' },
    { key: 'create_bill' },
    { key: 'view_reports' },
    { key: 'manage_franchise' },
  ];

  for (const p of permissionsData) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: {},
      create: p,
    });
  }
  console.log('✅ Permissions created');

  // 2. Create Roles
  const roles = ['SUPER_ADMIN', 'FRANCHISE_ADMIN'];
  const createdRoles: any = {};

  for (const roleName of roles) {
    createdRoles[roleName] = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName, description: `${roleName} role` },
    });
  }
  console.log('✅ Roles created');

  // 3. Link Permissions
  const allPermissions = await prisma.permission.findMany();
  for (const p of allPermissions) {
    // Super Admin gets everything
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: createdRoles['SUPER_ADMIN'].id, permissionId: p.id } },
      update: {},
      create: { roleId: createdRoles['SUPER_ADMIN'].id, permissionId: p.id },
    });

    // Franchise Admin gets most things except high-level governance
    if (p.key !== 'manage_users' && p.key !== 'manage_franchise') {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: createdRoles['FRANCHISE_ADMIN'].id, permissionId: p.id } },
        update: {},
        create: { roleId: createdRoles['FRANCHISE_ADMIN'].id, permissionId: p.id },
      });
    }
  }
  console.log('✅ Role permissions linked');

  // 4. Create Default Admin User
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email: 'admin@fooderp.com' },
    update: {},
    create: {
      fullName: 'System Admin',
      email: 'admin@fooderp.com',
      phone: '0000000000',
      passwordHash: hashedPassword,
      roleId: createdRoles['SUPER_ADMIN'].id,
      is_active: true,
    },
  });
  console.log('✅ Default Admin user created (admin@fooderp.com / admin123)');

  console.log('🚀 Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
