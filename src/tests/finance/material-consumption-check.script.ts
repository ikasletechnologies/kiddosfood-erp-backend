import prisma from '../../lib/prisma';

async function main() {
  const movements = await prisma.stockMovement.findMany({
    where: { quantity: { lt: 0 } },
    include: { item: true },
  });
  for (const m of movements) {
    console.log(JSON.stringify({
      id: m.id,
      movementType: m.movementType,
      quantity: m.quantity,
      createdAt: m.createdAt,
      itemCategory: m.item?.category,
      itemFranchiseId: m.item?.franchiseId,
      itemName: m.item?.name,
    }));
  }
  await prisma.$disconnect();
}
main();
