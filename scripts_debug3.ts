import 'dotenv/config';
console.log('DATABASE_URL:', process.env.DATABASE_URL);
import prisma from './src/lib/prisma';
async function main() {
  console.log('Users:', await prisma.user.count());
  console.log('Franchises:', await prisma.franchise.count());
  console.log('Roles:', await prisma.role.count());
  console.log('Vendors:', await prisma.vendor.count());
  console.log('InventoryItems:', await prisma.inventoryItem.count());
  console.log('ProcurementOrders:', await prisma.procurementOrder.count());
  const users = await prisma.user.findMany({ select: { email: true, createdAt: true } });
  console.log('USER LIST:', users);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
