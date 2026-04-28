import { Request, Response } from 'express';
import { ProductionService } from './production.service';

export class ProductionController {
  static async startBatch(req: Request, res: Response) {
    try {
      const { recipeId, quantity, franchiseId, targetInventoryItemId, productionType } = req.body;
      const result = await ProductionService.startProduction({
        recipeId,
        quantity: Number(quantity),
        franchiseId,
        targetInventoryItemId,
        productionType,
        userId: (req as unknown as { user: { id: string } }).user?.id
      });
      res.status(201).json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getHistory(req: Request, res: Response) {
    try {
      const franchiseId = req.query.franchiseId as string;
      const history = await ProductionService.getProductionHistory(franchiseId);
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const batch = await ProductionService.getBatchById(req.params.id);
      if (!batch) return res.status(404).json({ error: 'Production batch not found' });
      res.json(batch);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const { status } = req.body;
      const result = await ProductionService.updateStatus(req.params.id, status);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
