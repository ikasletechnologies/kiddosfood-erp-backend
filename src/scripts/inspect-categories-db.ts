import prisma from '../lib/prisma';

async function main() {
  // 1. All distinct Product categories
  const products = await prisma.product.findMany({
    select: { id: true, name: true, sku: true, category: true }
  });
  const prodCatCount: Record<string, number> = {};
  for (const p of products) {
    const c = p.category ?? 'NULL';
    prodCatCount[c] = (prodCatCount[c] || 0) + 1;
  }
  console.log('Distinct Product categories:', prodCatCount);

  // 2. Recipe categories
  const recipeCats = await prisma.recipeCategory.findMany();
  console.log('RecipeCategory table:', recipeCats);

  const recipes = await prisma.recipe.findMany({
    select: { id: true, name: true, category: true }
  });
  const recipeCatCount: Record<string, number> = {};
  for (const r of recipes) {
    const c = r.category ?? 'NULL';
    recipeCatCount[c] = (recipeCatCount[c] || 0) + 1;
  }
  console.log('Recipe.category counts:', recipeCatCount);

  // 3. All distinct items ever purchased in procurement orders / GRNs
  const grnItems = await prisma.goodsReceiptItem.findMany({
    include: {
      inventoryItem: true
    }
  });
  console.log('Total GRN items count:', grnItems.length);
  const purchasedItems = new Map<string, { name: string; sku: string; category: string }>();
  for (const gi of grnItems) {
    if (gi.inventoryItem) {
      purchasedItems.set(gi.inventoryItem.id, {
        name: gi.inventoryItem.name,
        sku: gi.inventoryItem.sku,
        category: gi.inventoryItem.category
      });
    }
  }
  console.log('Distinct purchased inventory items:', Array.from(purchasedItems.values()));

  // 4. Check if any recipe items link to these purchased inventory items
  for (const [id, item] of purchasedItems) {
    const recipeItems = await prisma.recipeItem.findMany({
      where: { inventoryItemId: id },
      include: { recipe: true }
    });
    console.log(`Purchased item "${item.name}" used in recipes:`, recipeItems.map(ri => ({ recipeName: (ri as any).recipe?.name, recipeCat: (ri as any).recipe?.category })));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
