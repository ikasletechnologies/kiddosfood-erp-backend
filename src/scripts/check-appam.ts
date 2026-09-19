import prisma from '../lib/prisma';

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { name: { contains: 'APPAM', mode: 'insensitive' } }
  });
  console.log(`Found ${items.length} items matching APPAM:`);
  for (const item of items) {
    const movements = await prisma.stockMovement.findMany({
      where: { itemId: item.id },
      orderBy: { createdAt: 'asc' }
    });
    console.log(`Item: ${item.name} (${item.id}), currentStock: ${item.currentStock}, franchiseId: ${item.franchiseId}`);
    console.log(`Movements count: ${movements.length}`);
    for (const m of movements) {
      console.log(`  - [${m.createdAt.toISOString()}] Type: ${m.movementType}, Qty: ${m.quantity}, BaseQty: ${m.baseQty}, Ref: ${m.referenceType} (${m.referenceId})`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
