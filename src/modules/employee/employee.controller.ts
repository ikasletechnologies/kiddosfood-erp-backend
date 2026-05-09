import { Request, Response } from 'express';
import { EmployeeService } from './employee.service';

export class EmployeeController {
  // ─── Employees ───────────────────────────────────────────────────────────────

  static async getAll(req: Request, res: Response) {
    try {
      const employees = await EmployeeService.getAll({
        department: req.query.department as string,
        search: req.query.search as string
      });
      res.json(employees);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const employee = await EmployeeService.getById(req.params.id);
      if (!employee) return res.status(404).json({ error: 'Employee not found' });
      res.json(employee);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const employee = await EmployeeService.create(req.body);
      res.status(201).json(employee);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const employee = await EmployeeService.update(req.params.id, req.body);
      res.json(employee);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  // ─── Leave Types ─────────────────────────────────────────────────────────────

  static async getLeaveTypes(req: Request, res: Response) {
    try {
      const types = await EmployeeService.getLeaveTypes();
      res.json(types);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async createLeaveType(req: Request, res: Response) {
    try {
      const type = await EmployeeService.createLeaveType(req.body);
      res.status(201).json(type);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async updateLeaveType(req: Request, res: Response) {
    try {
      const type = await EmployeeService.updateLeaveType(req.params.id, req.body);
      res.json(type);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  // ─── Leaves ──────────────────────────────────────────────────────────────────

  static async getLeaves(req: Request, res: Response) {
    try {
      const leaves = await EmployeeService.getLeaves({
        employeeId: req.query.employeeId as string,
        status: req.query.status as string,
        leaveTypeId: req.query.leaveTypeId as string
      });
      res.json(leaves);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async applyLeave(req: Request, res: Response) {
    try {
      const leave = await EmployeeService.applyLeave(req.body);
      res.status(201).json(leave);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async approveLeave(req: Request, res: Response) {
    try {
      const approverId = (req as any).user?.id;
      const { status } = req.body;
      const leave = await EmployeeService.approveLeave(req.params.id, status, approverId);
      res.json(leave);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  // ─── Shifts ──────────────────────────────────────────────────────────────────

  static async getShifts(req: Request, res: Response) {
    try {
      const shifts = await EmployeeService.getShifts();
      res.json(shifts);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async createShift(req: Request, res: Response) {
    try {
      const shift = await EmployeeService.createShift(req.body);
      res.status(201).json(shift);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async assignShift(req: Request, res: Response) {
    try {
      const assignment = await EmployeeService.assignShift(req.body);
      res.status(201).json(assignment);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }

  static async getEmployeeShifts(req: Request, res: Response) {
    try {
      const shifts = await EmployeeService.getEmployeeShifts(req.params.id);
      res.json(shifts);
    } catch (error: any) {
      const status = error.statusCode || 500;
      res.status(status).json({ error: error.message });
    }
  }
}
