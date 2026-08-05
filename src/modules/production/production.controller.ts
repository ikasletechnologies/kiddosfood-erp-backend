import { Request, Response } from 'express';
import { ProductionService } from './production.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class ProductionController {
  static async startBatch(req: Request, res: Response) {
    try {
      const { recipeId, quantity, franchiseId, warehouseId, customerId, productionType, expiryDate, operatorId } = req.body;
      const user = (req as any).user;
      const enforcedFranchiseId = IsolationUtil.enforceFranchiseMatch(user, franchiseId);

      const result = await ProductionService.startProduction({
        recipeId,
        quantity: Number(quantity),
        franchiseId: enforcedFranchiseId || undefined,
        warehouseId: warehouseId || undefined,
        customerId,
        productionType,
        expiryDate,
        userId: user?.userId,
        operatorId
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

  static async advanceStage(req: Request, res: Response) {
    try {
      const result = await ProductionService.advanceStage(req.params.id, req.body.stage);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async getStageHistory(req: Request, res: Response) {
    try {
      const result = await ProductionService.getStageHistory(req.params.id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async approveBatch(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.userId;
      const { actualYield, remarks } = req.body;
      const result = await ProductionService.approveProduction(req.params.id, userId, actualYield ? Number(actualYield) : undefined, remarks);
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

  static async inspectBatch(req: Request, res: Response) {
    try {
      const { qcStatus, moistureCheck, colorCheck, textureCheck, rejectionQty } = req.body;
      const user = (req as any).user;
      const result = await ProductionService.inspectBatch({
        batchId: req.params.id,
        qcStatus,
        moistureCheck: moistureCheck !== undefined ? Number(moistureCheck) : undefined,
        colorCheck,
        textureCheck,
        rejectionQty: rejectionQty !== undefined ? Number(rejectionQty) : 0,
        userId: user?.userId
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async packageBatch(req: Request, res: Response) {
    try {
      const { packetSize, quantityPackets } = req.body;
      const user = (req as any).user;
      const result = await ProductionService.packageBatch({
        batchId: req.params.id,
        packetSize,
        quantityPackets: Number(quantityPackets),
        userId: user?.userId
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPendingQC(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const targetFranchiseId = user.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string || undefined)
        : user.franchiseId;
      const result = await ProductionService.getPendingQCBatches(targetFranchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getPackagings(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const targetFranchiseId = user.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string || undefined)
        : user.franchiseId;
      const result = await ProductionService.getPackagings(targetFranchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAllBatches(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const targetFranchiseId = user.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string || undefined)
        : user.franchiseId;
      const result = await ProductionService.getAllProductBatches(targetFranchiseId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
