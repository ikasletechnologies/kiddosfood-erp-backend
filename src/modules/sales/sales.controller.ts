import { Request, Response } from 'express';
import { SalesService } from './sales.service';

export class SalesController {
  // ─── Quotations ──────────────────────────────────────────────────────────────

  static async getQuotations(req: Request, res: Response) {
    try {
      const quotations = await SalesService.getQuotations({
        status: req.query.status as string,
        customerId: req.query.customerId as string,
        search: req.query.search as string,
        fromDate: (req.query.fromDate || req.query.startDate) as string,
        toDate: (req.query.toDate || req.query.endDate) as string,
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

  static async convertQuotation(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const result = await SalesService.convertQuotationToSalesOrder(req.params.id, createdBy, req.body);
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async convertQuotationToSalesOrder(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const result = await SalesService.convertQuotationToSalesOrder(req.params.id, createdBy, req.body);
      res.status(201).json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async convertQuotationToSale(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const result = await SalesService.convertQuotationToSale(req.params.id, createdBy, req.body);
      res.status(201).json(result);
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

  // Sales Order -> Sale Invoice (Tax Invoice).
  static async convertSalesOrderToSale(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.userId;
      const result = await SalesService.convertSalesOrderToSale(req.params.id, createdBy, req.body);
      res.status(201).json(result);
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
        search: req.query.search as string,
        fromDate: (req.query.fromDate || req.query.startDate) as string,
        toDate: (req.query.toDate || req.query.endDate) as string,
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

  static async createProformaInvoice(req: Request, res: Response) {
    try {
      const data = { ...req.body, createdBy: (req as any).user?.userId };
      const proforma = await SalesService.createProformaInvoice(data);
      res.status(201).json(proforma);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async updateProformaInvoice(req: Request, res: Response) {
    try {
      const proforma = await SalesService.updateProformaInvoice(req.params.id, req.body);
      res.json(proforma);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async updateProformaStatus(req: Request, res: Response) {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'Status is required' });
      const proforma = await SalesService.updateProformaStatus(req.params.id, status);
      res.json(proforma);
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

  // Business-rule rejections (dedup checks, stock/quantity guards, invalid
  // transitions) are client-fixable — 400, not 500 — so the frontend shows
  // the actual message instead of a generic failure toast.
  private static isDcBusinessError(message: string): boolean {
    return /can only have one destination|not found|Cannot dispatch|Cannot return|Cannot change status|remains undispatched|Insufficient approved stock|Select at least one item|must be greater than zero|Dispatched .* already returned|hasn't dispatched yet|Only an IN_TRANSIT/i.test(message);
  }

  static async createDeliveryChallan(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId || 'system';
      const challan = await SalesService.createDeliveryChallan(req.body, userId);
      res.status(201).json(challan);
    } catch (error) {
      const message = (error as Error).message;
      res.status(SalesController.isDcBusinessError(message) ? 400 : 500).json({ error: message });
    }
  }

  static async updateDeliveryChallan(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId || 'system';
      const challan = await SalesService.updateDeliveryChallan(req.params.id, req.body, userId);
      res.json(challan);
    } catch (error) {
      const message = (error as Error).message;
      res.status(SalesController.isDcBusinessError(message) ? 400 : 500).json({ error: message });
    }
  }

  static async markDeliveryChallanDelivered(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId || 'system';
      const challan = await SalesService.markChallanDelivered(req.params.id, req.body, userId);
      res.json(challan);
    } catch (error) {
      const message = (error as Error).message;
      res.status(SalesController.isDcBusinessError(message) ? 400 : 500).json({ error: message });
    }
  }

  static async getTransitStock(req: Request, res: Response) {
    try {
      res.json(await SalesService.getTransitStock());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getDispatchTracking(req: Request, res: Response) {
    try {
      res.json(await SalesService.getDispatchTracking({ status: req.query.status as string }));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getDeliveryChallanReturns(req: Request, res: Response) {
    try {
      res.json(await SalesService.getDeliveryChallanReturns({ challanId: req.query.challanId as string }));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async createDeliveryChallanReturn(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId || 'system';
      const ret = await SalesService.createDeliveryChallanReturn(req.body, userId);
      res.status(201).json(ret);
    } catch (error) {
      const message = (error as Error).message;
      res.status(SalesController.isDcBusinessError(message) ? 400 : 500).json({ error: message });
    }
  }

  static async receiveDeliveryChallanReturn(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId || 'system';
      const ret = await SalesService.receiveDeliveryChallanReturn(req.params.id, req.body.itemConditions || [], userId);
      res.json(ret);
    } catch (error) {
      const message = (error as Error).message;
      res.status(SalesController.isDcBusinessError(message) ? 400 : 500).json({ error: message });
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
