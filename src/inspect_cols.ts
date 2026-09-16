import prisma from './lib/prisma';

async function main() {
  const cols = await prisma.$queryRawUnsafe<any[]>("SELECT column_name FROM information_schema.columns WHERE table_name = 'Quotation'");
  console.log('Quotation cols:', cols.map(c => c.column_name));
}

main().catch(console.error).finally(() => prisma.$disconnect());
