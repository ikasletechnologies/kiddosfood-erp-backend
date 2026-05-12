import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const franchises = await prisma.franchise.findMany();
  console.log('--- ALL FRANCHISES ---');
  console.table(franchises);
}

main().finally(() => prisma.$disconnect());
