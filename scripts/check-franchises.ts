import prisma from '../src/lib/prisma';

async function main() {
  const franchises = await prisma.franchise.findMany({
    select: { id: true, name: true, isHQ: true, primaryWarehouseId: true, status: true }
  });
  console.log('Franchises:', JSON.stringify(franchises, null, 2));

  const stockRequests = await prisma.stockRequest.count();
  console.log('StockRequest rows:', stockRequests);

  const franchiseOrders = await prisma.franchiseOrder.findMany({
    select: { id: true, orderType: true, status: true, franchiseId: true }
  });
  console.log('FranchiseOrder rows:', JSON.stringify(franchiseOrders, null, 2));

  const warehouses = await prisma.warehouse.findMany({
    select: { id: true, name: true }
  });
  console.log('Warehouses:', JSON.stringify(warehouses, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
