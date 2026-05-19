import prisma from '../src/lib/prisma';

async function main() {
  console.log('--- Current Franchise Orders in Database ---');
  const orders = await prisma.franchiseOrder.findMany({
    include: {
      items: {
        include: {
          product: true
        }
      },
      franchise: true
    },
    orderBy: { createdAt: 'desc' }
  });

  for (const o of orders) {
    console.log(`Order: ${o.orderNumber} | Status: ${o.status} | Total: ₹${o.totalAmount} | Franchise: ${o.franchise?.name}`);
    for (const item of o.items) {
      console.log(`  - Product: ${item.product?.name} | Sku: ${item.product?.sku} | Qty: ${item.quantity} | Type: ${item.productType}`);
    }
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
