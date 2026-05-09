// const { PrismaClient } = require('@prisma/client');
// const prisma = new PrismaClient();

// async function main() {
//   const items = await prisma.inventoryItem.findMany({
//     where: { name: { contains: 'milk', mode: 'insensitive' } },
//     select: { id: true, name: true, sku: true, currentStock: true, franchiseId: true }
//   });
//   console.log(JSON.stringify(items, null, 2));
// }

// main().catch(console.error).finally(() => prisma.$disconnect());
