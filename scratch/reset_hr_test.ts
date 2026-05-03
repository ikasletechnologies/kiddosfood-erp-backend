import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function reset() {
  console.log('Resetting database for HR/Payroll testing...');
  
  // Order matters due to foreign keys
  await prisma.payment.deleteMany();
  await prisma.payslip.deleteMany();
  await prisma.leave.deleteMany();
  await prisma.employeeShift.deleteMany();
  await prisma.employee.deleteMany();
  // Don't delete users if we want to keep admin account, 
  // but for a full clean test, we should delete non-admin users.
  // Actually, let's just clear employees and related HR data.
  
  console.log('Database reset complete.');
}

reset()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
