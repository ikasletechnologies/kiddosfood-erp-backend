import prisma from './src/lib/prisma';

async function main() {
  const hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
  const warehouse = await prisma.warehouse.findFirst({ where: { type: 'MAIN' } });

  if (!hq || !warehouse) {
    console.error('Missing HQ or Warehouse!');
    return;
  }

  await prisma.franchise.update({
    where: { id: hq.id },
    data: { primaryWarehouseId: warehouse.id }
  });

  console.log(`✅ Successfully linked HQ Franchise (${hq.id}) to Central Warehouse (${warehouse.id})`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
