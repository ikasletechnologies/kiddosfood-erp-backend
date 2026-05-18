import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: {
      category: 'FINISHED_GOOD',
      unit: { in: ['g', 'kg'] }
    }
  });

  console.log(`Found ${items.length} finished goods with weight units.`);

  for (const item of items) {
    console.log(`Updating ${item.name} (${item.sku}) unit from ${item.unit} to 'pkt'...`);
    await prisma.inventoryItem.update({
      where: { id: item.id },
      data: { unit: 'pkt' }
    });
    
    // Product model doesn't have a 'unit' field, so skipping product update
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
