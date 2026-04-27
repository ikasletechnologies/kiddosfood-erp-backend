import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Seeding ERP database...');

  // ─── Franchises ───────────────────────────────────────────────────────────
  const hq = await prisma.franchise.upsert({
    where: { id: 'hq-001' },
    update: {},
    create: {
      id: 'hq-001',
      name: 'Kiddos Food Headquarters',
      location: 'Corporate Office',
      ownerName: 'Super Admin',
      contactNum: '9999999999',
      status: 'ACTIVE',
    },
  });

  const branch1 = await prisma.franchise.upsert({
    where: { id: 'branch-001' },
    update: {},
    create: {
      id: 'branch-001',
      name: 'Kiddos Food - Jaipur Branch',
      location: 'Jaipur, Rajasthan',
      ownerName: 'Franchise Owner',
      contactNum: '8888888888',
      status: 'ACTIVE',
    },
  });

  // ─── Permissions ──────────────────────────────────────────────────────────
  const permKeys = [
    '*',
    'crm:view', 'crm:manage',
    'sales:view', 'sales:manage',
    'purchase:view', 'purchase:manage',
    'inventory:view', 'inventory:manage',
    'accounts:view', 'accounts:manage',
    'hr:view', 'hr:manage',
    'service:view', 'service:manage',
    'pos:access',
    'franchise:view', 'franchise:manage',
    'production:view', 'production:manage',
    'orders:view', 'orders:manage',
  ];

  await Promise.all(
    permKeys.map(key =>
      prisma.permission.upsert({ where: { key }, update: {}, create: { key } })
    )
  );

  // ─── Roles ────────────────────────────────────────────────────────────────
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: {
      name: 'SUPER_ADMIN',
      description: 'Full access across all modules and franchises.',
      permissions: { create: { permission: { connect: { key: '*' } } } },
    },
  });

  const franchiseAdminRole = await prisma.role.upsert({
    where: { name: 'FRANCHISE_ADMIN' },
    update: {},
    create: {
      name: 'FRANCHISE_ADMIN',
      description: 'Franchise admin — products, orders, stock view only.',
      permissions: {
        create: [
          { permission: { connect: { key: 'inventory:view' } } },
          { permission: { connect: { key: 'production:view' } } },
          { permission: { connect: { key: 'production:manage' } } },
          { permission: { connect: { key: 'orders:view' } } },
          { permission: { connect: { key: 'orders:manage' } } },
          { permission: { connect: { key: 'pos:access' } } },
          { permission: { connect: { key: 'sales:view' } } },
        ],
      },
    },
  });

  // ─── Users ────────────────────────────────────────────────────────────────
  const superAdminPwd = await bcrypt.hash('admin123', 10);
  const franchisePwd  = await bcrypt.hash('franchise123', 10);

  await prisma.user.upsert({
    where: { email: 'admin@erp.com' },
    update: { passwordHash: superAdminPwd, roleId: superAdminRole.id, franchiseId: hq.id },
    create: {
      fullName: 'Super Admin',
      email: 'admin@erp.com',
      passwordHash: superAdminPwd,
      roleId: superAdminRole.id,
      franchiseId: hq.id,
      is_active: true,
    },
  });

  await prisma.user.upsert({
    where: { email: 'franchise@erp.com' },
    update: { passwordHash: franchisePwd, roleId: franchiseAdminRole.id, franchiseId: branch1.id },
    create: {
      fullName: 'Franchise Admin',
      email: 'franchise@erp.com',
      passwordHash: franchisePwd,
      roleId: franchiseAdminRole.id,
      franchiseId: branch1.id,
      is_active: true,
    },
  });

  // ─── Sample Products ──────────────────────────────────────────────────────
  const products = [
    { name: 'Idli Batter', sku: 'PRD-BATTER-001', basePrice: 80,  productType: 'MADE_TO_ORDER' as const, hsnCode: '1905', isVeg: true, emoji: '🥣' },
    { name: 'Dosa Batter', sku: 'PRD-BATTER-002', basePrice: 90,  productType: 'MADE_TO_ORDER' as const, hsnCode: '1905', isVeg: true, emoji: '🥞' },
    { name: 'Vada',        sku: 'PRD-VADA-001',   basePrice: 60,  productType: 'FINISHED_GOOD' as const, hsnCode: '1905', isVeg: true, emoji: '🍩' },
    { name: 'Sambar',      sku: 'PRD-SAMBAR-001', basePrice: 40,  productType: 'MADE_TO_ORDER' as const, hsnCode: '2104', isVeg: true, emoji: '🍲' },
    { name: 'Chutney',     sku: 'PRD-CHUTNEY-001',basePrice: 20,  productType: 'FINISHED_GOOD' as const, hsnCode: '2103', isVeg: true, emoji: '🥫' },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { sku: p.sku },
      update: { productType: p.productType, hsnCode: p.hsnCode },
      create: { ...p, taxPercent: 5, isActive: true, is_menu_item: true },
    });
  }

  // ─── Sample Raw Materials (HQ) ────────────────────────────────────────────
  const rawMaterials = [
    { name: 'Urad Dal',      sku: 'RM-URAD-001',    unit: 'kg',  openingStock: 100, minimumStock: 50  },
    { name: 'Rice',          sku: 'RM-RICE-001',    unit: 'kg',  openingStock: 200, minimumStock: 100 },
    { name: 'Toor Dal',      sku: 'RM-TOOR-001',    unit: 'kg',  openingStock: 60,  minimumStock: 30  },
    { name: 'Mustard Seeds', sku: 'RM-MUSTARD-001', unit: 'kg',  openingStock: 20,  minimumStock: 10  },
    { name: 'Coconut',       sku: 'RM-COCONUT-001', unit: 'pcs', openingStock: 40,  minimumStock: 20  },
  ];

  for (const rm of rawMaterials) {
    const existing = await prisma.inventoryItem.findFirst({ where: { sku: rm.sku, franchiseId: hq.id } });
    if (!existing) {
      const item = await prisma.inventoryItem.create({
        data: {
          name: rm.name, sku: rm.sku, unit: rm.unit,
          category: 'RAW_MATERIAL',
          currentStock: rm.openingStock,
          minimumStock: rm.minimumStock,
          franchiseId: hq.id,
          gstRate: 5,
        },
      });
      await prisma.stockMovement.create({
        data: {
          itemId: item.id,
          movementType: 'ADJUSTMENT',
          quantity: rm.openingStock,
          referenceType: 'ADJUSTMENT',
          note: 'Opening stock balance',
        },
      });
    }
  }

  // ─── Sample Vendor ────────────────────────────────────────────────────────
  await prisma.vendor.upsert({
    where: { id: 'vendor-001' },
    update: {},
    create: {
      id: 'vendor-001',
      name: 'Fresh Farm Supplies',
      contact: '9876543210',
      email: 'supplier@freshfarm.com',
      address: 'Jaipur, Rajasthan',
    },
  });

  console.log('');
  console.log('✅ Database seeded successfully.');
  console.log('   SUPER_ADMIN     : admin@erp.com      / admin123');
  console.log('   FRANCHISE_ADMIN : franchise@erp.com  / franchise123');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
