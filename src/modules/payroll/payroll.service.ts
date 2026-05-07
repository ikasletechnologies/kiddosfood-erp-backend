import prisma from '../../lib/prisma';
import { FinanceService } from '../finance/finance.service';

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

    const employees = await prisma.employee.findMany({
      include: {
        salaryStructure: { include: { items: { include: { component: true } } } },
        leaves: {
          where: {
            status: 'APPROVED',
            startDate: { gte: new Date(payroll.year, payroll.month - 1, 1) },
            endDate: { lte: new Date(payroll.year, payroll.month, 0) }
          },
          include: { leaveType: true }
        }
      }
    });

    const payslips: object[] = [];

    for (const emp of employees) {
      if (!emp.salaryStructure) continue;

      const components: Array<{ name: string; type: string; amount: number }> = [];
      let totalEarnings = 0;
      let totalDeductions = 0;
      let basicSalary = 0;

      for (const item of emp.salaryStructure.items) {
        const comp = item.component;
        const value = item.overrideValue ?? comp.value;
        let amount = value;

        if (comp.calculationType === 'PERCENTAGE' && basicSalary > 0) {
          amount = (basicSalary * value) / 100;
        }

        if (comp.name.toLowerCase() === 'basic') basicSalary = amount;

        components.push({ name: comp.name, type: comp.type, amount });

        if (comp.type === 'EARNING') totalEarnings += amount;
        else totalDeductions += amount;
      }

      const netSalary = totalEarnings - totalDeductions;

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
            basicSalary,
            totalEarnings,
            totalDeductions,
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

  static async markPayslipPaid(id: string, accountId: string, paidBy?: string) {
    if (!accountId) throw new Error('Source Account ID is required for payroll payments.');

    return prisma.$transaction(async (tx) => {
      const payslip = await tx.payslip.findUnique({ 
        where: { id },
        include: { employee: { include: { user: true } } }
      });
      if (!payslip) throw new Error('Payslip not found');
      if (payslip.status === 'PAID') throw new Error('Payslip is already paid');

      // 1. Central Payment & Account Adjustment
      await FinanceService.createPayment({
        tx,
        amount: payslip.netSalary,
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: accountId,
        method: 'BANK_TRANSFER', // Default for salary
        sourceModule: 'PAYROLL',
        linkedDocType: 'PAYSLIP',
        linkedDocId: payslip.id,
        entityType: 'EMPLOYEE',
        entityId: payslip.employeeId,
        createdBy: paidBy || 'PAYROLL_SYSTEM'
      });

      // 2. Update Payslip status
      return tx.payslip.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date() }
      });
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
