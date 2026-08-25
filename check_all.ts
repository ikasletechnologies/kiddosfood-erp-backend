import prisma from './src/lib/prisma';

async function main() {
  const franchises = await prisma.franchise.findMany();
  console.log('All Franchises:', franchises.map(f => ({ id: f.id, name: f.name, isHQ: f.isHQ, primaryWarehouseId: f.primaryWarehouseId })));
  
  const warehouses = await prisma.warehouse.findMany();
  console.log('All Warehouses:', warehouses.map(w => ({ id: w.id, name: w.name, type: w.type })));
}

main().catch(console.error).finally(() => prisma.$disconnect());
