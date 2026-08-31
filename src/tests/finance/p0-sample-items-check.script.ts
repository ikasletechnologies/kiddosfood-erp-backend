import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';

(async () => {
  const items = await FinanceService.getSaleOrderItemsReportData({});
  console.log(`Total items: ${items.length}`);
  console.log(JSON.stringify(items.slice(0, 3), null, 2));
  const blankProduct = items.filter((i: any) => !i.productName || i.productName === 'Item').length;
  const blankQty = items.filter((i: any) => i.quantity === undefined || i.quantity === null).length;
  console.log(`Rows with fallback/blank productName: ${blankProduct}/${items.length}`);
  console.log(`Rows with missing quantity: ${blankQty}/${items.length}`);
  await prisma.$disconnect();
})();
