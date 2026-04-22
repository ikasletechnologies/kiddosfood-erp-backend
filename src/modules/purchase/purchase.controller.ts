import { Request, Response } from 'express';
import { PurchaseService } from './purchase.service';

export class PurchaseController {
  // ─── RFQ ─────────────────────────────────────────────────────────────────────

  static async getRFQs(req: Request, res: Response) {
    try {
      const rfqs = await PurchaseService.getRFQs({
        vendorId: req.query.vendorId as string,
        status: req.query.status as string,
        search: req.query.search as string
      });
      res.json(rfqs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRFQ(req: Request, res: Response) {
    try {
      const rfq = await PurchaseService.getRFQById(req.params.id);
      if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
      res.json(rfq);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createRFQ(req: Request, res: Response) {
    try {
      const createdBy = (req as any).user?.id;
      const rfq = await PurchaseService.createRFQ({ ...req.body, createdBy });
      res.status(201).json(rfq);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateRFQ(req: Request, res: Response) {
    try {
      const rfq = await PurchaseService.updateRFQ(req.params.id, req.body);
      res.json(rfq);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async convertRFQtoPO(req: Request, res: Response) {
    try {
      const po = await PurchaseService.convertRFQtoPO(req.params.id);
      res.status(201).json(po);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Purchase Returns ────────────────────────────────────────────────────────

  static async getPurchaseReturns(req: Request, res: Response) {
    try {
      const returns = await PurchaseService.getPurchaseReturns({
        vendorId: req.query.vendorId as string,
        status: req.query.status as string,
        search: req.query.search as string
      });
      res.json(returns);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createPurchaseReturn(req: Request, res: Response) {
    try {
      const ret = await PurchaseService.createPurchaseReturn(req.body);
      res.status(201).json(ret);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updatePurchaseReturn(req: Request, res: Response) {
    try {
      const ret = await PurchaseService.updatePurchaseReturn(req.params.id, req.body);
      res.json(ret);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // ─── Purchase Requisition ────────────────────────────────────────────────────

  static async createRequisition(req: Request, res: Response) {
    try {
      const req_ = await PurchaseService.createRequisition(req.body);
      res.status(201).json(req_);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
