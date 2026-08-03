import { Request, Response } from 'express';
import { InventoryService } from './inventory.service';
import { IsolationUtil } from '../../utils/isolation.util';
import prisma from '../../lib/prisma';

export class InventoryController {
  static async getInventory(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId ?? (req.query.franchiseId as string | undefined);

      // For SUPER_ADMIN without franchiseId, fetch the first available franchise to avoid empty screen
      if (!franchiseId) {
        const franchises = await prisma.franchise.findMany({ take: 1 });
        const defaultId = franchises[0]?.id || 'hq-001';
        const items = await InventoryService.getInventory(defaultId);
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
        userId: (req as any).user?.userId
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
        userId: (req as any).user?.userId
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
        userId: (req as any).user?.userId
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getReconciliationSheet(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      if (!franchiseId) return res.status(400).json({ error: 'franchiseId is required' });

      const sheet = await InventoryService.getReconciliationSheet(franchiseId);
      res.json(sheet);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async submitReconciliation(req: Request, res: Response) {
    try {
      const { entries } = req.body;
      const results = await InventoryService.submitReconciliation(entries, (req as any).user?.userId);
      res.json(results);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
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
  static async getWarehouses(req: Request, res: Response) {
    try {
      const warehouses = await prisma.warehouse.findMany({
        orderBy: { name: 'asc' }
      });
      res.json(warehouses);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getWarehouseStock(req: Request, res: Response) {
    try {
      const report = await InventoryService.getWarehouseStockReport(req.params.id);
      res.json(report);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async createWarehouse(req: Request, res: Response) {
    try {
      const { name, location, type } = req.body;
      const warehouse = await prisma.warehouse.create({
        data: { name, location, type }
      });
      res.status(201).json(warehouse);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateWarehouse(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { name, location, type } = req.body;
      const warehouse = await prisma.warehouse.update({
        where: { id },
        data: { name, location, type }
      });
      res.json(warehouse);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteWarehouse(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await prisma.warehouse.delete({
        where: { id }
      });
      res.json({ message: 'Warehouse deleted successfully' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRawMaterialStockSummary(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      let franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      if (!franchiseId) {
        const franchises = await prisma.franchise.findMany({ take: 1 });
        franchiseId = franchises[0]?.id || 'hq-001';
      }

      const summary = await InventoryService.getRawMaterialStockSummary(franchiseId);
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRawMaterialConsumption(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      let franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      if (!franchiseId) {
        const franchises = await prisma.franchise.findMany({ take: 1 });
        franchiseId = franchises[0]?.id || 'hq-001';
      }

      const consumption = await InventoryService.getRawMaterialConsumption(franchiseId);
      res.json(consumption);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRawMaterialLedger(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      let franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const { itemId } = req.query;

      if (!franchiseId) {
        const franchises = await prisma.franchise.findMany({ take: 1 });
        franchiseId = franchises[0]?.id || 'hq-001';
      }

      const ledger = await InventoryService.getRawMaterialLedger(franchiseId, itemId as string | undefined);
      res.json(ledger);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

