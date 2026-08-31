import prisma from '../../lib/prisma';

(async () => {
  const order = await prisma.order.findUnique({
    where: { invoiceNum: 'INV-2026-00010' },
    include: { orderItems: { include: { product: true } }, customer: true, invoice: true },
  });
  console.log('=== Order (Tax Invoice) INV-2026-00010 ===');
  console.log(JSON.stringify(order, null, 2));

  if (order) {
    console.log('\n=== Is there an Invoice model row for this Order? ===');
    console.log(order.invoice);

    if (order.sourceProformaInvoiceId) {
      const proforma = await prisma.proformaInvoice.findUnique({
        where: { id: order.sourceProformaInvoiceId },
        include: { items: true },
      });
      console.log('\n=== Source Proforma ===');
      console.log(JSON.stringify(proforma, null, 2));
    }
  } else {
    console.log('No order found with that invoiceNum — listing recent orders for reference:');
    const recent = await prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, invoiceNum: true, orderType: true, sourceProformaInvoiceId: true } });
    console.log(recent);
  }

  await prisma.$disconnect();
})();
