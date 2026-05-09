import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  try {
    const vendors = await prisma.vendor.findMany({ take: 1 });
    console.log('Successfully queried vendors:', vendors);
    
    // Check columns
    const result = await prisma.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'Vendor'`;
    console.log('Columns in Vendor table:', result);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
