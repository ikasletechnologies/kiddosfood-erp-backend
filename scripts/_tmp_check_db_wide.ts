import prisma from '../src/lib/prisma';

(async () => {
  const counts: Record<string, number> = {};
  counts.Franchise = await prisma.franchise.count();
  counts.Production = await prisma.production.count();
  counts.ProductBatch = await prisma.productBatch.count();
  counts.InventoryItem = await prisma.inventoryItem.count();
  counts.User = await prisma.user.count();
  counts.Customer = await prisma.customer.count();
  counts.Dealer = await prisma.dealer.count();
  counts.DeliveryChallan = await prisma.deliveryChallan.count();
  console.log('Row counts on the currently-connected database:', counts);

  const schemas: any = await prisma.$queryRawUnsafe(`
    SELECT table_schema, count(*)::int AS table_count
    FROM information_schema.tables
    WHERE table_name = 'Franchise'
    GROUP BY table_schema;
  `);
  console.log('Schemas containing a "Franchise" table:', schemas);

  const dbInfo: any = await prisma.$queryRawUnsafe(`SELECT current_database() AS db, current_schema() AS schema, inet_server_addr()::text AS server_addr;`);
  console.log('Connection info:', dbInfo);

  await prisma.$disconnect();
})();
