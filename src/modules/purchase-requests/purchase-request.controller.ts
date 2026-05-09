import { Request, Response } from 'express';
import { PurchaseRequestService } from './purchase-request.service';

export class PurchaseRequestController {
  static async getAll(req: Request, res: Response) {
    try {
      const filters = {
        status: req.query.status as string,
        department: req.query.department as string,
        search: req.query.search as string
      };
      const requests = await PurchaseRequestService.getRequests(filters);
      res.json(requests);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const pr = await PurchaseRequestService.getRequestById(req.params.id);
      if (!pr) return res.status(404).json({ error: 'Not found' });
      res.json(pr);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const pr = await PurchaseRequestService.createRequest({
        ...req.body,
        requestedBy: (req as any).user?.fullName || req.body.requestedBy
      });
      res.status(201).json(pr);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const approvedBy = (req as any).user?.fullName;
      const pr = await PurchaseRequestService.updateStatus(req.params.id, req.body.status, approvedBy);
      res.json(pr);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }

  static async deleteRequest(req: Request, res: Response) {
    try {
      await PurchaseRequestService.deleteRequest(req.params.id);
      res.json({ message: 'Deleted successfully' });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
}
