import prisma from './src/lib/prisma';
async function main() {
  const total = await prisma.inventoryItem.count();
  console.log('TOTAL INVENTORY ITEMS:', total);
  const byId = await prisma.inventoryItem.findUnique({ where: { id: 'f04bcbb0-5e21-4117-afb5-3ae0bdebb268' } });
  console.log('BY OLD ID:', byId);
  const franchises = await prisma.franchise.findMany();
  console.log('FRANCHISES:', franchises.map(f => f.id));
  const allItems = await prisma.inventoryItem.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
  console.log('RECENT ITEMS:', allItems.map(i => ({ name: i.name, franchiseId: i.franchiseId, isActive: i.isActive, category: i.category })));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
