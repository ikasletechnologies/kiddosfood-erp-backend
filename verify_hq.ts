import prisma from './src/lib/prisma';

async function main() {
  const franchises = await prisma.franchise.count();
  const hqFranchises = await prisma.franchise.count({ where: { isHQ: true } });
  
  const hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
  
  const warehouses = await prisma.warehouse.count();
  const centralWarehouse = await prisma.warehouse.findFirst({ where: { type: 'MAIN' } });
  
  const superAdmin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  
  console.log('--- VERIFICATION RESULTS ---');
  console.log(`Franchise Count: ${franchises}`);
  console.log(`HQ Franchise Count (isHQ=true): ${hqFranchises}`);
  if (hq) {
    console.log(`HQ ID: ${hq.id}`);
    console.log(`HQ Name: ${hq.name}`);
    console.log(`HQ isHQ: ${hq.isHQ}`);
    console.log(`HQ primaryWarehouseId: ${hq.primaryWarehouseId}`);
  }
  
  console.log(`\nWarehouse Count: ${warehouses}`);
  if (centralWarehouse) {
    console.log(`Central Warehouse ID: ${centralWarehouse.id}`);
    console.log(`Central Warehouse Name: ${centralWarehouse.name}`);
  }
  
  console.log(`\nSuper Admin exists: ${!!superAdmin}`);
  if (superAdmin) {
    console.log(`Super Admin franchiseId: ${superAdmin.franchiseId}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
