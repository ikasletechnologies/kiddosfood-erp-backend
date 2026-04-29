import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Starting fresh database seeding...');

  // 1. Root Headquarters franchise
  const rootFranchise = await prisma.franchise.upsert({
    where: { id: 'hq-001' },
    update: {},
    create: {
      id: 'hq-001',
      name: 'Kiddos Food Headquarters',
      location: 'Corporate Office, Mumbai',
      ownerName: 'Super Admin',
      contactNum: '9999999999',
      status: 'ACTIVE',
    },
  });

  // 2. Core permissions
  const permissionKeys = [
    '*',
    'crm:view', 'crm:manage',
    'sales:view', 'sales:manage',
    'purchase:view', 'purchase:manage',
    'inventory:view', 'inventory:manage',
    'accounts:view', 'accounts:manage',
    'hr:view', 'hr:manage',
    'service:view', 'service:manage',
    'pos:access',
  ];

  await Promise.all(
    permissionKeys.map(key =>
      prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key },
      })
    )
  );

  // 3. Roles — SUPER_ADMIN (home/HQ), ADMIN (franchise admin), STAFF
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: {
      name: 'SUPER_ADMIN',
      description: 'Full access across all franchises and modules.',
      permissions: {
        create: { permission: { connect: { key: '*' } } },
      },
    },
  });

  await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: {
      name: 'ADMIN',
      description: 'Franchise admin — manages one franchise.',
      permissions: {
        create: [
          { permission: { connect: { key: 'crm:manage' } } },
          { permission: { connect: { key: 'sales:manage' } } },
          { permission: { connect: { key: 'inventory:manage' } } },
          { permission: { connect: { key: 'hr:manage' } } },
          { permission: { connect: { key: 'accounts:manage' } } },
          { permission: { connect: { key: 'purchase:manage' } } },
          { permission: { connect: { key: 'pos:access' } } },
        ],
      },
    },
  });

  await prisma.role.upsert({
    where: { name: 'STAFF' },
    update: {},
    create: {
      name: 'STAFF',
      description: 'Restricted operational access.',
      permissions: {
        create: [
          { permission: { connect: { key: 'pos:access' } } },
          { permission: { connect: { key: 'inventory:view' } } },
          { permission: { connect: { key: 'sales:view' } } },
        ],
      },
    },
  });

  // 4. Super admin user
  const defaultPassword = await bcrypt.hash('admin123', 10);

  await prisma.user.upsert({
    where: { email: 'admin@kiddosfood.com' },
    update: {
      passwordHash: defaultPassword,
      fullName: 'Super Admin',
      roleId: superAdminRole.id,
      franchiseId: rootFranchise.id,
    },
    create: {
      email: 'admin@kiddosfood.com',
      passwordHash: defaultPassword,
      fullName: 'Super Admin',
      roleId: superAdminRole.id,
      franchiseId: rootFranchise.id,
      is_active: true,
    },
  });

  console.log('✅ Seeding complete.');
  console.log('   Super Admin: admin@kiddosfood.com / admin123');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
