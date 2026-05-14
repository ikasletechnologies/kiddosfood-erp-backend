import prisma from '../../lib/prisma';

export async function seedMasterData() {
  console.log('💰 Seeding Financial Accounts...');
  await prisma.account.upsert({
    where: { accountCode: 'CASH-001' },
    update: {},
    create: {
      name: 'Main Cash Account',
      accountCode: 'CASH-001',
      type: 'CASH',
      balance: 100000,
    }
  });

  console.log('🏭 Seeding Vendors...');
  const vendors = [
    { name: 'City Wholesale Traders', email: 'city@wholesale.com', contact: '1234567890', vendorCode: 'V-0001' },
    { name: 'Global Provisions', email: 'global@provisions.com', contact: '0987654321', vendorCode: 'V-0002' },
  ];

  for (const v of vendors) {
    await prisma.vendor.upsert({
      where: { vendorCode: v.vendorCode },
      update: v,
      create: { ...v, status: 'ACTIVE' },
    });
  }

  console.log('📦 Seeding Products and Recipes...');
  
  // Inventory Item (Batter)
  const material = await prisma.inventoryItem.upsert({
    where: { sku_franchiseId: { sku: 'BATTER-001', franchiseId: 'root-franchise' } },
    update: {},
    create: {
      name: 'Test Batter',
      sku: 'BATTER-001',
      category: 'RAW_MATERIAL',
      currentStock: 5000,
      unit: 'g',
      franchiseId: 'root-franchise',
    }
  });

  await prisma.inventoryItem.upsert({
    where: { sku_franchiseId: { sku: 'BATTER-001', franchiseId: 'distribution-branch' } },
    update: {},
    create: {
      name: 'Test Batter',
      sku: 'BATTER-001',
      category: 'RAW_MATERIAL',
      currentStock: 0,
      unit: 'g',
      franchiseId: 'distribution-branch',
    }
  });

  const product = await prisma.product.upsert({
    where: { sku: 'IDLI-001' },
    update: {},
    create: {
      name: 'Test Idli',
      sku: 'IDLI-001',
      basePrice: 50,
      isVeg: true,
      is_menu_item: true,
      productType: 'FINISHED_GOOD',
    }
  });

  await prisma.recipe.upsert({
    where: { productId: product.id },
    update: {},
    create: {
      productId: product.id,
      name: 'Idli Recipe',
      yieldQty: 1,
      instructions: 'Steam it for 10 minutes.',
      recipeItems: {
        create: {
          inventoryItemId: material.id,
          quantityRequired: 100,
          unit: 'g'
        }
      }
    }
  });

  console.log('🛒 Seeding Sample Customers...');
  await prisma.customer.upsert({
    where: { email: 'john@local.com' },
    update: {},
    create: {
      name: 'John Smith (Local)',
      phone: '1122334455',
      email: 'john@local.com',
      franchiseId: 'test-franchise-id'
    }
  });

  console.log('✅ Master data seeded');
}
