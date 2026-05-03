import prisma from '../src/lib/prisma';

async function test() {
  const p = await prisma.financialPayment.findMany();
  console.log(p.length);
}
