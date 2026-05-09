import prisma from '../src/lib/prisma';

async function main() {
  console.log('🌱 Seeding default accounts...');

  const accounts = [
    { name: 'Cash on Hand', type: 'CASH' as const },
    { name: 'Main Bank Account', type: 'BANK' as const },
    { name: 'UPI Wallet', type: 'UPI' as const },
  ];

  for (const acc of accounts) {
    await prisma.account.upsert({
      where: { id: acc.name.toLowerCase().replace(/ /g, '-') }, // Using name-based ID for predictable seeding
      update: {},
      create: {
        id: acc.name.toLowerCase().replace(/ /g, '-'),
        name: acc.name,
        type: acc.type,
        balance: 0
      }
    });
  }

  console.log('✅ Accounts seeded.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
