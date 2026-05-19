import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const hqItems = await prisma.inventoryItem.findMany({
    where: { franchiseId: 'hq-001' }
  });
  console.log('--- HQ Inventory Items ---');
  console.log(JSON.stringify(hqItems, null, 2));

  const products = await prisma.product.findMany();
  console.log('--- Products ---');
  console.log(JSON.stringify(products, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
