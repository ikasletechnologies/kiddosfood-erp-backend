import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const accounts = await prisma.account.findMany();
  console.log('ACCOUNTS IN DB:', JSON.stringify(accounts, null, 2));
}

check().catch(console.error).finally(() => prisma.$disconnect());
