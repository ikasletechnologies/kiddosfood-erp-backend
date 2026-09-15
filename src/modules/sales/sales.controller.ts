import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
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

  static async convertProformaToSalesOrder(req: Request, res: Response) {
    try {
      const result = await SalesService.convertProformaToSalesOrder(req.params.id, (req as any).user?.userId || 'system');
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  // ─── Return Orders ───────────────────────────────────────────────────────────

  static async getReturnOrders(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const isSuperAdmin = user?.role === 'SUPER_ADMIN';
      const returns = await SalesService.getReturnOrders({
        status: req.query.status as string,
        customerId: req.query.customerId as string,
        dealerId: req.query.dealerId as string,
        franchiseId: isSuperAdmin ? (req.query.franchiseId as string | undefined) : undefined,
        operatingFranchiseId: !isSuperAdmin ? user?.franchiseId : (req.query.operatingFranchiseId as string | undefined),
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
      const user = (req as any).user;
      const isSuperAdmin = user?.role === 'SUPER_ADMIN';

      if (!isSuperAdmin) {
        if (!user?.franchiseId) {
          return res.status(403).json({ error: 'Franchise context required to create return' });
        }
        if (!req.body.posOrderId) {
          return res.status(400).json({ error: 'A valid sales invoice reference (posOrderId) is required to create a return' });
        }

        const sourceOrder = await prisma.order.findUnique({
          where: { id: req.body.posOrderId },
          include: { customer: true }
        });

        if (!sourceOrder) {
          return res.status(404).json({ error: 'Sale invoice not found' });
        }

        if (sourceOrder.franchiseId !== user.franchiseId) {
          return res.status(403).json({ error: 'Access denied: Invoice does not belong to your franchise' });
        }

        if (sourceOrder.partyType === 'FRANCHISE') {
          return res.status(400).json({ error: 'Cannot create a sales return against an HQ procurement invoice' });
        }

        if (sourceOrder.status === 'CANCELLED') {
          return res.status(400).json({ error: 'Cannot create a return against a cancelled invoice' });
        }

        // Sanitize: remove any forged party/order IDs
        delete req.body.franchiseId;
        delete req.body.franchiseOrderId;
        delete req.body.salesOrderId;

        if (sourceOrder.partyType === 'DEALER') {
          req.body.dealerId = sourceOrder.partyId || req.body.dealerId;
        } else if (sourceOrder.partyType === 'CUSTOMER') {
          req.body.customerId = sourceOrder.customerId || req.body.customerId;
        }
      }

      const returnOrder = await SalesService.createReturnOrder(req.body);
      res.status(201).json(returnOrder);
    } catch (error: any) {
      const msg = error?.message || 'Failed to create return order';
      const isBusinessError = /cannot return|maximum returnable|greater than zero|already returned|not found|integrity/i.test(msg);
      res.status(isBusinessError ? 400 : 500).json({ error: msg });
    }
  }

  static async updateReturnOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const approverId = user?.userId;

      if (user?.role !== 'SUPER_ADMIN') {
        const existing = await prisma.returnOrder.findUnique({
          where: { id: req.params.id },
          include: { posOrder: true }
        });
        if (!existing) return res.status(404).json({ error: 'Return order not found' });
        if (existing.posOrder?.franchiseId !== user?.franchiseId) {
          return res.status(403).json({ error: 'Access denied: Return order does not belong to your franchise' });
        }
      }

      const returnOrder = await SalesService.updateReturnOrder(req.params.id, { ...req.body, approvedBy: approverId });
      res.json(returnOrder);
    } catch (error: any) {
      const msg = error?.message || 'Failed to update return order';
      res.status(400).json({ error: msg });
    }
  }

  // Phase 2: actually moves money/ledger/state for an approved return.
  // Only refundMethod/accountId/method are read from the body — amount/
  // rate/discount/gst are never accepted here; SalesService.recordRefund
  // reads the refund amount exclusively from the already-correct
  // ReturnOrder.refundAmount established at createReturnOrder time.
  static async refundReturnOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const createdBy = user?.userId;

      if (user?.role !== 'SUPER_ADMIN') {
        const existing = await prisma.returnOrder.findUnique({
          where: { id: req.params.id },
          include: { posOrder: true }
        });
        if (!existing) return res.status(404).json({ error: 'Return order not found' });
        if (existing.posOrder?.franchiseId !== user?.franchiseId) {
          return res.status(403).json({ error: 'Access denied: Return order does not belong to your franchise' });
        }

        if (req.body?.accountId) {
          const account = await prisma.account.findUnique({ where: { id: req.body.accountId } });
          if (account && account.franchiseId !== user?.franchiseId) {
            return res.status(403).json({ error: 'Access denied: Account does not belong to your franchise' });
          }
        }
      }

      const result = await SalesService.recordRefund(req.params.id, {
        refundMethod: req.body?.refundMethod,
        accountId: req.body?.accountId,
        method: req.body?.method,
        createdBy
      });
      res.json(result);
    } catch (error: any) {
      const msg = error?.message || 'Failed to process refund';
      res.status(400).json({ error: msg });
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

  static async convertDeliveryChallanToSale(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId || 'system';
      const result = await SalesService.convertDeliveryChallanToSale(req.params.id, userId);
      res.json(result);
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
