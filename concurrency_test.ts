import { PrismaClient } from '@prisma/client';
import { FranchiseOrderService } from './src/modules/franchise/franchise-order.service';
import { FranchiseOrderStatus } from '@prisma/client';

import prisma from './src/lib/prisma';

async function run() {
  // Setup: find HQ and create test product and stock
  let hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
  let franchise = await prisma.franchise.findFirst({ where: { isHQ: false } });
  
  if (!hq) hq = await prisma.franchise.create({ data: { name: "HQ", isHQ: true, location: "", ownerName: "", contactNum: "" } }) as any;
  if (!franchise) franchise = await prisma.franchise.create({ data: { name: "F1", isHQ: false, location: "", ownerName: "", contactNum: "" } }) as any;

  const ts = Date.now();
  const product = await prisma.product.create({
    data: { name: `Test Product ${ts}`, productType: 'FINISHED_GOOD', basePrice: 100, isActive: true, taxPercent: 5 }
  });

  const invItem = await prisma.inventoryItem.create({
    data: { name: product.name, category: 'FINISHED_GOOD', currentStock: 200, franchiseId: hq!.id, isActive: true, sku: `TST-${ts}`, unit: 'PC' }
  });

  const batch = await prisma.inventoryBatch.create({
    data: { inventoryItemId: invItem.id, initialQty: 200, currentQty: 200, unitCost: 50, status: 'APPROVED', mfgDate: new Date(), batchNumber: `B-${ts}` }
  });

  console.log(`Setup complete. Physical=200, Available=200, Reserved=0`);

  const orderA = await FranchiseOrderService.createOrder({
    franchiseId: franchise!.id,
    orderType: 'STOCK',
    items: [{ productId: product.id, quantity: 150 }]
  });

  const orderB = await FranchiseOrderService.createOrder({
    franchiseId: franchise!.id,
    orderType: 'STOCK',
    items: [{ productId: product.id, quantity: 100 }]
  });

  console.log(`Orders created: A=${orderA.id}, B=${orderB.id}`);

  // Concurrently approve both
  const results = await Promise.allSettled([
    FranchiseOrderService.updateStatus(orderA.id, 'APPROVED'),
    FranchiseOrderService.updateStatus(orderB.id, 'APPROVED')
  ]);

  console.log('Results of concurrent approval:', results.map(r => r.status === 'fulfilled' ? 'SUCCESS' : `FAILED: ${(r as any).reason.message}`));

  const batchAfter = await prisma.$queryRaw<any[]>`SELECT * FROM "InventoryBatch" WHERE id = ${batch.id}`;
  const allocs = await prisma.inventoryReservationAllocation.findMany({ where: { inventoryBatchId: batch.id } });
  const reserved = allocs.reduce((sum, a) => sum + a.reservedQty, 0);
  
  console.log(`Final Physical=${batchAfter[0].currentQty}, Reserved=${reserved}, Available=${batchAfter[0].currentQty - reserved}`);
}

run().catch(console.error).finally(() => prisma.$disconnect());
