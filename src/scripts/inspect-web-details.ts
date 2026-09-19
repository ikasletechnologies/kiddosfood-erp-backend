import prisma from '../lib/prisma';

async function main() {
  const inv = await prisma.inventoryItem.findFirst({
    where: { sku: 'FG-WEB-1G' }
  });
  console.log('Inventory item for FG-WEB-1G:', inv);

  const prod = await prisma.product.findFirst({
    where: { sku: 'FG-WEB-1G' }
  });
  console.log('Product for FG-WEB-1G:', prod);

  const recipe = await prisma.recipe.findFirst({
    where: { name: { contains: 'web', mode: 'insensitive' } }
  });
  console.log('Recipe web:', recipe);
}

main().catch(console.error).finally(() => prisma.$disconnect());
