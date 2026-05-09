
import prisma from '../src/lib/prisma';

async function findMaxCode() {
  try {
    const lastEmployee = await prisma.employee.findFirst({
      orderBy: { employeeCode: 'desc' },
      select: { employeeCode: true }
    });
    console.log('Last Employee Code:', lastEmployee?.employeeCode);
    
    if (lastEmployee?.employeeCode) {
        const num = parseInt(lastEmployee.employeeCode.split('-')[1]);
        console.log('Next Number:', num + 1);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit();
  }
}

findMaxCode();
