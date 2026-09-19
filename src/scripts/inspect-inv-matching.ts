import prisma from '../lib/prisma';

async function main() {
  const invCount = await prisma.inventoryItem.count();
  console.log('Total inventory items:', invCount);

  // Check how many inventory items match Product by SKU or name
  const invItems = await prisma.inventoryItem.findMany({
    select: { id: true, name: true, sku: true, category: true }
  });

  const products = await prisma.product.findMany({
    select: { id: true, name: true, sku: true, category: true }
  });

  const prodBySku = new Map(products.map(p => [p.sku?.toUpperCase(), p]));
  const prodByName = new Map(products.map(p => [p.name?.toUpperCase(), p]));

  let matchedBySku = 0;
  let matchedByName = 0;
  let noMatch = 0;

  for (const inv of invItems) {
    if (inv.sku && prodBySku.has(inv.sku.toUpperCase())) {
      matchedBySku++;
    } else if (inv.name && prodByName.has(inv.name.toUpperCase())) {
      matchedByName++;
    } else {
      noMatch++;
    }
  }

  console.log({
    totalInv: invItems.length,
    matchedBySku,
    matchedByName,
    noMatch
  });

  // What are the items with no match?
  const unmatched = invItems.filter(inv => 
    (!inv.sku || !prodBySku.has(inv.sku.toUpperCase())) &&
    (!inv.name || !prodByName.has(inv.name.toUpperCase()))
  );
  console.log('Unmatched inventory items sample:', unmatched.slice(0, 20));

  // Let's also check if there is any other Category model or table in Prisma
  // We can inspect prisma model names
  console.log('Prisma models related to category:');
  for (const key of Object.keys(prisma)) {
    if (key.toLowerCase().includes('cat')) {
      console.log('  -', key);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
