import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({ select: { id: true, name: true, sku: true } });
  const inventory = await prisma.inventoryItem.findMany({ select: { id: true, name: true, sku: true, currentStock: true, franchiseId: true } });

  console.log('--- PRODUCTS ---');
  console.table(products);
  console.log('--- INVENTORY ITEMS ---');
  console.table(inventory);
}

main().finally(() => prisma.$disconnect());
