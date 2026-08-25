import prisma from '../src/lib/prisma';

(async () => {
  const franchiseCount = await prisma.franchise.count();
  console.log('Franchise.count():', franchiseCount);

  const productionCount = await prisma.production.count();
  console.log('Production.count():', productionCount);

  const sampleProduction = await prisma.production.findFirst({ include: { franchise: true } });
  console.log('Sample production + its franchise:', JSON.stringify(sampleProduction ? { productionId: sampleProduction.id, franchiseId: sampleProduction.franchiseId, franchise: sampleProduction.franchise } : null, null, 2));

  // Raw SQL cross-check in case the Prisma model/client is out of sync with the actual table
  const raw: any = await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "Franchise"');
  console.log('Raw SQL SELECT count(*) FROM "Franchise":', raw);

  await prisma.$disconnect();
})();
