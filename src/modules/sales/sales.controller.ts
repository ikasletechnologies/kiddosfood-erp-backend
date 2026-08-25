import { Request, Response } from 'express';
import { SalesService } from './sales.service';

export class SalesController {
  // ─── Quotations ──────────────────────────────────────────────────────────────

  static async getQuotations(req: Request, res: Response) {
    try {
      const quotations = await SalesService.getQuotations({
        status: req.query.status as string,
        customerId: req.query.customerId as string,
        search: req.query.search as string
      });
      res.json(quotations);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getQuotation(req: Request, res: Response) {
    try {
      const quotation = await SalesService.getQuotationById(req.params.id);
      if (!quotation) return res.status(404).json({ error: 'Quotation not found' });
      res.json(quotation);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async createQuotation(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const quotation = await SalesService.createQuotation({ ...req.body, createdBy });
      res.status(201).json(quotation);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async updateQuotation(req: Request, res: Response) {
    try {
      const quotation = await SalesService.updateQuotation(req.params.id, req.body);
      res.json(quotation);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async deleteQuotation(req: Request, res: Response) {
    try {
      await SalesService.deleteQuotation(req.params.id);
      res.json({ message: 'Quotation deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  // Estimate -> Sales Order (not a Tax Invoice — see SalesService's chain
  // comment for why this used to skip straight there).
  static async convertQuotation(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const salesOrder = await SalesService.convertQuotationToSalesOrder(req.params.id, createdBy, req.body);
      res.status(201).json(salesOrder);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  // ─── Sales Orders ────────────────────────────────────────────────────────────

  static async getSalesOrders(req: Request, res: Response) {
    try {
      const orders = await SalesService.getSalesOrders({
        status: req.query.status as string,
        customerId: req.query.customerId as string,
        search: req.query.search as string,
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string
      });
      res.json(orders);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getSalesOrder(req: Request, res: Response) {
    try {
      const order = await SalesService.getSalesOrderById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Sales order not found' });
      res.json(order);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async createSalesOrder(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const order = await SalesService.createSalesOrder({ ...req.body, createdBy });
      res.status(201).json(order);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async updateSalesOrder(req: Request, res: Response) {
    try {
      const order = await SalesService.updateSalesOrder(req.params.id, req.body);
      res.json(order);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  // Sales Order -> Proforma Invoice.
  static async convertSalesOrder(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const proforma = await SalesService.convertSalesOrderToProforma(req.params.id, createdBy);
      res.status(201).json(proforma);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  // ─── Proforma Invoices ───────────────────────────────────────────────────────

  static async getProformaInvoices(req: Request, res: Response) {
    try {
      const proformas = await SalesService.getProformaInvoices({
        status: req.query.status as string,
        customerId: req.query.customerId as string,
        search: req.query.search as string
      });
      res.json(proformas);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getProformaInvoice(req: Request, res: Response) {
    try {
      const proforma = await SalesService.getProformaInvoiceById(req.params.id);
      if (!proforma) return res.status(404).json({ error: 'Proforma Invoice not found' });
      res.json(proforma);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  // Proforma Invoice -> Tax Invoice.
  static async convertProformaInvoice(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const invoiceOrder = await SalesService.convertProformaToInvoice(req.params.id, createdBy);
      res.status(201).json(invoiceOrder);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  // ─── Return Orders ───────────────────────────────────────────────────────────

  static async getReturnOrders(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = user.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string | undefined)
        : user.franchiseId;
      const returns = await SalesService.getReturnOrders({
        status: req.query.status as string,
        customerId: req.query.customerId as string,
        franchiseId,
        source: req.query.source as any,
        search: req.query.search as string
      });
      res.json(returns);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async createReturnOrder(req: Request, res: Response) {
    try {
      const returnOrder = await SalesService.createReturnOrder(req.body);
      res.status(201).json(returnOrder);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async updateReturnOrder(req: Request, res: Response) {
    try {
      const approverId = (req as any).user?.userId;
      const returnOrder = await SalesService.updateReturnOrder(req.params.id, { ...req.body, approvedBy: approverId });
      res.json(returnOrder);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  // ─── Delivery Challans ───────────────────────────────────────────────────────

  static async getDeliveryChallans(req: Request, res: Response) {
    try {
      const challans = await SalesService.getDeliveryChallans({
        customerId: req.query.customerId as string,
        status: req.query.status as string,
        search: req.query.search as string
      });
      res.json(challans);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getDeliveryChallan(req: Request, res: Response) {
    try {
      const challan = await SalesService.getDeliveryChallanById(req.params.id);
      if (!challan) return res.status(404).json({ error: 'Delivery challan not found' });
      res.json(challan);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async createDeliveryChallan(req: Request, res: Response) {
    try {
      const challan = await SalesService.createDeliveryChallan(req.body);
      res.status(201).json(challan);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async updateDeliveryChallan(req: Request, res: Response) {
    try {
      const challan = await SalesService.updateDeliveryChallan(req.params.id, req.body);
      res.json(challan);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  static async getAnalytics(req: Request, res: Response) {
    try {
      const analytics = await SalesService.getSalesAnalytics({
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string
      });
      res.json(analytics);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
