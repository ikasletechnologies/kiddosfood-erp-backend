import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Starting fresh database seeding for New ERP Workflow...');

  // 1. Create Root Headquarters
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

  // 1.1 Create Initial Franchise Branch
  const firstBranch = await prisma.franchise.upsert({
    where: { id: 'branch-001' },
    update: {},
    create: {
      id: 'branch-001',
      name: 'Kiddos Food - Jaipur Branch',
      location: 'Jaipur, Rajasthan',
      ownerName: 'Branch Manager',
      contactNum: '8888888888',
      status: 'ACTIVE',
    },
  });

  // 2. Define Core Permissions
  const permissionKeys = [
    '*', // Full access
    'crm:view', 'crm:manage',
    'sales:view', 'sales:manage',
    'purchase:view', 'purchase:manage',
    'inventory:view', 'inventory:manage',
    'accounts:view', 'accounts:manage',
    'hr:view', 'hr:manage',
    'service:view', 'service:manage',
    'pos:access'
  ];

  await Promise.all(
    permissionKeys.map(key =>
      prisma.permission.upsert({
        where: { key },
        update: {},
        create: { key }
      })
    )
  );

  // 3. Create Roles Hierarchy
  await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: {
      name: 'SUPER_ADMIN',
      description: 'Super Admin - Full access across all franchises and modules.',
      permissions: {
        create: {
          permission: { connect: { key: '*' } }
        }
      }
    },
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: {},
    create: {
      name: 'ADMIN',
      description: 'Admin - High-level management access.',
      permissions: {
        create: [
          { permission: { connect: { key: 'crm:manage' } } },
          { permission: { connect: { key: 'sales:manage' } } },
          { permission: { connect: { key: 'inventory:manage' } } },
          { permission: { connect: { key: 'hr:manage' } } },
          { permission: { connect: { key: 'accounts:manage' } } },
          { permission: { connect: { key: 'pos:access' } } },
        ]
      }
    },
  });

  const managerRole = await prisma.role.upsert({
    where: { name: 'MANAGER' },
    update: {},
    create: {
      name: 'MANAGER',
      description: 'Manager - Operational branch management.',
      permissions: {
        create: [
          { permission: { connect: { key: 'sales:manage' } } },
          { permission: { connect: { key: 'inventory:manage' } } },
          { permission: { connect: { key: 'pos:access' } } },
          { permission: { connect: { key: 'crm:view' } } },
        ]
      }
    },
  });

  await prisma.role.upsert({
    where: { name: 'STAFF' },
    update: {},
    create: {
      name: 'STAFF',
      description: 'Staff - Restricted operational access.',
      permissions: {
        create: [
          { permission: { connect: { key: 'pos:access' } } },
          { permission: { connect: { key: 'inventory:view' } } },
          { permission: { connect: { key: 'sales:view' } } },
        ]
      }
    },
  });

  // 4. Create Users (Minimal)
  const defaultPassword = await bcrypt.hash('admin123', 10);

  const adminUsers = [
    { 
      email: 'admin@kiddosfood.com', 
      passwordHash: defaultPassword, 
      fullName: 'Kiddos Admin', 
      roleId: adminRole.id, 
      franchiseId: rootFranchise.id 
    },
    { 
      email: 'manager@kiddosfood.com', 
      passwordHash: defaultPassword, 
      fullName: 'Kiddos Branch Manager', 
      roleId: managerRole.id, 
      franchiseId: firstBranch.id 
    },
  ];

  for (const user of adminUsers) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        passwordHash: user.passwordHash,
        fullName: user.fullName,
        roleId: user.roleId,
        franchiseId: user.franchiseId
      },
      create: { ...user, is_active: true },
    });
  }

  // 5. Create Sample Vendors
  await prisma.vendor.create({
    data: { name: 'Fresh Farm Supplies', contact: '9988776655', email: 'supply@freshfarm.com' }
  });

  await prisma.vendor.create({
    data: { name: 'Global Packaging Ltd', contact: '8877665544', email: 'info@globalpack.com' }
  });

  // 6. Create Sample Inventory Items
  const items = [
    { name: 'Organic Wheat Flour', sku: 'RM-WHT-001', category: 'RAW_MATERIAL' as const, unit: 'kg', franchiseId: rootFranchise.id, minimumStock: 20, currentStock: 0 },
    { name: 'Refined Sugar', sku: 'RM-SGR-001', category: 'RAW_MATERIAL' as const, unit: 'kg', franchiseId: rootFranchise.id, minimumStock: 15, currentStock: 0 },
    { name: 'Eco-Friendly Box', sku: 'PK-BOX-001', category: 'PACKAGING' as const, unit: 'pc', franchiseId: rootFranchise.id, minimumStock: 100, currentStock: 0 },
  ];

  const createdItems = [];
  for (const item of items) {
    const invItem = await prisma.inventoryItem.create({ data: item });
    createdItems.push(invItem);
  }

  // 7. Create Sample Stock Movements (Today) to populate Inbound/Outbound
  // We add these to the admin user
  const admin = await prisma.user.findFirst({ where: { email: 'admin@kiddosfood.com' } });

  const movements = [
    // Inbound Movements (Purchases)
    { itemId: createdItems[0].id, quantity: 150, movementType: 'PURCHASE_IN' as const, note: 'Morning delivery', createdBy: admin?.id },
    { itemId: createdItems[1].id, quantity: 80, movementType: 'PURCHASE_IN' as const, note: 'Restock', createdBy: admin?.id },
    
    // Outbound Movements (Production/Sales)
    { itemId: createdItems[0].id, quantity: -45, movementType: 'PRODUCTION_OUT' as const, note: 'Batch #101 consumption', createdBy: admin?.id },
    { itemId: createdItems[2].id, quantity: -120, movementType: 'SALES_OUT' as const, note: 'Bulk order dispatch', createdBy: admin?.id },
  ];

  for (const move of movements) {
    await prisma.stockMovement.create({ data: move });
    // Update currentStock cache on the item
    await prisma.inventoryItem.update({
      where: { id: move.itemId },
      data: { currentStock: { increment: move.quantity } }
    });
  }

  console.log('✅ Kiddos Food ERP hierarchy and movement data seeded successfully.');
  console.log('   Admin: admin@kiddosfood.com / admin123');
  console.log('   Manager: manager@kiddosfood.com / admin123');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
