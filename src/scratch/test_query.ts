import prisma from '../lib/prisma';

async function main() {
  console.log('--- DIRECT PRISMA QUERY CHECK ---');

  // Test 1: Query with franchiseId: 'fran-downtown'
  const accountsDowntown = await prisma.account.findMany({
    where: { franchiseId: 'fran-downtown' }
  });
  console.log(`\nQuery with franchiseId: 'fran-downtown' returns ${accountsDowntown.length} accounts:`);
  accountsDowntown.forEach(a => {
    console.log(`- ${a.name} (ID: ${a.id}) | Franchise: ${a.franchiseId}`);
  });

  // Test 2: Query with franchiseId: null
  const accountsNull = await prisma.account.findMany({
    where: { franchiseId: null }
  });
  console.log(`\nQuery with franchiseId: null returns ${accountsNull.length} accounts:`);
  accountsNull.forEach(a => {
    console.log(`- ${a.name} (ID: ${a.id}) | Franchise: ${a.franchiseId}`);
  });

  // Test 3: Query all
  const allAccounts = await prisma.account.findMany();
  console.log(`\nQuery all returns ${allAccounts.length} accounts:`);
  allAccounts.forEach(a => {
    console.log(`- ${a.name} (ID: ${a.id}) | Franchise: ${a.franchiseId}`);
  });
}

main().finally(() => prisma.$disconnect());
