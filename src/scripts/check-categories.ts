import prisma from '../lib/prisma';

async function main() {
  const fgProducts = await prisma.product.findMany({
    where: { category: { in: ['FINISHED_GOOD', 'FINISHED_GOODS', 'RAW_MATERIAL', 'RAW_MATERIALS'] } },
    select: { id: true, name: true, sku: true, category: true }
  });
  console.log(`Products with enum-like category (${fgProducts.length}):`, fgProducts);

  const nullCatProducts = await prisma.product.findMany({
    where: { OR: [{ category: null }, { category: '' }] },
    select: { id: true, name: true, sku: true, category: true }
  });
  console.log(`Products with null/empty category (${nullCatProducts.length}):`, nullCatProducts);
}

main().catch(console.error).finally(() => prisma.$disconnect());
