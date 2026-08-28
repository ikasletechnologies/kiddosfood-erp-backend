import prisma from './src/lib/prisma';
async function main() {
  console.log('=== Product table ===');
  const product = await prisma.product.findFirst({ where: { sku: 'RCP-0001-1KG' } });
  console.log('Product row for RCP-0001-1KG:', product);

  console.log('\n=== Compare with a known Finished Good ===');
  const fgProduct = await prisma.product.findFirst({ where: { sku: 'FG-ALLI-500G' } });
  console.log('FG-ALLI-500G Product:', fgProduct);

  console.log('\n=== InventoryItem table ===');
  const item = await prisma.inventoryItem.findFirst({ where: { sku: 'RCP-0001-1KG' } });
  console.log('InventoryItem for RCP-0001-1KG:', item);

  const fgItem = await prisma.inventoryItem.findFirst({ where: { sku: 'FG-ALLI-500G' } });
  console.log('\nInventoryItem for FG-ALLI-500G (comparison):', fgItem);

  console.log('\n=== Any product with name containing IDLI/DOSA BATTER ===');
  const byName = await prisma.product.findMany({ where: { name: { contains: 'IDLI', mode: 'insensitive' } } });
  console.log(byName.map(p => ({ id: p.id, sku: p.sku, name: p.name, productType: p.productType })));

  console.log('\n=== Recipe table check ===');
  const recipe = await prisma.recipe.findFirst({ where: { OR: [{ recipeCode: 'RCP-0001' }, { name: { contains: 'IDLI', mode: 'insensitive' } }] } });
  console.log('Matching Recipe:', recipe);
}
main().finally(() => prisma.$disconnect());
