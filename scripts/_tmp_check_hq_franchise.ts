import prisma from '../src/lib/prisma';

(async () => {
  const hqRows = await prisma.franchise.findMany({ where: { isHQ: true } });
  console.log(`Franchises with isHQ=true: ${hqRows.length}`);
  for (const f of hqRows) {
    console.log(JSON.stringify({ id: f.id, name: f.name, status: f.status, createdAt: f.createdAt }));
  }

  const allFranchises = await prisma.franchise.findMany({ select: { id: true, name: true, isHQ: true, status: true } });
  console.log(`\nAll franchises (${allFranchises.length}):`);
  for (const f of allFranchises) {
    console.log(JSON.stringify(f));
  }

  const customersWithNullFranchise = await prisma.customer.count({ where: { franchiseId: null } });
  const dealersWithNullFranchise = await prisma.dealer.count();
  console.log(`\nCustomers with franchiseId=null: ${customersWithNullFranchise}`);
  console.log(`Total Dealer rows: ${dealersWithNullFranchise} (franchiseId is non-nullable on Dealer, so none can be null)`);

  await prisma.$disconnect();
})();
