import prisma from './src/lib/prisma';

async function audit() {
  const fid = 'b289238d-5493-4d0f-a72a-fd433fd2190f';
  try {
    const franchise = await prisma.franchise.findUnique({
      where: { id: fid },
      include: { primaryWarehouse: true }
    });
    
    if (!franchise) {
      console.log('Franchise not found!');
      process.exit(0);
    }
    
    const hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
    const all = await prisma.franchise.findMany();

    // Safely count
    const safeCount = async (promise: Promise<number>) => {
      try { return await promise; } catch (e) { return -1; }
    };

    const counts = {
      users: await safeCount(prisma.user.count({ where: { franchiseId: fid } })),
      inventory: await safeCount(prisma.inventoryItem.count({ where: { franchiseId: fid } })),
      productBatches: await safeCount(prisma.productBatch.count({ where: { franchiseId: fid } })),
      productions: await safeCount(prisma.production.count({ where: { franchiseId: fid } })),
      stockRequests: await safeCount(prisma.stockRequest.count({ where: { franchiseId: fid } })), // Wait, stockRequest usually has from/to
      outgoingTransfers: await safeCount(prisma.stockTransfer.count({ where: { fromFranchiseId: fid } })),
      incomingTransfers: await safeCount(prisma.stockTransfer.count({ where: { toFranchiseId: fid } })),
      wasteEntries: await safeCount(prisma.wasteEntry.count({ where: { franchiseId: fid } })),
      procurementOrders: await safeCount(prisma.procurementOrder.count({ where: { franchiseId: fid } })),
      accounts: await safeCount(prisma.account.count({ where: { franchiseId: fid } })),
    };

    let warehouseStats: any = null;
    if (franchise.primaryWarehouseId) {
      const wId = franchise.primaryWarehouseId;
      warehouseStats = {
        inventoryBatches: await safeCount(prisma.inventoryBatch.count({ where: { warehouseId: wId } })),
        stockMovements: await safeCount(prisma.stockMovement.count({ where: { warehouseId: wId } })),
        bins: await safeCount(prisma.warehouseBin.count({ where: { warehouseId: wId } }))
      };
    }

    console.log(JSON.stringify({
      targetFranchise: franchise,
      isThereAnHQ: hq ? hq.name : 'NONE',
      allFranchisesCount: all.length,
      allFranchises: all.map(f => ({ id: f.id, name: f.name, isHQ: f.isHQ })),
      counts,
      warehouseStats
    }, null, 2));

  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
audit();
