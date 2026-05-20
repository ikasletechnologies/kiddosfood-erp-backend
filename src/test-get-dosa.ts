import prisma from './lib/prisma';

async function main() {
  const products = await prisma.product.findMany({
    where: { name: { contains: 'dosa', mode: 'insensitive' } }
  });
  console.log('PRODUCTS:', JSON.stringify(products, null, 2));

  const items = await prisma.inventoryItem.findMany({
    where: { name: { contains: 'dosa', mode: 'insensitive' } }
  });
  console.log('INVENTORY ITEMS:', JSON.stringify(items, null, 2));
}

main().catch(console.error).finally(() => process.exit(0));
