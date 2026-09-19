import prisma from '../lib/prisma';

async function main() {
  const appamProducts = await prisma.product.findMany({
    where: { name: { contains: 'APPAM', mode: 'insensitive' } },
    select: { id: true, name: true, sku: true, category: true }
  });
  console.log('Appam products:', appamProducts);
}

main().catch(console.error).finally(() => prisma.$disconnect());
