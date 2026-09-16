import prisma from './lib/prisma';

async function main() {
  console.log('Adding sourceSalesOrderId to Order...');
  await prisma.$executeRawUnsafe(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "sourceSalesOrderId" TEXT;`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Order_sourceSalesOrderId_key" ON "Order"("sourceSalesOrderId");`);

  console.log('Adding convertedInvoiceId to SalesOrder...');
  await prisma.$executeRawUnsafe(`ALTER TABLE "SalesOrder" ADD COLUMN IF NOT EXISTS "convertedInvoiceId" TEXT;`);

  console.log('Done altering tables.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
