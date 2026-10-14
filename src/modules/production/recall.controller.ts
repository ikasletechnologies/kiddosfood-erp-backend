import { Request, Response } from 'express';
import { RecallService, RECALL_SEVERITIES } from './recall.service';

// All mutation endpoints return 400 for known business-rule rejections
// (bad eligibility, out-of-order step, invalid quantity) — these are
// expected, user-actionable outcomes, not server failures. Only truly
// unexpected errors would be a 500, but every error this service throws is
// an intentional validation message, so 400 is correct for all of them here.
export class RecallController {
  static async getEligibility(req: Request, res: Response) {
    try {
      const result = await RecallService.checkEligibility(req.params.id);
      if (!result.batch) {
        // /api/production/batches also lists GRN raw-material lots
        // (InventoryBatch). Recall acts on production batches (distribution,
        // sales blocking, outlet returns), so say so instead of "not found".
        const { default: prisma } = await import('../../lib/prisma');
        const rawLot = await prisma.inventoryBatch.findUnique({ where: { id: req.params.id }, select: { lotNumber: true, batchNumber: true } });
        if (rawLot) {
          return res.status(422).json({
            error: `${rawLot.lotNumber || rawLot.batchNumber || 'This lot'} is a raw-material lot received through GRN. Batch Recall applies to production batches — recall the production batches made from it, or return the lot to the vendor through Purchase Returns.`,
          });
        }
        return res.status(404).json({ error: 'Batch not found.' });
      }
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
      const { reason, reasonNotes, severity, description } = req.body;
      // The Batch Recall screen always sends severity + description; both are
      // mandatory for a recall raised through the API.
      if (!RECALL_SEVERITIES.includes(severity)) {
        return res.status(400).json({ error: `Select a severity: ${RECALL_SEVERITIES.join(', ')}.` });
      }
      if (typeof description !== 'string' || description.trim().length < 10) {
        return res.status(400).json({ error: 'Describe the issue (at least 10 characters).' });
      }
      const recall = await RecallService.initiateRecall(req.params.id, { reason, reasonNotes, severity, description, userId: user?.userId });
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
      const { returnedQty, inventoryBatchId, warehouseId, note } = req.body;
      const result = await RecallService.collectReturn(req.params.id, Number(returnedQty), user?.userId, inventoryBatchId ? { inventoryBatchId: String(inventoryBatchId), warehouseId: warehouseId || undefined, note } : undefined);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async complete(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const result = await RecallService.completeRecall(req.params.id, user?.userId, req.body?.note);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async getDetails(req: Request, res: Response) {
    try {
      const result = await RecallService.getRecallDetails(req.params.id);
      if (!result) return res.status(404).json({ error: 'Batch not found.' });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async list(_req: Request, res: Response) {
    try {
      res.json(await RecallService.listRecalls());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async quarantineSummary(_req: Request, res: Response) {
    try {
      res.json(await RecallService.quarantineSummary());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async dispose(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { inventoryBatchId, quantity, note } = req.body || {};
      const result = await RecallService.disposeStock(req.params.id, { inventoryBatchId: String(inventoryBatchId || ''), quantity: Number(quantity), note }, user?.userId);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async reconcile(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { lines, notes } = req.body || {};
      const result = await RecallService.reconcileRecall(req.params.id, {
        lines: Array.isArray(lines) ? lines.map((l: any) => ({ inventoryItemId: String(l?.inventoryItemId || ''), unavailableQty: Number(l?.unavailableQty) || 0 })) : [],
        notes,
      }, user?.userId);
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
