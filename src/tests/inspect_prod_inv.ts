import prisma from '../lib/prisma';

async function run() {
  const prod = await prisma.product.findUnique({
    where: { id: 'e8adabc4-29d4-40d3-9570-051a62ccf4ed' }
  });
  console.log('=== Product e8adabc4-29d4-40d3-9570-051a62ccf4ed ===');
  console.log(prod);

  if (prod?.sku) {
    const invItems = await prisma.inventoryItem.findMany({
      where: { sku: prod.sku }
    });
    console.log('=== InventoryItems with SKU', prod.sku, '===');
    console.log(invItems);
  }
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
