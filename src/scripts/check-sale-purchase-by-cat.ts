import prisma from '../lib/prisma';
import { FinanceService } from '../modules/finance/finance.service';

async function main() {
  const report = await FinanceService.getSalePurchaseByCategoryData();
  console.log('Current report result:', JSON.stringify(report, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
