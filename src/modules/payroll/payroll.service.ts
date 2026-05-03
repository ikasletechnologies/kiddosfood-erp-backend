import prisma from '../../lib/prisma';

export class PayrollService {
  // ─── Salary Components ───────────────────────────────────────────────────────

  static async getComponents() {
    return prisma.salaryComponent.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  }

  static async createComponent(data: {
    name: string;
    type: 'EARNING' | 'DEDUCTION';
    calculationType?: string;
    value: number;
  }) {
    return prisma.salaryComponent.create({ data: { ...data, calculationType: data.calculationType || 'FIXED' } });
  }

  static async updateComponent(id: string, data: Partial<{
    name: string;
    calculationType: string;
    value: number;
    isActive: boolean;
  }>) {
    return prisma.salaryComponent.update({ where: { id }, data });
  }

  // ─── Salary Structures ───────────────────────────────────────────────────────

  static async getStructures() {
    return prisma.salaryStructure.findMany({
      include: { items: { include: { component: true } }, _count: { select: { employees: true } } },
      orderBy: { name: 'asc' }
    });
  }

  static async getStructureById(id: string) {
    return prisma.salaryStructure.findUnique({
      where: { id },
      include: { items: { include: { component: true } } }
    });
  }

  static async createStructure(data: {
    name: string;
    description?: string;
    items: Array<{ componentId: string; overrideValue?: number }>;
  }) {
    return prisma.salaryStructure.create({
      data: {
        name: data.name,
        description: data.description,
        items: { create: data.items.map((item) => ({ componentId: item.componentId, overrideValue: item.overrideValue })) }
      },
      include: { items: { include: { component: true } } }
    });
  }

  static async updateStructure(id: string, data: { name?: string; description?: string }) {
    return prisma.salaryStructure.update({ where: { id }, data });
  }

  // ─── Payroll Processing ──────────────────────────────────────────────────────

  static async getPayrolls() {
    return prisma.payroll.findMany({
      include: { _count: { select: { payslips: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    });
  }

  static async createPayroll(data: { month: number; year: number }) {
    return prisma.payroll.create({ data });
  }

  static async processPayroll(payrollId: string) {
    const payroll = await prisma.payroll.findUnique({ where: { id: payrollId } });
    if (!payroll) throw new Error('Payroll not found');

    const monthStart = new Date(payroll.year, payroll.month - 1, 1);
    const monthEnd = new Date(payroll.year, payroll.month, 0);

    const employees = await prisma.employee.findMany({
      include: {
        salaryStructure: { include: { items: { include: { component: true } } } },
        leaves: {
          where: {
            status: 'APPROVED',
            startDate: { lte: monthEnd },
            endDate: { gte: monthStart }
          },
          include: { leaveType: true }
        }
      }
    });

    const payslips: object[] = [];

    for (const emp of employees) {
      const baseSalary = emp.salary ? Number(emp.salary) : 0;
      if (baseSalary === 0) continue;

      // In a standard 30-day month calculation
      const workingDays = 30;
      
      let unpaidLeaveDays = 0;
      for (const leave of emp.leaves) {
        // Only deduct if leave is NOT paid
        if (leave.leaveType.isPaid) continue;

        const overlapStart = leave.startDate < monthStart ? monthStart : leave.startDate;
        const overlapEnd = leave.endDate > monthEnd ? monthEnd : leave.endDate;
        
        const diffTime = overlapEnd.getTime() - overlapStart.getTime();
        const diffDays = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1);
        unpaidLeaveDays += diffDays;
      }

      const payableDays = Math.max(0, workingDays - unpaidLeaveDays);
      const dailySalary = baseSalary / workingDays;
      const deductionAmount = Math.round(dailySalary * unpaidLeaveDays);
      const netSalary = Math.round(dailySalary * payableDays);

      const components = [
        { name: 'Basic Salary', type: 'EARNING', amount: baseSalary },
      ];

      if (unpaidLeaveDays > 0) {
        components.push({ name: `Unpaid Leave (${unpaidLeaveDays} days)`, type: 'DEDUCTION', amount: deductionAmount });
      }

      const existing = await prisma.payslip.findFirst({
        where: { employeeId: emp.id, month: payroll.month, year: payroll.year }
      });

      if (!existing) {
        const payslip = await prisma.payslip.create({
          data: {
            payrollId,
            employeeId: emp.id,
            month: payroll.month,
            year: payroll.year,
            basicSalary: baseSalary,
            totalEarnings: baseSalary,
            totalDeductions: deductionAmount,
            netSalary,
            components
          }
        });
        payslips.push(payslip);
      }
    }

    await prisma.payroll.update({ where: { id: payrollId }, data: { status: 'PROCESSED', processedAt: new Date() } });

    return { payrollId, payslipsGenerated: payslips.length };
  }

  // ─── Payslips ────────────────────────────────────────────────────────────────

  static async getPayslips(filters: { employeeId?: string; month?: number; year?: number; payrollId?: string }) {
    const where: any = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.month) where.month = filters.month;
    if (filters.year) where.year = filters.year;
    if (filters.payrollId) where.payrollId = filters.payrollId;

    return prisma.payslip.findMany({
      where,
      include: {
        employee: { include: { user: { select: { fullName: true, email: true } } } },
        payroll: true
      },
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    });
  }

  static async getPayslipById(id: string) {
    return prisma.payslip.findUnique({
      where: { id },
      include: {
        employee: {
          include: {
            user: { select: { fullName: true, email: true, phone: true } },
            salaryStructure: true
          }
        },
        payroll: true
      }
    });
  }

  static async markPayslipPaid(id: string) {
    const payslip = await prisma.payslip.findUnique({
      where: { id },
      include: { employee: { include: { user: true } } }
    });

    if (!payslip) throw new Error('Payslip not found');

    return prisma.$transaction(async (tx) => {
      // 1. Mark payslip as paid
      const updatedPayslip = await tx.payslip.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date() }
      });

      // 2. Record in FinancialPayment (Accounting)
      await tx.financialPayment.create({
        data: {
          entity: payslip.employee.user.fullName,
          entityType: 'EMPLOYEE',
          flowType: 'OUTFLOW',
          amount: payslip.netSalary,
          method: 'BANK_TRANSFER', // Default for payroll
          reference: payslip.id,
          description: `Salary for ${payslip.month}/${payslip.year}`,
          type: 'PAYROLL',
          status: 'PAID',
          date: new Date()
        }
      });

      return updatedPayslip;
    });
  }

  static async createManualPayslip(data: {
    employeeId: string;
    month: number;
    year: number;
    basicSalary: number;
    totalEarnings: number;
    totalDeductions: number;
    netSalary: number;
    otHours?: number;
    otAmount?: number;
    components: any[];
  }) {
    return prisma.payslip.create({
      data,
      include: { employee: { include: { user: { select: { fullName: true } } } } }
    });
  }
}
