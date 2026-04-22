import { Request, Response } from 'express';
import { PayrollService } from './payroll.service';

export class PayrollController {
  // ─── Salary Components ───────────────────────────────────────────────────────

  static async getComponents(req: Request, res: Response) {
    try {
      const components = await PayrollService.getComponents();
      res.json(components);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createComponent(req: Request, res: Response) {
    try {
      const component = await PayrollService.createComponent(req.body);
      res.status(201).json(component);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateComponent(req: Request, res: Response) {
    try {
      const component = await PayrollService.updateComponent(req.params.id, req.body);
      res.json(component);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Salary Structures ───────────────────────────────────────────────────────

  static async getStructures(req: Request, res: Response) {
    try {
      const structures = await PayrollService.getStructures();
      res.json(structures);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getStructure(req: Request, res: Response) {
    try {
      const structure = await PayrollService.getStructureById(req.params.id);
      if (!structure) return res.status(404).json({ error: 'Structure not found' });
      res.json(structure);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createStructure(req: Request, res: Response) {
    try {
      const structure = await PayrollService.createStructure(req.body);
      res.status(201).json(structure);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateStructure(req: Request, res: Response) {
    try {
      const structure = await PayrollService.updateStructure(req.params.id, req.body);
      res.json(structure);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Payroll Processing ──────────────────────────────────────────────────────

  static async getPayrolls(req: Request, res: Response) {
    try {
      const payrolls = await PayrollService.getPayrolls();
      res.json(payrolls);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createPayroll(req: Request, res: Response) {
    try {
      const payroll = await PayrollService.createPayroll(req.body);
      res.status(201).json(payroll);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async processPayroll(req: Request, res: Response) {
    try {
      const result = await PayrollService.processPayroll(req.params.id);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Payslips ────────────────────────────────────────────────────────────────

  static async getPayslips(req: Request, res: Response) {
    try {
      const payslips = await PayrollService.getPayslips({
        employeeId: req.query.employeeId as string,
        month: req.query.month ? Number(req.query.month) : undefined,
        year: req.query.year ? Number(req.query.year) : undefined,
        payrollId: req.query.payrollId as string
      });
      res.json(payslips);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPayslip(req: Request, res: Response) {
    try {
      const payslip = await PayrollService.getPayslipById(req.params.id);
      if (!payslip) return res.status(404).json({ error: 'Payslip not found' });
      res.json(payslip);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async markPaid(req: Request, res: Response) {
    try {
      const payslip = await PayrollService.markPayslipPaid(req.params.id);
      res.json(payslip);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createManualPayslip(req: Request, res: Response) {
    try {
      const payslip = await PayrollService.createManualPayslip(req.body);
      res.status(201).json(payslip);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
