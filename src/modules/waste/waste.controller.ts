import { Request, Response } from 'express';
import { WasteService } from './waste.service';

export class WasteController {
  static async getAll(req: Request, res: Response) {
    try {
      const entries = await WasteService.getAll(
        req.query.dateFrom as string,
        req.query.dateTo as string
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
      const entry = await WasteService.create(req.body);
      res.status(201).json(entry);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getSummary(req: Request, res: Response) {
    try {
      const summary = await WasteService.getSummary();
      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
