
import prisma from '../src/lib/prisma';

async function checkEmployees() {
  try {
    const employees = await prisma.employee.findMany({
      select: { employeeCode: true }
    });
    console.log('Existing Employee Codes:', employees.map(e => e.employeeCode));
    
    const users = await prisma.user.findMany({
        include: { employee: true }
    });
    console.log('Users with employees:', users.filter(u => u.employee).map(u => ({ id: u.id, email: u.email })));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit();
  }
}

checkEmployees();
