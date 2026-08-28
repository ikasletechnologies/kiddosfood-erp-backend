import { Request, Response } from 'express';
import { SystemSetupService } from './setup.service';
import { WarehouseService } from '../warehouse/warehouse.service';

export class SetupController {
  static async getStatus(req: Request, res: Response) {
    try {
      const status = await SystemSetupService.getSetupStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // Deliberately accepts only { name, code?, location? } — HQ is resolved
  // server-side (FranchiseService.getHqFranchise, via WarehouseService),
  // never trusted from the browser. Idempotent: safe to call again after
  // it already succeeded (double-click, refresh, revisiting /setup).
  static async createWarehouse(req: Request, res: Response) {
    try {
      const { name, code, location } = req.body;
      const warehouse = await WarehouseService.createHqWarehouse({ name, code, location });
      res.status(201).json(warehouse);
    } catch (error: any) {
      const isValidationError = /required|already exists|no franchise is marked/i.test(error.message || '');
      res.status(isValidationError ? 400 : 500).json({ error: error.message });
    }
  }
}
