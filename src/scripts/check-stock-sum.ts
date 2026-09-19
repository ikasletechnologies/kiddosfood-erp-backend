import prisma from '../lib/prisma';

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, name: true, currentStock: true }
  });
  
  let mismatches = 0;
  for (const item of items) {
    const movs = await prisma.stockMovement.findMany({
      where: { itemId: item.id },
      select: { quantity: true, baseQty: true, movementType: true }
    });
    const sum = movs.reduce((acc, m) => {
      const val = m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity;
      return acc + val;
    }, 0);
    if (Math.abs(sum - item.currentStock) > 0.001) {
      console.log(`Mismatch for ${item.name} (${item.id}): sum(movs)=${sum}, currentStock=${item.currentStock}`);
      mismatches++;
    }
  }
  console.log(`Total active items: ${items.length}, mismatches: ${mismatches}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
