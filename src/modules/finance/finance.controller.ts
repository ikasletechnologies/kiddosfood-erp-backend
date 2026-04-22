import { Request, Response } from 'express';
import { FinanceService } from './finance.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class FinanceController {
  static async addExpense(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      
      const expense = await FinanceService.addExpense({ ...req.body, franchiseId });
      res.status(201).json(expense);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPL(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { startDate, endDate } = req.query;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const report = await FinanceService.getFinancialReport({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalesReport(req: Request, res: Response) {
    try {
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getFinancialReport({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json({ totalSales: report.revenue });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpensesReport(req: Request, res: Response) {
    try {
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getFinancialReport({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json({ totalExpenses: report.expenses });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getInvoices(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const invoices = await FinanceService.getInvoices(franchiseId);
      res.json(invoices);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
