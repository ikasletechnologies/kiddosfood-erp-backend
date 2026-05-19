import prisma from '../lib/prisma';

async function main() {
  console.log('--- Database Account Check ---');
  const accounts = await prisma.account.findMany();
  console.log(`Total Accounts in DB: ${accounts.length}`);
  for (const acc of accounts) {
    console.log(`- ID: ${acc.id}, Code: ${acc.accountCode}, Name: ${acc.name}, Type: ${acc.type}, Balance: ${acc.balance}, Franchise: ${acc.franchiseId || 'HQ (null)'}`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
