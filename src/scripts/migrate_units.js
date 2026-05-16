const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Updating units for Finished Goods...');
  const result = await prisma.inventoryItem.updateMany({
    where: { category: 'FINISHED_GOOD' },
    data: { unit: 'PC' }
  });
  console.log(`✅ Updated ${result.count} finished goods to 'PC' unit.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
