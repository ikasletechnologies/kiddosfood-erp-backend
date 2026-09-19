import prisma from '../lib/prisma';

async function main() {
  const p = await prisma.product.findUnique({ where: { id: 'e8adabc4-29d4-40d3-9570-051a62ccf4ed' } });
  console.log('Product:', p);
  const invItem = await prisma.inventoryItem.findUnique({ where: { id: 'c6836d71-9230-4fda-a4a4-b87007898215' } });
  console.log('InventoryItem:', invItem);
  const batches = await prisma.inventoryBatch.findMany({ where: { inventoryItemId: 'c6836d71-9230-4fda-a4a4-b87007898215' } });
  console.log('Batches:', batches);
}

main().catch(console.error).finally(() => prisma.$disconnect());
