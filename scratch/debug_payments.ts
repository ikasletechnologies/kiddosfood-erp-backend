import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const payments = await prisma.financialPayment.findMany();
  console.log('Payments:', JSON.stringify(payments, null, 2));
  
  const payslips = await prisma.payslip.findMany({
    where: { status: 'PAID' }
  });
  console.log('Paid Payslips:', JSON.stringify(payslips, null, 2));
}

check().catch(console.error).finally(() => prisma.$disconnect());
