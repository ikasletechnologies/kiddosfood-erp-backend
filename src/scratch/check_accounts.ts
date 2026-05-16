import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.account.findMany();
  console.log('Accounts:', JSON.stringify(accounts, null, 2));
  
  const payments = await prisma.payment.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
  console.log('Recent Payments:', JSON.stringify(payments, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
