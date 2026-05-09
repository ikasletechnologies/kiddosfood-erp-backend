import { Request, Response } from 'express';
import { ProductionService } from './production.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class ProductionController {
  static async startBatch(req: Request, res: Response) {
    try {
      const { recipeId, quantity, franchiseId, customerId, productionType, expiryDate } = req.body;
      const user = (req as any).user;
      const enforcedFranchiseId = IsolationUtil.enforceFranchiseMatch(user, franchiseId);

      const result = await ProductionService.startProduction({
        recipeId,
        quantity: Number(quantity),
        franchiseId: enforcedFranchiseId as string,
        customerId,
        productionType,
        expiryDate,
        userId: user?.id
      });
      res.status(201).json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getHistory(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = (user.role === 'SUPER_ADMIN' ? req.query.franchiseId : franchiseFilter.franchiseId) as string;
      
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

  static async stopBatch(req: Request, res: Response) {
    try {
      const result = await ProductionService.stopProduction(req.params.id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async approveBatch(req: Request, res: Response) {
    try {
      const userId = (req as unknown as { user: { id: string } }).user?.id;
      const result = await ProductionService.approveProduction(req.params.id, userId);
      res.json(result);
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
