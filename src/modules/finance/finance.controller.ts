import { Request, Response } from 'express';
import { FinanceService } from './finance.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class FinanceController {
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
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getInventoryValue(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const report = await FinanceService.getInventoryValuationReport(franchiseId);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getCashFlow(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId !== undefined ? franchiseFilter.franchiseId : (req.query.franchiseId as string || null);
      const report = await FinanceService.getCashFlow(franchiseId);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getLedgerSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string || franchiseFilter.franchiseId)
        : franchiseFilter.franchiseId;

      const { startDate, endDate } = req.query;
      const summary = await FinanceService.getLedgerSummary({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalesReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const { startDate, endDate, customerId, paymentStatus, page, limit } = req.query;

      const report = await FinanceService.getSalesReportDetails({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        customerId: customerId as string,
        paymentStatus: paymentStatus as string,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPurchasesReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const { startDate, endDate, vendorId, status, search, page, limit } = req.query;

      const report = await FinanceService.getPurchasesReportDetails({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        vendorId: vendorId as string,
        status: status as string,
        search: search as string,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getDayBookReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const { startDate, endDate, paymentMode, voucherType, page, limit } = req.query;

      const report = await FinanceService.getDayBookReport({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        paymentMode: paymentMode as string,
        voucherType: voucherType as string,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTransactionsReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const { startDate, endDate, type, status, page, limit } = req.query;

      const report = await FinanceService.getFinancialTransactionsReport({
        franchiseId: franchiseId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        type: type as string,
        status: status as string,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpensesReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, category } = req.query;
      const report = await FinanceService.getExpensesReportData(
        franchiseId,
        startDate as string,
        endDate as string,
        category as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getGstReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getGstReportData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getGstRateReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getGstRateReportData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTcsReceivable(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getTcsReceivableData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTdsPayable(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getTdsPayableData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTdsReceivable(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getTdsReceivableData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getForm27eq(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getForm27eqData(franchiseId, startDate as string, endDate as string);
      res.json(report);
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

  static async createInvoice(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);

      const invoice = await FinanceService.createInvoice({
        ...req.body,
        franchiseId,
        createdBy: user?.fullName || user?.email || 'System'
      });
      res.status(201).json(invoice);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpenses(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const expenses = await FinanceService.getExpenses(franchiseId, startDate as string, endDate as string);
      res.json({ expenses });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpenseDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const expense = await FinanceService.getExpenseDetails(id);
      res.json(expense);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async recordExpensePayment(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const user = (req as any).user;
      const result = await FinanceService.recordExpensePayment(id, {
        ...req.body,
        createdBy: user?.fullName || user?.email || 'System'
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async cancelExpense(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const user = (req as any).user;
      const result = await FinanceService.cancelExpense(id, user?.fullName || user?.email || 'System');
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async addExpense(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);

      const expense = await FinanceService.addExpense({ ...req.body, franchiseId });
      res.status(201).json(expense);
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
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);

      const payment = await FinanceService.createPayment({
        ...req.body, 
        franchiseId,
        createdBy: user?.fullName || user?.email || 'System'
      });
      res.status(201).json(payment);
    } catch (error: any) {
      if (error.statusCode === 400 || error.code || (error.message && (
        error.message.startsWith('Insufficient') ||
        error.message.startsWith('Invalid payment') ||
        error.message.startsWith('No ') ||
        error.message.startsWith('Please ') ||
        error.message.includes('account')
      ))) {
        return res.status(400).json({
          statusCode: 400,
          code: error.code || 'BAD_REQUEST',
          message: error.message
        });
      }
      res.status(500).json({ statusCode: 500, message: error.message });
    }
  }

  static async transferFunds(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await FinanceService.transferFunds({
        ...req.body,
        createdBy: user?.fullName || user?.email || 'System'
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async cancelPayment(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { id } = req.params;
      const result = await FinanceService.cancelPayment(id, user?.fullName || user?.email || 'System');
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async getTrialBalance(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getTrialBalanceReport({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getBalanceSheet(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getBalanceSheetReport({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getBillWiseProfit(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getBillWiseProfitReport({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAccountTransactionSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { accountName, startDate, endDate } = req.query;
      if (!accountName) {
        return res.status(400).json({ error: 'accountName query parameter is required' });
      }
      const report = await FinanceService.getAccountTransactionSummary({
        franchiseId,
        accountName: accountName as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPartyStatement(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { customerId, startDate, endDate } = req.query;
      const report = await FinanceService.getPartyStatement({
        franchiseId,
        customerId: customerId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPartyProfitLoss(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getPartyProfitLoss({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPartyReportByItem(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getPartyReportByItem({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalePurchaseByParty(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getSalePurchaseByParty({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAllPartiesReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, fromDate, toDate, partyType, search, datasetType } = req.query;
      if (datasetType && !['RECEIVABLE', 'PAYABLE'].includes(datasetType as string)) {
        return res.status(400).json({ error: "Invalid datasetType. Must be 'RECEIVABLE' or 'PAYABLE'." });
      }
      const report = await FinanceService.getAllPartiesData(
        franchiseId,
        (startDate as string) || (fromDate as string),
        (endDate as string) || (toDate as string),
        {
          partyType: partyType as any,
          search: search as string,
          datasetType: datasetType as any
        }
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPartyInvoices(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { partyType, partyId } = req.query;

      if (!partyType || !partyId) {
        return res.status(400).json({ error: 'partyType and partyId are required.' });
      }
      if (!['CUSTOMER', 'DEALER', 'FRANCHISE'].includes(partyType as string)) {
        return res.status(400).json({ error: 'Invalid partyType. Must be CUSTOMER, DEALER, or FRANCHISE.' });
      }

      const invoices = await FinanceService.getPartyInvoices({
        franchiseId,
        partyType: partyType as 'CUSTOMER' | 'DEALER' | 'FRANCHISE',
        partyId: partyId as string
      });
      res.json(invoices);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getLoans(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const loans = await FinanceService.getLoans({ franchiseId });
      res.json(loans);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async addLoan(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.body.franchiseId as string);

      const { accountName, accountNumber, lenderName, loanType, principalAmount, interestRate, loanDate } = req.body;
      const loan = await FinanceService.addLoanAccount({
        franchiseId,
        accountName,
        accountNumber,
        lenderName,
        loanType,
        principalAmount: Number(principalAmount || 0),
        interestRate: Number(interestRate || 0),
        loanDate: loanDate ? new Date(loanDate as string) : new Date()
      });
      res.json(loan);
    } catch (error: any) {
      res.status(550).json({ error: error.message });
    }
  }

  static async getLoanStatement(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const { loanAccountId, startDate, endDate } = req.query;
      const statement = await FinanceService.getLoanStatement({
        franchiseId,
        loanAccountId: loanAccountId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(statement);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async addLoanTransaction(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.body.franchiseId as string);

      const { id } = req.params;
      const { type, amount, date, note } = req.body;
      const result = await FinanceService.addLoanTransaction({
        franchiseId,
        loanAccountId: id,
        type,
        amount: Number(amount || 0),
        date: date ? new Date(date as string) : new Date(),
        note
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Item / Stock Reports ───────────────────────────────────────────────────

  static async getStockSummaryReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const category = (req.query.category as string) || undefined;
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

      const report = await FinanceService.getStockSummaryData(franchiseId, { category, startDate, endDate });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getLowStockSummaryReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const report = await FinanceService.getLowStockSummaryData(franchiseId);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getItemProfitLossReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getItemWiseProfitLoss(
        franchiseId,
        startDate as string,
        endDate as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getItemCategoryProfitLossReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getItemCategoryWiseProfitLoss(
        franchiseId,
        startDate as string,
        endDate as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getItemByPartyReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getPartyReportByItem({
        franchiseId,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getItemDiscountReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getItemDiscountReportData(
        franchiseId,
        startDate as string,
        endDate as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalePurchaseByCategoryReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getSalePurchaseByCategoryData(
        franchiseId,
        startDate as string,
        endDate as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getStockByCategoryReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const report = await FinanceService.getStockByCategoryData(franchiseId);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getStockDetailReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getStockDetailData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getItemDetailReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { itemName, startDate, endDate } = req.query;

      const report = await FinanceService.getItemDetailData(franchiseId, itemName as string, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
  static async getBankStatement(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { accountId, startDate, endDate } = req.query;

      const report = await FinanceService.getBankStatementData(
        franchiseId,
        accountId as string,
        startDate as string,
        endDate as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getDiscountReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;

      const report = await FinanceService.getDiscountReportData(
        franchiseId,
        startDate as string,
        endDate as string
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getGSTR1Report(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, partyId, gstRate } = req.query;
      const report = await FinanceService.getGSTR1Data({ franchiseId, startDate, endDate, partyId, gstRate });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getGSTR2Report(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, partyId, gstRate } = req.query;
      const report = await FinanceService.getGSTR2Data({ franchiseId, startDate, endDate, partyId, gstRate });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getGSTR3BReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getGSTR3BData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getGSTR9Report(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { financialYear } = req.query;
      const report = await FinanceService.getGSTR9Data(franchiseId, financialYear as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getHsnSummaryReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, partyId, gstRate } = req.query;
      const report = await FinanceService.getHsnSummaryData({ franchiseId, startDate, endDate, partyId, gstRate });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSacReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, partyId, gstRate } = req.query;
      const report = await FinanceService.getSacReportData({ franchiseId, startDate, endDate, partyId, gstRate });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalePurchaseByPartyGroup(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getSalePurchaseByPartyGroupData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSalePurchaseByItemReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getSalePurchaseByItemData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getStockSummaryByItemReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const report = await FinanceService.getStockSummaryByItemData(franchiseId);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getProductionReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getProductionReportData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getInventoryLedgerReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { itemId, startDate, endDate, page, pageSize } = req.query;
      const report = await FinanceService.getInventoryLedgerReportData(
        franchiseId,
        itemId as string,
        startDate as string,
        endDate as string,
        page ? parseInt(page as string, 10) : undefined,
        pageSize ? parseInt(pageSize as string, 10) : undefined
      );
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpenseCategoryReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getExpenseCategoryReportData(franchiseId, startDate as string, endDate as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getExpenseItemReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, category } = req.query;
      const report = await FinanceService.getExpenseItemReportData(franchiseId, startDate as string, endDate as string, category as string);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSaleOrdersReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate, status } = req.query;
      const report = await FinanceService.getSaleOrdersReportData({ franchiseId, startDate: startDate as string, endDate: endDate as string, status: status as string });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getSaleOrderItemsReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { startDate, endDate } = req.query;
      const report = await FinanceService.getSaleOrderItemsReportData({ franchiseId, startDate: startDate as string, endDate: endDate as string });
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getFranchiseReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const report = await FinanceService.getFranchiseReportData(franchiseId);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
