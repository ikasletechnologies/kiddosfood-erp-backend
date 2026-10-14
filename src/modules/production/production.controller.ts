import { Request, Response } from 'express';
import { ProductionService } from './production.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class ProductionController {
  static async startBatch(req: Request, res: Response) {
    try {
      const { recipeId, quantity, franchiseId, warehouseId, customerId, productionType, expiryDate, operatorId } = req.body;
      const user = (req as any).user;
      const enforcedFranchiseId = await IsolationUtil.enforceFranchiseMatch(user, franchiseId);

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
      const startDate = (req.query.startDate || req.query.dateFrom) as string | undefined;
      const endDate = (req.query.endDate || req.query.dateTo) as string | undefined;
      const status = req.query.status as string | undefined;
      
      const history = await ProductionService.getProductionHistory(franchiseId, startDate, endDate, status);
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
      const { actualYield, remarks, expiryDate, wastageQty, wastageNote } = req.body;
      // An explicit 0 / negative / non-numeric yield is passed through so the
      // service rejects it — previously a 0 silently became the expected yield.
      const hasYield = actualYield !== undefined && actualYield !== null && actualYield !== '';
      const hasWastage = wastageQty !== undefined && wastageQty !== null && wastageQty !== '';
      const result = await ProductionService.approveProduction(
        req.params.id,
        userId,
        hasYield ? Number(actualYield) : undefined,
        remarks,
        expiryDate || undefined,
        hasWastage ? { quantity: Number(wastageQty), note: wastageNote || undefined } : undefined,
      );
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
      const { moistureCheck, colorCheck, textureCheck, rejectionQty, qcRemarks } = req.body;
      const user = (req as any).user;
      const result = await ProductionService.inspectBatch({
        batchId: req.params.id,
        moistureCheck: moistureCheck !== undefined ? Number(moistureCheck) : undefined,
        colorCheck,
        textureCheck,
        rejectionQty: rejectionQty !== undefined ? Number(rejectionQty) : 0,
        qcRemarks,
        userId: user?.userId
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // Phase 1 of two-phase packaging — creates an AWAITING_CONFIRMATION
  // ticket only. Bulk stock and Finished Goods are untouched until
  // confirmPackaging below.
  static async startPackaging(req: Request, res: Response) {
    try {
      const { packetSize, quantityPackets, productId, newProduct } = req.body;
      const user = (req as any).user;
      const result = await ProductionService.startPackaging({
        batchId: req.params.id,
        packetSize,
        quantityPackets: Number(quantityPackets),
        productId: productId ? String(productId) : undefined,
        newProduct,
        userId: user?.userId
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // Phase 2 — the operator reports the real good/damaged/spoiled split for
  // the completed physical packaging run; only now does bulk get deducted
  static async savePackagingVerification(req: Request, res: Response) {
    try {
      const { stickersPrinted, physicalChecked, goodQty, damagedQty, spoiledQty } = req.body;
      const result = await ProductionService.savePackagingVerification({
        packagingId: req.params.id,
        stickersPrinted: Number(stickersPrinted),
        physicalChecked: Boolean(physicalChecked),
        goodQty: Number(goodQty),
        damagedQty: Number(damagedQty),
        spoiledQty: Number(spoiledQty)
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // Phase 2 of packaging: physical verification is complete, bulk gets deducted
  // and Finished Goods get created.
  static async confirmPackaging(req: Request, res: Response) {
    try {
      const { goodQty, damagedQty, spoiledQty, productId } = req.body;
      const user = (req as any).user;
      const result = await ProductionService.confirmPackaging({
        packagingId: req.params.id,
        goodQty: Number(goodQty),
        damagedQty: Number(damagedQty),
        spoiledQty: Number(spoiledQty),
        productId: productId ? String(productId) : undefined,
        userId: user?.userId
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // Simplified workflow: pick pack size + product, enter packed and damaged
  // packets, confirm once — reserves bulk, credits Finished Goods and records
  // damage wastage in one transaction.
  static async packageAndConfirm(req: Request, res: Response) {
    try {
      const { rows, packetSize, packedQty, damagedQty, productId, newProduct, expectedPackagedQty } = req.body;
      const user = (req as any).user;
      if (rows !== undefined && !Array.isArray(rows)) {
        return res.status(400).json({ error: 'rows must be an array of pack sizes.' });
      }
      const result = await ProductionService.packageAndConfirm({
        batchId: req.params.id,
        // Multi-size form: one entry per pack size / SKU.
        rows: Array.isArray(rows)
          ? rows.map((r: any) => ({
              packetSize: String(r?.packetSize ?? ''),
              packedQty: Number(r?.packedQty),
              damagedQty: Number(r?.damagedQty) || 0,
              productId: r?.productId ? String(r.productId) : undefined,
              newProduct: r?.newProduct,
            }))
          : undefined,
        packetSize,
        packedQty: Number(packedQty),
        damagedQty: Number(damagedQty) || 0,
        productId: productId ? String(productId) : undefined,
        newProduct,
        expectedPackagedQty: expectedPackagedQty !== undefined && expectedPackagedQty !== null ? Number(expectedPackagedQty) : undefined,
        userId: user?.userId,
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // Releases a legacy batch (completed while QC was still required, never
  // inspected) to packaging now that production QC is switched off.
  static async releaseToPackaging(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await ProductionService.releaseBatchToPackaging(req.params.id, user?.userId);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async cancelPackaging(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { reason } = req.body || {};
      const result = await ProductionService.cancelPackaging({
        packagingId: req.params.id,
        userId: user?.userId,
        reason,
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async wasteBalance(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { note } = req.body || {};
      const result = await ProductionService.wasteBalance({
        batchId: req.params.id,
        userId: user?.userId,
        note,
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message, stack: error.stack });
    }
  }

  static async getPendingQC(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const targetFranchiseId = user.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string || undefined)
        : user.franchiseId;
      const startDate = (req.query.startDate || req.query.dateFrom) as string | undefined;
      const endDate = (req.query.endDate || req.query.dateTo) as string | undefined;
      const qcStatus = req.query.qcStatus as string | undefined;

      const result = await ProductionService.getPendingQCBatches(targetFranchiseId, startDate, endDate, qcStatus);
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
