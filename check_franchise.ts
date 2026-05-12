import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const franchises = await prisma.franchise.findMany({ select: { id: true, name: true } });
  console.log('--- FRANCHISES ---');
  console.table(franchises);
}

main().finally(() => prisma.$disconnect());
