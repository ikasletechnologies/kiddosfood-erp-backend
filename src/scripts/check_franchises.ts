import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const franchises = await prisma.franchise.findMany();
  console.log(JSON.stringify(franchises, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
