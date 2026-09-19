import prisma from '../lib/prisma';

async function run() {
  const items = await prisma.inventoryItem.findMany({ select: { unit: true } });
  const distinctUnits = Array.from(new Set(items.map(i => i.unit)));
  console.log('=== Distinct InventoryItem units in DB ===');
  console.log(distinctUnits);

  const dc = await prisma.deliveryChallan.findFirst({
    where: { challanNumber: { contains: '00063' } },
    include: { items: true }
  });
  console.log('=== DC 00063 ===');
  console.log(JSON.stringify(dc, null, 2));
}

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
