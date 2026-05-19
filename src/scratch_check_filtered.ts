import prisma from './lib/prisma';

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      category: {
        in: ['RAW_MATERIAL', 'PACKAGING']
      }
    },
    orderBy: { name: 'asc' }
  });
  console.log('--- RAW MATERIALS IN DB ---');
  console.log(JSON.stringify(items, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
