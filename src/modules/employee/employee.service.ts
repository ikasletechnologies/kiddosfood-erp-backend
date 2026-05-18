import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { AuthService } from '../auth/auth.service';

async function generateEmployeeCode() {
  const lastEmp = await prisma.employee.findFirst({
    orderBy: { employeeCode: 'desc' },
    select: { employeeCode: true }
  });
  
  let nextNum = 1001;
  if (lastEmp?.employeeCode) {
    const lastNum = parseInt(lastEmp.employeeCode.split('-')[1]);
    if (!isNaN(lastNum)) {
      nextNum = lastNum + 1;
    }
  }
  
  return `EMP-${String(nextNum).padStart(4, '0')}`;
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

  static async create(data: any) {
    return await prisma.$transaction(async (tx) => {
      let userId = data.userId;

      // 1. If no userId provided, create a new User account for the employee
      if (!userId || userId.trim() === '' || userId === 'null' || userId === 'undefined') {
        const passwordHash = await AuthService.hashPassword('emp123');

        const newUser = await tx.user.create({
          data: {
            fullName: data.fullName,
            email: data.personalEmail || `${data.employeeCode.toLowerCase()}@kiddosfood.com`,
            phone: data.mobile,
            passwordHash,
            role: 'FRANCHISE_ADMIN',
            is_active: true
          }
        });
        userId = newUser.id;
      }

      // 2. Check if user already has an employee record
      const existing = await tx.employee.findUnique({
        where: { userId }
      });

      if (existing) {
        throw new AppError('User already has an employee profile', 400);
      }

      // 3. Generate Unique Employee Code
      const employeeCode = data.employeeCode || await generateEmployeeCode();

      // 4. Create Record
      return tx.employee.create({
        data: {
          userId,
          employeeCode,
          department: data.department,
          designation: data.designation,
          dateOfJoining: data.dateOfJoining ? new Date(data.dateOfJoining) : new Date(),
          dateOfBirth: data.dob ? new Date(data.dob) : (data.dateOfBirth ? new Date(data.dateOfBirth) : null),
          gender: data.gender,
          address: data.address,
          
          // Detailed Profile Info
          personalEmail: data.personalEmail,
          mobile: data.mobile,
          altMobile: data.altMobile,
          emergencyContactName: data.emergencyContactName,
          emergencyContactPhone: data.emergencyContactPhone,
          bloodGroup: data.bloodGroup,
          maritalStatus: data.maritalStatus,
          aadhaarNumber: data.aadhaarNumber,
          
          // Address Details
          permDoorNo: data.permDoorNo,
          permStreet: data.permStreet,
          permArea: data.permArea,
          permCity: data.permCity,
          permDistrict: data.permDistrict,
          permState: data.permState,
          permPincode: data.permPincode,
          currentCity: data.currentCity,
          currentState: data.currentState,
          currentPincode: data.currentPincode,
          
          // Bank Details
          bankAccountHolder: data.bankAccountHolder,
          bankName: data.bankName,
          bankBranch: data.bankBranch,
          bankAccount: data.bankAccount,
          ifscCode: data.ifscCode,
          upiId: data.upiId,
          
          // Identity & Verification
          panNumber: data.panNumber,
          verificationStatus: data.verificationStatus,
          
          // Salary & Payroll Details
          salary: data.salary,
          salaryType: data.salaryType,
          allowances: data.allowances ? Number(data.allowances) : 0,
          incentives: data.incentives ? Number(data.incentives) : 0,
          isOvertimeEligible: data.isOvertimeEligible === true || data.isOvertimeEligible === 'true',
          paymentMethod: data.paymentMethod,
          salaryCreditDate: data.salaryCreditDate,
          pfNumber: data.pfNumber,
          esiNumber: data.esiNumber,
          
          // Work Information
          reportingManager: data.reportingManager,
          shiftTiming: data.shiftTiming,
          workLocation: data.workLocation,
          employeeType: data.employeeType,
          
          // Access Permissions
          hasErpAccess: data.hasErpAccess === true || data.hasErpAccess === 'true',
          hasAttendanceAccess: data.hasAttendanceAccess === true || data.hasAttendanceAccess === 'true',
          hasPayrollAccess: data.hasPayrollAccess === true || data.hasPayrollAccess === 'true',
          hasLeaveAccess: data.hasLeaveAccess === true || data.hasLeaveAccess === 'true',
          
          salaryStructureId: data.salaryStructureId
        },
        include: { user: { select: { id: true, fullName: true, email: true, phone: true } } }
      });
    });
  }

  static async update(id: string, data: any) {
    // Handle date fields if they exist
    const updateData: any = { ...data };
    if (data.dateOfJoining) updateData.dateOfJoining = new Date(data.dateOfJoining);
    if (data.dob) updateData.dateOfBirth = new Date(data.dob);
    if (data.dateOfBirth) updateData.dateOfBirth = new Date(data.dateOfBirth);
    
    // Ensure numbers are handled correctly
    if (data.salary) updateData.salary = Number(data.salary);
    if (data.allowances) updateData.allowances = Number(data.allowances);
    if (data.incentives) updateData.incentives = Number(data.incentives);
    
    // Clean up internal fields that shouldn't be in the direct update if they came from a spread
    delete updateData.id;
    delete updateData.userId;
    delete updateData.user;
    delete updateData.dob; // replaced by dateOfBirth

    return prisma.employee.update({
      where: { id },
      data: updateData,
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
