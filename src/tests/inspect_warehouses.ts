import prisma from '../lib/prisma';

async function main() {
  const warehouses = await prisma.warehouse.findMany({
    include: {
      primaryForFranchises: {
        select: { id: true, name: true, isHQ: true }
      },
      bins: true,
    }
  });

  console.log('--- WAREHOUSES IN DB ---');
  console.log(JSON.stringify(warehouses, null, 2));

  console.log('--- WAREHOUSE SAMPLE ---');
  const sample = await prisma.warehouse.findFirst();
  console.log('Sample warehouse keys:', Object.keys(sample || {}));
  console.log('Sample warehouse:', sample);
}

main().finally(() => prisma.$disconnect());
