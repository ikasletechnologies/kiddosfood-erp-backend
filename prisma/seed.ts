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

  // 2.5 Warehouses
  const warehouses = [
    { name: 'Central Warehouse', location: 'Industrial Area, Mumbai', type: 'MAIN' },
    { name: 'Cold Storage Unit', location: 'Logistics Park, Navi Mumbai', type: 'COLD' },
    { name: 'Production Unit A', location: 'Sector 5, Thane', type: 'PRODUCTION' },
  ];

  for (const w of warehouses) {
    await prisma.warehouse.upsert({
      where: { id: `w-${w.name.toLowerCase().replace(/\s+/g, '-')}` },
      update: { location: w.location, type: w.type },
      create: {
        id: `w-${w.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: w.name,
        location: w.location,
        type: w.type
      }
    });
  }

  // 3. Default Users
  const password = await bcrypt.hash('admin123', 10);

  // HQ Admin
  await prisma.user.upsert({
    where: { email: 'admin@kiddosfood.com' },
    update: { 
      passwordHash: password, 
      role: 'SUPER_ADMIN', 
      franchiseId: hq.id 
    },
    create: {
      email: 'admin@kiddosfood.com',
      passwordHash: password,
      fullName: 'HQ Super Admin',
      role: 'SUPER_ADMIN',
      franchiseId: hq.id,
      is_active: true,
    },
  });

  // Downtown Franchise Admin
  await prisma.user.upsert({
    where: { email: 'franchise@erp.com' },
    update: { 
      passwordHash: password, 
      role: 'FRANCHISE_ADMIN', 
      franchiseId: 'fran-downtown' 
    },
    create: {
      email: 'franchise@erp.com',
      passwordHash: password,
      fullName: 'Downtown Manager',
      role: 'FRANCHISE_ADMIN',
      franchiseId: 'fran-downtown',
      is_active: true,
    },
  });

  // 4. Seeding Financial Accounts for Isolation
  console.log('💰 Seeding Financial Accounts...');
  
  // HQ Accounts (Global)
  await prisma.account.upsert({
    where: { accountCode: 'ACC-001' },
    update: { balance: 1000000 },
    create: {
      id: 'ebd81368-66e8-4de8-b6ca-a672a82c61f4',
      name: 'HQ Cash Account',
      accountCode: 'ACC-001',
      type: 'CASH',
      balance: 1000000,
      franchiseId: null
    }
  });

  await prisma.account.upsert({
    where: { accountCode: 'ACC-002' },
    update: { balance: 5000000 },
    create: {
      name: 'HQ Bank Account',
      accountCode: 'ACC-002',
      type: 'BANK',
      balance: 5000000,
      franchiseId: null
    }
  });

  await prisma.account.upsert({
    where: { accountCode: 'ACC-003' },
    update: { balance: 200000 },
    create: {
      name: 'HQ UPI Account',
      accountCode: 'ACC-003',
      type: 'UPI',
      balance: 200000,
      franchiseId: null
    }
  });

  // fran-downtown Accounts
  await prisma.account.upsert({
    where: { accountCode: 'ACC-D01' },
    update: { balance: 25000 },
    create: {
      name: 'Downtown Cash Account',
      accountCode: 'ACC-D01',
      type: 'CASH',
      balance: 25000,
      franchiseId: 'fran-downtown'
    }
  });

  await prisma.account.upsert({
    where: { accountCode: 'ACC-D02' },
    update: { balance: 120000 },
    create: {
      name: 'Downtown Bank Account',
      accountCode: 'ACC-D02',
      type: 'BANK',
      balance: 120000,
      franchiseId: 'fran-downtown'
    }
  });

  await prisma.account.upsert({
    where: { accountCode: 'ACC-D03' },
    update: { balance: 15000 },
    create: {
      name: 'Downtown UPI Account',
      accountCode: 'ACC-D03',
      type: 'UPI',
      balance: 15000,
      franchiseId: 'fran-downtown'
    }
  });

  console.log('✅ Seeding complete: Standardized 2-Level Hierarchy Established.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
