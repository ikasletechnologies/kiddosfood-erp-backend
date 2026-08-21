import { Request, Response } from 'express';
import { RecallService } from './recall.service';

// All mutation endpoints return 400 for known business-rule rejections
// (bad eligibility, out-of-order step, invalid quantity) — these are
// expected, user-actionable outcomes, not server failures. Only truly
// unexpected errors would be a 500, but every error this service throws is
// an intentional validation message, so 400 is correct for all of them here.
export class RecallController {
  static async getEligibility(req: Request, res: Response) {
    try {
      const result = await RecallService.checkEligibility(req.params.id);
      if (!result.batch) return res.status(404).json({ error: 'Batch not found.' });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getState(req: Request, res: Response) {
    try {
      const recall = await RecallService.getRecallState(req.params.id);
      res.json(recall);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async initiate(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { reason, reasonNotes } = req.body;
      const recall = await RecallService.initiateRecall(req.params.id, { reason, reasonNotes, userId: user?.userId });
      res.status(201).json(recall);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async locateDistribution(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await RecallService.locateDistribution(req.params.id, user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async blockSales(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await RecallService.blockSales(req.params.id, user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async generateReport(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await RecallService.generateReport(req.params.id, user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async collectReturn(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { returnedQty } = req.body;
      const result = await RecallService.collectReturn(req.params.id, Number(returnedQty), user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async complete(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await RecallService.completeRecall(req.params.id, user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async cancel(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { note } = req.body;
      const result = await RecallService.cancelRecall(req.params.id, note, user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
}
