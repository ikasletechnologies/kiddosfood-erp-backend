import { Request, Response } from 'express';
import { FinanceService } from './finance.service';
import { PaymentService } from './payment.service';

export class FinanceController {
  static async getPL(req: Request, res: Response) {
    try {
      const { franchiseId, startDate, endDate } = req.query;
      const report = await FinanceService.getFinancialReport({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async addExpense(req: Request, res: Response) {
    try {
      const expense = await FinanceService.addExpense(req.body);
      res.status(201).json(expense);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getInvoices(req: Request, res: Response) {
    try {
      const { franchiseId } = req.query;
      const invoices = await FinanceService.getInvoices(franchiseId as string);
      res.json(invoices);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalesReport(req: Request, res: Response) {
    try {
      const { franchiseId, startDate, endDate } = req.query;
      const report = await FinanceService.getFinancialReport({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json({ totalSales: report.revenue, generatedAt: report.generatedAt });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpensesReport(req: Request, res: Response) {
    try {
      const { franchiseId, startDate, endDate } = req.query;
      const report = await FinanceService.getFinancialReport({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json({ totalExpenses: report.expenses, generatedAt: report.generatedAt });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Unified Payments (Hybrid Payment Engine) ───────────────────────────────

  static async getAllPayments(req: Request, res: Response) {
    try {
      const { entityType, flowType, type, search } = req.query;
      const payments = await PaymentService.getAll({
        entityType: entityType as string,
        flowType: flowType as string,
        type: type as string,
        search: search as string
      });
      res.json(payments);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async recordPayment(req: Request, res: Response) {
    try {
      const payment = await PaymentService.recordPayment(req.body);
      res.status(201).json(payment);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPaymentById(req: Request, res: Response) {
    try {
      const payment = await PaymentService.getById(req.params.id);
      if (!payment) return res.status(404).json({ error: 'Payment not found' });
      res.json(payment);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPaymentStats(req: Request, res: Response) {
    try {
      const stats = await PaymentService.getStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
