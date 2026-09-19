import prisma from '../lib/prisma';

async function main() {
  const recipes = await prisma.recipe.findMany({
    include: {
      product: true,
      recipeItems: {
        include: {
          inventoryItem: true
        }
      }
    }
  });

  console.log('Total recipes:', recipes.length);
  for (const r of recipes) {
    console.log({
      id: r.id,
      name: r.name,
      category: r.category,
      productId: r.productId,
      productName: r.product?.name,
      productCategory: r.product?.category,
      itemsCount: r.recipeItems.length
    });
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
