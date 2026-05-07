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
      const { startDate, endDate, detailed } = req.query;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      if (detailed === 'true') {
        const report = await FinanceService.getProfitAndLoss({
          franchiseId,
          startDate: startDate ? new Date(startDate as string) : undefined,
          endDate: endDate ? new Date(endDate as string) : undefined
        });
        return res.json(report);
      }

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

  static async getCashFlow(req: Request, res: Response) {
    try {
      const report = await FinanceService.getCashFlow();
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

  static async getExpenses(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const expenses = await FinanceService.getExpenses(franchiseId);
      res.json({ expenses });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPayments(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const payments = await FinanceService.getPayments(franchiseId);
      res.json({ payments });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async recordPayment(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      
      const payment = await FinanceService.createPayment({ ...req.body, franchiseId });
      res.status(201).json(payment);
    } catch (error: any) {
      // Business-rule violations (insufficient balance, bad direction, missing account)
      // are expected errors — return 400 with the message so the UI can display it.
      const isBusinessError = error.message && (
        error.message.startsWith('Insufficient') ||
        error.message.startsWith('Invalid payment') ||
        error.message.startsWith('No ') ||
        error.message.includes('account found')
      );
      res.status(isBusinessError ? 400 : 500).json({ error: error.message });
    }
  }
}
