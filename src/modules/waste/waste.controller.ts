import { Request, Response } from 'express';
import { WasteService } from './waste.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class WasteController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const warehouseId = req.query.warehouseId as string | undefined;

      const entries = await WasteService.getAll(
        req.query.dateFrom as string,
        req.query.dateTo as string,
        franchiseId,
        warehouseId
      );
      res.json(entries);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const entry = await WasteService.getById(req.params.id);
      if (!entry) return res.status(404).json({ error: 'Waste entry not found' });
      res.json(entry);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      const warehouseId = req.body.warehouseId as string | undefined;
      const entry = await WasteService.create({ ...req.body, franchiseId, warehouseId });
      res.status(201).json(entry);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const { reason, note } = req.body;
      const entry = await WasteService.update(req.params.id, { reason, note });
      res.json(entry);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async getSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const warehouseId = req.query.warehouseId as string | undefined;
      const summary = await WasteService.getSummary(franchiseId, warehouseId);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
