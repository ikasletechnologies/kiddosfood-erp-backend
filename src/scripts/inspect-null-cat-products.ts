import prisma from '../lib/prisma';

async function main() {
  const products = await prisma.product.findMany({
    where: {
      OR: [
        { category: null },
        { category: '' },
        { category: 'FINISHED_GOOD' },
        { category: 'RAW_MATERIAL' }
      ]
    },
    include: {
      recipe: true
    }
  });

  console.log('Products with technical or null category:', products.map(p => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    category: p.category,
    recipe: p.recipe ? { name: p.recipe.name, category: p.recipe.category } : null
  })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
