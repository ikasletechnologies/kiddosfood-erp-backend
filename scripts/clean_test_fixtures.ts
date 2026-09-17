import prisma from '../src/lib/prisma';

async function auditAndCleanTestFixtures() {
  console.log('=== Starting 5-Step Safe Test Data Audit ===');

  // Step 1: Query Candidate Items by Test Name Patterns
  const candidateNames = ['Concurrent Item', 'Item Branch A', 'Item Branch B', 'Low Stock Item'];
  
  const candidateItems = await prisma.inventoryItem.findMany({
    where: {
      OR: candidateNames.map(name => ({
        name: { contains: name, mode: 'insensitive' }
      }))
    },
    select: {
      id: true,
      name: true,
      sku: true,
      createdAt: true,
      franchiseId: true,
      movements: { select: { id: true } },
      grnItems: { select: { id: true } },
      poItems: { select: { id: true } },
      recipeItems: { select: { id: true } },
      productionItems: { select: { id: true } },
    }
  });

  console.log(`Found ${candidateItems.length} candidate test item records.`);

  const itemsToDelete: string[] = [];

  for (const item of candidateItems) {
    const totalRelations = 
      item.movements.length +
      item.grnItems.length +
      item.poItems.length +
      item.recipeItems.length +
      item.productionItems.length;

    console.log(`- Item ID: ${item.id} | Name: "${item.name}" | SKU: ${item.sku} | Linked Transactions: ${totalRelations}`);

    if (totalRelations === 0 || item.name.includes('Concurrent Item') || item.name.includes('Low Stock Item')) {
      itemsToDelete.push(item.id);
    } else {
      console.log(`  [SKIP] Item ${item.id} has linked operational records. Preserving.`);
    }
  }

  // Find orphan test alerts
  const orphanAlerts = await prisma.alert.findMany({
    where: {
      OR: [
        { title: { contains: 'Concurrent Item', mode: 'insensitive' } },
        { title: { contains: 'Item Branch A', mode: 'insensitive' } },
        { title: { contains: 'Item Branch B', mode: 'insensitive' } },
        { title: { contains: 'Low Stock Item', mode: 'insensitive' } },
      ]
    },
    select: { id: true, title: true }
  });

  console.log(`Found ${orphanAlerts.length} candidate test alert records.`);

  // Step 5: Execute Transactional Cleanup
  if (itemsToDelete.length > 0 || orphanAlerts.length > 0) {
    await prisma.$transaction(async (tx) => {
      const deletedAlerts = await tx.alert.deleteMany({
        where: {
          OR: [
            { entityId: { in: itemsToDelete } },
            { id: { in: orphanAlerts.map(a => a.id) } }
          ]
        }
      });
      console.log(`Deleted ${deletedAlerts.count} test alerts.`);

      const deletedMovements = await tx.stockMovement.deleteMany({
        where: { itemId: { in: itemsToDelete } }
      });
      console.log(`Deleted ${deletedMovements.count} test stock movements.`);

      const deletedItems = await tx.inventoryItem.deleteMany({
        where: { id: { in: itemsToDelete } }
      });
      console.log(`Deleted ${deletedItems.count} test inventory items.`);
    });
    console.log('=== Test Data Audit & Cleanup Completed Successfully ===');
  } else {
    console.log('No orphan test fixtures required deletion.');
  }
}

auditAndCleanTestFixtures()
  .catch((err) => {
    console.error('Audit and cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
