import { Request, Response } from 'express';
import { GRNService } from './grn.service';
import { InspectionService } from './inspection.service';

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

  static async createFromPO(req: Request, res: Response) {
    try {
      const grn = await GRNService.createFromPO(req.params.poId, req.body);
      res.status(201).json(grn);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async approve(req: Request, res: Response) {
    try {
      const grn = await GRNService.approve(req.params.id);
      res.json(grn);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async cancel(req: Request, res: Response) {
    try {
      const grn = await GRNService.cancel(req.params.id);
      res.json(grn);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
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
