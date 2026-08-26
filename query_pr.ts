import prisma from './src/lib/prisma';

async function main() {
  const prs = await prisma.purchaseReturn.findMany({
    include: {
      items: true,
      vendor: true
    },
    orderBy: { createdAt: 'desc' },
    take: 5
  });

  console.log("Purchase Returns details:");
  console.log(JSON.stringify(prs, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
