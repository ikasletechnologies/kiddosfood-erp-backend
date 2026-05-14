import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Simplifying Hierarchy...');

  // 1. Identify the Main HQ
  const hq = await prisma.franchise.findFirst({
    where: { 
      OR: [
        { name: 'Kiddos Food Headquarters' },
        { id: 'hq-001' }
      ]
    }
  });

  if (!hq) {
    console.error('❌ Main HQ not found!');
    return;
  }

  // 2. Cleanup confusing franchises
  const confusingNames = ['Headquarters (HQ)', 'Distribution Center'];
  
  await prisma.franchise.updateMany({
    where: {
      name: { in: confusingNames }
    },
    data: {
      status: 'DELETED' // Or DEACTIVATED
    }
  });

  console.log(`✅ Deactivated: ${confusingNames.join(', ')}`);

  // 3. Ensure "Downtown Outlet" is active
  await prisma.franchise.updateMany({
    where: { name: 'Downtown Outlet' },
    data: { status: 'ACTIVE' }
  });

  console.log('✅ Hierarchy simplified to 2-level structure.');
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
