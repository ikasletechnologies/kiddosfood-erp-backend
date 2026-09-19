import prisma from '../lib/prisma';

async function main() {
  const products = await prisma.product.findMany();
  const items = await prisma.inventoryItem.findMany();

  const unmatched = items.filter(i => {
    const bySku = products.find(p => p.sku && p.sku.trim().toLowerCase() === i.sku.trim().toLowerCase());
    const byName = products.find(p => p.name.trim().toLowerCase() === i.name.trim().toLowerCase());
    return !bySku && !byName;
  });

  console.log(`Unmatched inventory items (${unmatched.length}):`);
  for (const u of unmatched) {
    console.log(`  Item: ${u.name}, sku: ${u.sku}, category: ${u.category}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
