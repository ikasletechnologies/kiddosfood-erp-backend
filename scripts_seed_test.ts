import prisma from './src/lib/prisma';

async function main() {
  const franchise = await prisma.franchise.upsert({
    where: { id: 'hq-001' },
    update: {},
    create: { id: 'hq-001', name: 'Main Headquarters', location: 'Test', ownerName: 'Test', contactNum: '0000000000' },
  });

  const rice = await prisma.inventoryItem.create({
    data: { name: 'Test Rice', sku: 'TEST-RICE', category: 'RAW_MATERIAL', currentStock: 0, unit: 'kg', minimumStock: 5, franchiseId: franchise.id },
  });
  const dosa = await prisma.inventoryItem.create({
    data: { name: 'Test Masala Dosa', sku: 'TEST-DOSA-1KG', category: 'FINISHED_GOOD', currentStock: 0, unit: 'KG', minimumStock: 5, franchiseId: franchise.id },
  });

  await prisma.stockMovement.create({
    data: { itemId: rice.id, movementType: 'ADJUSTMENT', quantity: 20, note: 'Opening Stock Balance' },
  });
  await prisma.inventoryItem.update({ where: { id: rice.id }, data: { currentStock: 20 } });

  await prisma.stockMovement.create({
    data: { itemId: dosa.id, movementType: 'PRODUCTION_IN', quantity: 5, note: 'QC Approved batch: TEST-BATCH (5 units approved after 0 rejected)' },
  });
  await prisma.inventoryItem.update({ where: { id: dosa.id }, data: { currentStock: 5 } });

  console.log('SEEDED:', { franchiseId: franchise.id, riceId: rice.id, dosaId: dosa.id });
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
