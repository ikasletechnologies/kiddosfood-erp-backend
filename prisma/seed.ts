import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Starting Clean Enterprise Seeding...');

  // 1. Root Headquarters (The Parent)
  const hq = await prisma.franchise.upsert({
    where: { id: 'hq-001' },
    update: {
      name: 'Kiddos Food Headquarters',
      location: 'Main Warehouse & Office, Mumbai',
      status: 'ACTIVE',
    },
    create: {
      id: 'hq-001',
      name: 'Kiddos Food Headquarters',
      location: 'Main Warehouse & Office, Mumbai',
      ownerName: 'Super Admin',
      contactNum: '9999999999',
      status: 'ACTIVE',
    },
  });

  // 2. Operational Franchises (The Children)
  const branches = [
    { id: 'fran-downtown', name: 'Downtown Outlet', location: 'Main Street' },
    { id: 'fran-airport', name: 'Airport Food Court', location: 'International Airport' },
    { id: 'fran-cbe', name: 'Coimbatore Branch', location: 'Cross Cut Road' },
  ];

  for (const b of branches) {
    await prisma.franchise.upsert({
      where: { id: b.id },
      update: { name: b.name, location: b.location },
      create: {
        id: b.id,
        name: b.name,
        location: b.location,
        ownerName: 'Branch Manager',
        contactNum: '8888888888',
        status: 'ACTIVE',
        creditLimit: 50000,
        outstandingAmount: 0,
      }
    });
  }

  // 3. Core Permissions
  const permissionKeys = [
    '*', 'crm:manage', 'sales:manage', 'inventory:manage', 'accounts:manage', 'purchase:manage', 'pos:access'
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

  // 4. Standard Roles
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: {
      name: 'SUPER_ADMIN',
      description: 'Master control (HQ)',
      permissions: { create: { permission: { connect: { key: '*' } } } },
    },
  });

  const franchiseAdminRole = await prisma.role.upsert({
    where: { name: 'FRANCHISE_ADMIN' },
    update: {},
    create: {
      name: 'FRANCHISE_ADMIN',
      description: 'Operational branch admin',
      permissions: {
        create: [
          { permission: { connect: { key: 'sales:manage' } } },
          { permission: { connect: { key: 'inventory:manage' } } },
          { permission: { connect: { key: 'pos:access' } } },
        ]
      },
    },
  });

  // 5. Default Users
  const password = await bcrypt.hash('admin123', 10);

  // HQ Admin
  await prisma.user.upsert({
    where: { email: 'admin@kiddosfood.com' },
    update: { passwordHash: password, roleId: superAdminRole.id, franchiseId: hq.id },
    create: {
      email: 'admin@kiddosfood.com',
      passwordHash: password,
      fullName: 'HQ Super Admin',
      roleId: superAdminRole.id,
      franchiseId: hq.id,
      is_active: true,
    },
  });

  // Downtown Franchise Admin
  await prisma.user.upsert({
    where: { email: 'franchise@erp.com' },
    update: { passwordHash: password, roleId: franchiseAdminRole.id, franchiseId: 'fran-downtown' },
    create: {
      email: 'franchise@erp.com',
      passwordHash: password,
      fullName: 'Downtown Manager',
      roleId: franchiseAdminRole.id,
      franchiseId: 'fran-downtown',
      is_active: true,
    },
  });

  console.log('✅ Seeding complete: Standardized 2-Level Hierarchy Established.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
