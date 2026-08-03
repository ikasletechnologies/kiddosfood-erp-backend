import { Request, Response } from 'express';
import { WasteService } from './waste.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class WasteController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const entries = await WasteService.getAll(
        req.query.dateFrom as string,
        req.query.dateTo as string,
        franchiseId
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
      const entry = await WasteService.create({ ...req.body, franchiseId });
      res.status(201).json(entry);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async getSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const summary = await WasteService.getSummary(franchiseId);
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
