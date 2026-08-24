import prisma from './src/lib/prisma';
async function run() {
  try {
    const warehouses = await prisma.warehouse.findMany();
    console.log(JSON.stringify(warehouses, null, 2));
  } catch(e) { console.error(e); } finally { process.exit(0); }
}
run();
