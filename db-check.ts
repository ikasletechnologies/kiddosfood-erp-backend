import prisma from './src/lib/prisma';

async function main() {
  const franchiseCount = await prisma.franchise.count();
  const customerCount = await prisma.customer.count();
  const dealerCount = await prisma.dealer.count();
  const orderCount = await prisma.order.count();
  const salesOrderCount = await prisma.salesOrder.count();
  const deliveryChallanCount = await prisma.deliveryChallan.count();
  const purchaseOrderCount = await prisma.procurementOrder.count();
  const customerLedgerCount = await prisma.customerLedger.count();
  
  console.log({
    franchiseCount,
    customerCount,
    dealerCount,
    orderCount,
    salesOrderCount,
    deliveryChallanCount,
    purchaseOrderCount,
    customerLedgerCount,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
