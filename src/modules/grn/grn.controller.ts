import { Request, Response } from 'express';
import { GRNService } from './grn.service';
import { InspectionService } from './inspection.service';
import { actorFromUser } from '../../lib/audit-log';

// A concurrent insert of the same manual GRN number surfaces as Prisma P2002.
const isDuplicateGrnNumber = (e: any) => e?.code === 'P2002' && JSON.stringify(e?.meta || {}).includes('grnNumber');
const grnErrorStatus = (e: any) => (isDuplicateGrnNumber(e) ? 409 : e?.statusCode || 400);
const grnErrorMessage = (e: any) => (isDuplicateGrnNumber(e) ? 'GRN number already exists.' : e?.message);

export class GRNController {
  static async getAll(req: Request, res: Response) {
    try {
      const data = await GRNService.getAll(req.query as any);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const data = await GRNService.getById(req.params.id);
      if (!data) return res.status(404).json({ error: 'GRN not found' });
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async generateLotNumber(req: Request, res: Response) {
    try {
      const lotNumber = await GRNService.generateLotNumber();
      res.json({ lotNumber });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRemainingQuantities(req: Request, res: Response) {
    try {
      const data = await GRNService.getRemainingQuantities(req.params.poId);
      res.json(data);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async createFromPO(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const grn = await GRNService.createFromPO(req.params.poId, {
        ...req.body,
        performedBy: user?.email || user?.userId,
        user
      });
      res.status(201).json(grn);
    } catch (error: any) {
      res.status(grnErrorStatus(error)).json({ error: grnErrorMessage(error) });
    }
  }

  /**
   * POST /api/purchase-orders/:poId/grns
   * Body: { grnNumber?, vendorId?, purchaseOrderId?, receivedAt?, post? (default true),
   *         rejectionReason?, items: [{ poItemId, productId?, receivedQty, rejectedQty?, price?, ... }] }
   * post=true creates and posts the GRN in one transaction; post=false saves a draft.
   */
  static async receiveAgainstPO(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const body = req.body || {};
      const post = !(body.post === false || String(body.status || '').toUpperCase() === 'DRAFT');
      const result = await GRNService.receiveAgainstPO(
        req.params.poId,
        { ...body, performedBy: user?.email || user?.userId, user },
        { post, rejectionReason: body.rejectionReason, user }
      );
      res.status(201).json(result);
    } catch (error: any) {
      res.status(grnErrorStatus(error)).json({ error: grnErrorMessage(error) });
    }
  }

  static async getPOPendingItems(req: Request, res: Response) {
    try {
      res.json(await GRNService.getPendingItems(req.params.poId));
    } catch (error: any) {
      res.status(grnErrorStatus(error)).json({ error: error.message });
    }
  }

  static async getPOGRNs(req: Request, res: Response) {
    try {
      res.json(await GRNService.getGRNsForPO(req.params.poId));
    } catch (error: any) {
      res.status(grnErrorStatus(error)).json({ error: error.message });
    }
  }

  static async getPOSummary(req: Request, res: Response) {
    try {
      res.json(await GRNService.getPOSummary(req.params.poId));
    } catch (error: any) {
      res.status(grnErrorStatus(error)).json({ error: error.message });
    }
  }

  static async approve(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const grn = await GRNService.approve(req.params.id, user, { rejectionReason: req.body?.rejectionReason });
      res.json(grn);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async cancel(req: Request, res: Response) {
    try {
      const grn = await GRNService.cancel(req.params.id, { reason: req.body?.reason, actor: actorFromUser((req as any).user) });
      res.json(grn);
    } catch (error: any) {
      res.status(error.statusCode || 400).json({ error: error.message });
    }
  }

  static async getPendingInspections(req: Request, res: Response) {
    try {
      const data = await InspectionService.getPendingInspections();
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async recordInspection(req: Request, res: Response) {
    try {
      const data = await InspectionService.recordInspection(req.body);
      res.json(data);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
