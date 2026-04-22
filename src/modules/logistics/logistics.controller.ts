import { Request, Response } from 'express';
import { LogisticsService } from './logistics.service';

export class LogisticsController {
  /**
   * --- STOCK REQUESTS ---
   */
  static async createRequest(req: Request, res: Response) {
    try {
      const result = await LogisticsService.createRequest({
        ...req.body,
        userId: (req as any).user?.id
      });
      res.status(201).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async approveRequest(req: Request, res: Response) {
    try {
      const { approvedItems } = req.body;
      const result = await LogisticsService.approveRequest(
        req.params.id, 
        approvedItems, 
        (req as any).user?.id
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRequests(req: Request, res: Response) {
    try {
      const franchiseId = req.query.franchiseId as string;
      const result = await LogisticsService.getRequests(franchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * --- STOCK TRANSFERS ---
   */
  static async initiateTransfer(req: Request, res: Response) {
    try {
      const result = await LogisticsService.initiateTransfer({
        ...req.body,
        userId: (req as any).user?.id
      });
      res.status(201).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async completeTransfer(req: Request, res: Response) {
    try {
      const result = await LogisticsService.completeTransfer(
        req.params.id, 
        (req as any).user?.id
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getTransfers(req: Request, res: Response) {
    try {
      const franchiseId = req.query.franchiseId as string;
      const result = await LogisticsService.getTransfers(franchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
