import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Starting database seeding with explicit Material-Vendor links...');

  // 1. Franchises
  const jaipurBranch = await prisma.franchise.upsert({
    where: { id: 'branch-001' },
    update: {},
    create: {
      id: 'branch-001',
      name: 'Kiddos Food - Jaipur Branch',
      location: 'Malviya Nagar, Jaipur',
      ownerName: 'Branch Manager',
      contactNum: '8888888888',
    },
  });

  // 2. Roles & Users (Minimal for seeding)
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'SUPER_ADMIN' },
    update: {},
    create: { name: 'SUPER_ADMIN', description: 'Full access.' },
  });
  const defaultPassword = await bcrypt.hash('admin123', 10);
  await prisma.user.upsert({
    where: { email: 'admin@kiddosfood.com' },
    update: {},
    create: {
      email: 'admin@kiddosfood.com',
      fullName: 'Kiddos Admin',
      passwordHash: defaultPassword,
      roleId: superAdminRole.id,
      is_active: true,
    },
  });

  // 3. Vendors
  const vendorsData = [
    { id: 'v-dairy-01', name: 'Jaipur Fresh Dairy', contact: '9911111111', email: 'sales@jaipurfresh.com' },
    { id: 'v-dairy-02', name: 'Modern Milk Co', contact: '9911111122', email: 'info@modernmilk.com' },
    { id: 'v-grain-01', name: 'National Grains', contact: '9922222211', email: 'orders@nationalgrains.com' },
    { id: 'v-grain-02', name: 'Organic Harvest', contact: '9922222222', email: 'hello@organicharvest.com' },
  ];

  for (const v of vendorsData) {
    await prisma.vendor.upsert({
      where: { id: v.id },
      update: { name: v.name, contact: v.contact, email: v.email },
      create: v,
    });
  }

  // 4. Materials (Inventory Items)
  const materialsData = [
    { name: 'Fresh Milk', sku: 'RM-MLK-001', category: 'RAW_MATERIAL' as const, unit: 'ltr' },
    { name: 'Organic Flour', sku: 'RM-FLR-001', category: 'RAW_MATERIAL' as const, unit: 'kg' },
    { name: 'Granulated Sugar', sku: 'RM-SGR-001', category: 'RAW_MATERIAL' as const, unit: 'kg' },
  ];

  const inventoryItems: Record<string, any> = {};
  for (const m of materialsData) {
    inventoryItems[m.sku] = await prisma.inventoryItem.upsert({
      where: { sku_franchiseId: { sku: m.sku, franchiseId: jaipurBranch.id } },
      update: {},
      create: {
        ...m,
        currentStock: 100,
        franchiseId: jaipurBranch.id,
      },
    });
  }

  // 5. Material-Vendor Links (VendorMaterial) - THE "MATERIAL LINK"
  console.log('🔗 Seeding Vendor-Material links (Multiple vendors per material)...');
  const links = [
    // Milk supplied by two vendors
    { vendorId: 'v-dairy-01', materialId: inventoryItems['RM-MLK-001'].id, price: 42 },
    { vendorId: 'v-dairy-02', materialId: inventoryItems['RM-MLK-001'].id, price: 45 },
    
    // Flour supplied by two vendors
    { vendorId: 'v-grain-01', materialId: inventoryItems['RM-FLR-001'].id, price: 35 },
    { vendorId: 'v-grain-02', materialId: inventoryItems['RM-FLR-001'].id, price: 55 }, // Premium organic price
    
    // Sugar supplied by one vendor
    { vendorId: 'v-grain-01', materialId: inventoryItems['RM-SGR-001'].id, price: 40 },
  ];

  for (const link of links) {
    await prisma.vendorMaterial.upsert({
      where: {
        vendorId_materialId: {
          vendorId: link.vendorId,
          materialId: link.materialId,
        }
      },
      update: { price: link.price, lastUpdated: new Date() },
      create: {
        vendorId: link.vendorId,
        materialId: link.materialId,
        price: link.price,
      }
    });
  }

  // 6. Procurement Order using the link
  console.log('📝 Seeding Procurement Order based on material links...');
  await prisma.procurementOrder.create({
    data: {
      vendorId: 'v-dairy-01',
      status: 'APPROVED',
      totalAmount: 4200,
      paid: 0,
      notes: 'Order placed at link price of 42/ltr',
      poItems: {
        create: [
          {
            inventoryItemId: inventoryItems['RM-MLK-001'].id,
            quantity: 100,
            price: 42, // Matches the link price
            total: 4200,
            subtotal: 4200,
          }
        ]
      }
    }
  });

  console.log('✅ Material links (VendorMaterial) seeded successfully.');
  console.log('   Now you can see which vendors supply which materials and at what price.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
