import prisma from './src/lib/prisma';

async function check() {
  const order = await prisma.order.findFirst({
    where: { invoiceNum: 'INV-1778479341658' },
    include: { items: true, customer: true }
  });
  console.log('Order Details:', JSON.stringify(order, null, 2));
}

check().finally(() => prisma.$disconnect());
