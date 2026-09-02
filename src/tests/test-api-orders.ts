import { SalesService } from '../modules/sales/sales.service';
import prisma from '../lib/prisma';

async function main() {
  const orders = await SalesService.getSalesOrders({});
  console.log('Returned Sales Orders Count:', orders.length);
  for (const o of orders) {
    console.log({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      convertedInvoiceId: (o as any).convertedInvoiceId,
      convertedInvoiceNumber: (o as any).convertedInvoiceNumber
    });
  }
}

main()
