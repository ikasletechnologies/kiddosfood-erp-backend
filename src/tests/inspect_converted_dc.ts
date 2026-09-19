import prisma from '../lib/prisma';

async function main() {
  const converted = await prisma.deliveryChallan.findMany({
    where: { status: 'CONVERTED' },
    take: 5,
    orderBy: { updatedAt: 'desc' }
  });

  console.log(`Found ${converted.length} converted delivery challans:`);
  for (const dc of converted) {
    console.log({
      id: dc.id,
      challanNumber: dc.challanNumber,
      status: dc.status,
      convertedOrderId: dc.convertedOrderId,
      convertedInvoiceId: dc.convertedInvoiceId,
    });

    if (dc.convertedOrderId) {
      const ord = await prisma.order.findUnique({ where: { id: dc.convertedOrderId } });
      const so = await prisma.salesOrder.findUnique({ where: { id: dc.convertedOrderId } });
      console.log(`  -> Order lookup:`, ord ? `Found Order id=${ord.id} invoiceNum=${ord.invoiceNum}` : 'Not in Order');
      console.log(`  -> SalesOrder lookup:`, so ? `Found SalesOrder id=${so.id} orderNumber=${so.orderNumber}` : 'Not in SalesOrder');
    }

    if (dc.convertedInvoiceId) {
      const inv = await prisma.invoice.findUnique({ where: { id: dc.convertedInvoiceId }, include: { order: true } });
      console.log(`  -> Invoice lookup:`, inv ? `Found Invoice id=${inv.id} invoiceNum=${inv.order?.invoiceNum}` : 'Not in Invoice');
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
