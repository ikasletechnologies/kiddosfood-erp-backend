import prisma from '../../lib/prisma';

let empCounter = 1000;
function generateEmployeeCode() {
  return `EMP-${String(++empCounter).padStart(4, '0')}`;
}

export class EmployeeService {
  // ─── Employees ───────────────────────────────────────────────────────────────

  static async getAll(filters: { department?: string; search?: string }) {
    const where: any = {};
    if (filters.department) where.department = filters.department;
    if (filters.search) {
      where.OR = [
        { employeeCode: { contains: filters.search, mode: 'insensitive' } },
        { designation: { contains: filters.search, mode: 'insensitive' } },
        { user: { fullName: { contains: filters.search, mode: 'insensitive' } } }
      ];
    }
    return prisma.employee.findMany({
      where,
      include: { user: { select: { id: true, fullName: true, email: true, phone: true } }, salaryStructure: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.employee.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, fullName: true, email: true, phone: true } },
        salaryStructure: { include: { items: { include: { component: true } } } },
        leaves: { include: { leaveType: true }, orderBy: { createdAt: 'desc' }, take: 10 },
        shifts: { include: { shift: true }, orderBy: { date: 'desc' }, take: 30 },
        payslips: { orderBy: { createdAt: 'desc' }, take: 12 }
      }
    });
  }

  static async create(data: {
    userId: string;
    department?: string;
    designation?: string;
    dateOfJoining: string;
    dateOfBirth?: string;
    gender?: string;
    address?: string;
    emergencyContact?: string;
    bankAccount?: string;
    ifscCode?: string;
    panNumber?: string;
    pfNumber?: string;
    esiNumber?: string;
    salaryStructureId?: string;
  }) {
    return prisma.employee.create({
      data: {
        userId: data.userId,
        employeeCode: generateEmployeeCode(),
        department: data.department,
        designation: data.designation,
        dateOfJoining: new Date(data.dateOfJoining),
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
        gender: data.gender,
        address: data.address,
        emergencyContact: data.emergencyContact,
        bankAccount: data.bankAccount,
        ifscCode: data.ifscCode,
        panNumber: data.panNumber,
        pfNumber: data.pfNumber,
        esiNumber: data.esiNumber,
        salaryStructureId: data.salaryStructureId
      },
      include: { user: { select: { id: true, fullName: true, email: true, phone: true } } }
    });
  }

  static async update(id: string, data: Partial<{
    department: string;
    designation: string;
    address: string;
    emergencyContact: string;
    bankAccount: string;
    ifscCode: string;
    panNumber: string;
    pfNumber: string;
    esiNumber: string;
    salaryStructureId: string;
  }>) {
    return prisma.employee.update({
      where: { id },
      data,
      include: { user: { select: { id: true, fullName: true, email: true } } }
    });
  }

  // ─── Leave Types ─────────────────────────────────────────────────────────────

  static async getLeaveTypes() {
    return prisma.leaveType.findMany({ orderBy: { name: 'asc' } });
  }

  static async createLeaveType(data: { name: string; maxDays: number; isPaid?: boolean }) {
    return prisma.leaveType.create({ data });
  }

  static async updateLeaveType(id: string, data: { name?: string; maxDays?: number; isPaid?: boolean }) {
    return prisma.leaveType.update({ where: { id }, data });
  }

  // ─── Leaves ──────────────────────────────────────────────────────────────────

  static async getLeaves(filters: { employeeId?: string; status?: string; leaveTypeId?: string }) {
    const where: any = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.leaveTypeId) where.leaveTypeId = filters.leaveTypeId;
    return prisma.leave.findMany({
      where,
      include: {
        employee: { include: { user: { select: { fullName: true } } } },
        leaveType: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async applyLeave(data: {
    employeeId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    days: number;
    reason: string;
  }) {
    return prisma.leave.create({
      data: {
        employeeId: data.employeeId,
        leaveTypeId: data.leaveTypeId,
        startDate: new Date(data.startDate),
        endDate: new Date(data.endDate),
        days: data.days,
        reason: data.reason
      },
      include: { employee: { include: { user: { select: { fullName: true } } } }, leaveType: true }
    });
  }

  static async approveLeave(id: string, status: 'APPROVED' | 'REJECTED', approvedBy: string) {
    return prisma.leave.update({
      where: { id },
      data: {
        status,
        approvedBy,
        approvedAt: new Date()
      },
      include: { leaveType: true }
    });
  }

  // ─── Shifts ──────────────────────────────────────────────────────────────────

  static async getShifts() {
    return prisma.shift.findMany({ include: { employees: { include: { employee: { include: { user: { select: { fullName: true } } } } } } } });
  }

  static async createShift(data: { name: string; startTime: string; endTime: string }) {
    return prisma.shift.create({ data });
  }

  static async assignShift(data: { employeeId: string; shiftId: string; date: string }) {
    return prisma.employeeShift.create({
      data: {
        employeeId: data.employeeId,
        shiftId: data.shiftId,
        date: new Date(data.date)
      },
      include: { employee: { include: { user: { select: { fullName: true } } } }, shift: true }
    });
  }

  static async getEmployeeShifts(employeeId: string) {
    return prisma.employeeShift.findMany({
      where: { employeeId },
      include: { shift: true },
      orderBy: { date: 'desc' }
    });
  }
}
