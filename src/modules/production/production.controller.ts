import { Request, Response } from 'express';
import { ProductionService } from './production.service';
import { IsolationUtil } from '../../utils/isolation.util';
import { FormulationService } from '../recipes/formulation.service';
import { ProductionCostingService } from './production-costing.service';
import { EXPENSE_BASES } from './production-costing';

// { inventoryItemId: [{ batchId, qty }] } from the request body, validated.
function parseLotAllocations(raw: unknown) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('lotAllocations must map each material to its lots.');
  const out: Record<string, ReturnType<typeof ProductionCostingService.normalizeAllocations>> = {};
  for (const [itemId, list] of Object.entries(raw as Record<string, unknown>)) {
    out[itemId] = ProductionCostingService.normalizeAllocations(list, 'Lot allocation');
  }
  return out;
}

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

  /** Read-only: scaled requirements + warehouse stock for a target yield. */
  static async previewPlan(req: Request, res: Response) {
    try {
      const { recipeId, targetQty, targetUnit, warehouseId } = req.body;
      res.json(await FormulationService.preview({ recipeId, targetQty: Number(targetQty), targetUnit, warehouseId: warehouseId || undefined }));
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
    }
  }

  /**
   * Starts a run from the recipe's saved formulation scaled to a target
   * yield. Resolves to the same startProduction call (quantity = scaling
   * factor) with a frozen snapshot; stock is re-validated server-side there.
   */
  static async startPlanned(req: Request, res: Response) {
    try {
      const { recipeId, formulationId, targetQty, targetUnit, franchiseId, warehouseId, customerId, productionType, expiryDate, operatorId } = req.body;
      if (!warehouseId) return res.status(400).json({ error: 'Select a source warehouse.' });
      const user = (req as any).user;
      const enforcedFranchiseId = await IsolationUtil.enforceFranchiseMatch(user, franchiseId);
      const lotAllocations = parseLotAllocations(req.body.lotAllocations);
      const planned = await FormulationService.buildPlannedStart({ recipeId, formulationId, targetQty: Number(targetQty), targetUnit });

      const result = await ProductionService.startProduction({
        recipeId,
        quantity: planned.quantity,
        franchiseId: enforcedFranchiseId || undefined,
        warehouseId,
        customerId,
        productionType: productionType || 'FINISHED_GOOD',
        expiryDate,
        userId: user?.userId,
        operatorId,
        planning: planned.planning,
        lotAllocations,
      });
      res.status(201).json(result);
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message });
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
      // Completing from the UI must state what was actually produced.
      if (!hasYield) return res.status(400).json({ error: 'Actual produced quantity is required to complete production.' });
      const hasWastage = wastageQty !== undefined && wastageQty !== null && wastageQty !== '';
      const result = await ProductionService.approveProduction(
        req.params.id,
        userId,
        hasYield ? Number(actualYield) : undefined,
        remarks,
        expiryDate || undefined,
        hasWastage ? { quantity: Number(wastageQty), note: wastageNote || undefined } : undefined,
        {
          requireVarianceRemarks: true,
          additionalMaterials: Array.isArray(req.body.additionalMaterials) ? req.body.additionalMaterials : undefined,
        },
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /** Settings the completion dialog needs (variance % above which remarks are required). */
  static async getCompletionSettings(_req: Request, res: Response) {
    try {
      res.json({ varianceRemarksThresholdPct: await ProductionService.getVarianceRemarksThresholdPct() });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /** Production-eligible lots per material in a warehouse (?warehouseId=&itemIds=a,b). */
  static async getLotOptions(req: Request, res: Response) {
    try {
      const warehouseId = String(req.query.warehouseId || '');
      if (!warehouseId) return res.status(400).json({ error: 'warehouseId is required.' });
      const itemIds = String(req.query.itemIds || '').split(',').map(s => s.trim()).filter(Boolean);
      res.json(await ProductionCostingService.getLotOptions(itemIds, warehouseId));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  /** Expense categories and bases for packaging cost entry. */
  static async getCostingSettings(_req: Request, res: Response) {
    try {
      res.json({ categories: await ProductionCostingService.getExpenseCategories(), bases: EXPENSE_BASES });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getBatchCostSummary(req: Request, res: Response) {
    try {
      res.json(await ProductionCostingService.getBatchCostSummary(req.params.id));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  /** Read-only cost of a packaging request (same calculation as Confirm). */
  static async previewPackagingCost(req: Request, res: Response) {
    try {
      const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
      res.json(await ProductionCostingService.previewPackagingCost(
        req.params.id,
        { rows, expenses: req.body.expenses },
        (size, unit) => ProductionService.parseWeight(size, unit),
        (tx, batch, franchiseId) => ProductionService.resolveBulkItem(tx, batch, franchiseId),
      ));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
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
        expenses: req.body.expenses,
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
