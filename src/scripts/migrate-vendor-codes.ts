import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function migrate() {
  const vendors = await prisma.vendor.findMany({
    where: { vendorCode: null },
    orderBy: { createdAt: 'asc' }
  });

  console.log(`Updating ${vendors.length} vendors with codes...`);

  for (let i = 0; i < vendors.length; i++) {
    const code = `V-${(i + 1).toString().padStart(4, '0')}`;
    await prisma.vendor.update({
      where: { id: vendors[i].id },
      data: { vendorCode: code }
    });
    console.log(`Updated ${vendors[i].name} -> ${code}`);
  }

  process.exit(0);
}

migrate();
