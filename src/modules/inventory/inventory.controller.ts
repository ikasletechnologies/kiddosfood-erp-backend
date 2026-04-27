import { Request, Response } from 'express';
import { InventoryService } from './inventory.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class InventoryController {
  static async getInventory(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId ?? (req.query.franchiseId as string | undefined);

      // SUPER_ADMIN without franchiseId filter returns HQ inventory by default
      if (!franchiseId) {
        const items = await InventoryService.getInventory('hq-001');
        return res.json(items);
      }

      const items = await InventoryService.getInventory(franchiseId);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getItem(req: Request, res: Response) {
    try {
      const item = await InventoryService.getItemById(req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createItem(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      
      const item = await InventoryService.createItem({ ...req.body, franchiseId });
      res.status(201).json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async stockIn(req: Request, res: Response) {
    try {
      const { itemId, quantity, type, note } = req.body;
      const result = await InventoryService.stockIn({
        itemId,
        quantity,
        type,
        note,
        userId: (req as any).user?.id
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async stockOut(req: Request, res: Response) {
    try {
      const { itemId, quantity, type, note } = req.body;
      const result = await InventoryService.stockOut({
        itemId,
        quantity,
        type,
        note,
        userId: (req as any).user?.id
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async adjustment(req: Request, res: Response) {
    try {
      const { itemId, newQuantity, note } = req.body;
      const result = await InventoryService.adjustStock({
        itemId,
        newQuantity,
        note,
        userId: (req as any).user?.id
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getMovements(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { itemId, type } = req.query;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const filters: any = {};
      if (itemId) filters.itemId = itemId;
      if (type) filters.movementType = type;
      if (franchiseId) filters.item = { franchiseId };

      const movements = await InventoryService.getMovements(filters);
      res.json(movements);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getAlerts(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const alerts = await InventoryService.getAlerts(franchiseId);
      res.json(alerts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
