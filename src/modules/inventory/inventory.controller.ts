import { Request, Response } from 'express';
import { InventoryService } from './inventory.service';
import { IsolationUtil } from '../../utils/isolation.util';
import prisma from '../../lib/prisma';

function normalizeWarehouseName(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class InventoryController {
  static async getInventory(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId ?? (req.query.franchiseId as string | undefined);

      const category = req.query.category as string | undefined;

      // SUPER_ADMIN with no franchiseId means "global": every franchise's
      // stock, HQ and branches alike. Do NOT default to a single franchise
      // here — that would silently convert a global request into a
      // single-branch one. FRANCHISE_ADMIN always has franchiseId forced by
      // IsolationUtil above, so this only ever runs unscoped for SUPER_ADMIN.
      const items = await InventoryService.getInventory(franchiseId, false, undefined, category as any);
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
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Warehouse name is required' });
      }

      // Warehouse selection elsewhere in the app is name-driven (dropdowns,
      // stock lookups) — a near-duplicate name like "Home (Hopes)" next to
      // "Home" silently splits stock across two records with no way to tell
      // them apart. `nameKey` carries a DB-level unique constraint (see
      // schema) so this is enforced even under concurrent requests, not just
      // by this pre-check — the pre-check only exists to give a friendlier
      // error than a raw constraint violation in the common (non-racing) case.
      const nameKey = normalizeWarehouseName(name);
      const clash = await prisma.warehouse.findUnique({ where: { nameKey } });
      if (clash) {
        return res.status(400).json({ error: `A warehouse named "${clash.name}" already exists. Use that one instead of creating a near-duplicate.` });
      }

      const warehouse = await prisma.warehouse.create({
        data: { name: name.trim(), nameKey, location, type }
      });
      res.status(201).json(warehouse);
    } catch (error: any) {
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'A warehouse with that name already exists.' });
      }
      res.status(500).json({ error: error.message });
    }
  }

  static async updateWarehouse(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { name, location, type } = req.body;

      let nameKey: string | undefined;
      if (name !== undefined) {
        if (!name.trim()) {
          return res.status(400).json({ error: 'Warehouse name is required' });
        }
        nameKey = normalizeWarehouseName(name);
        const clash = await prisma.warehouse.findUnique({ where: { nameKey } });
        if (clash && clash.id !== id) {
          return res.status(400).json({ error: `A warehouse named "${clash.name}" already exists. Use that one instead of creating a near-duplicate.` });
        }
      }

      const warehouse = await prisma.warehouse.update({
        where: { id },
        data: { name: name !== undefined ? name.trim() : undefined, nameKey, location, type }
      });
      res.json(warehouse);
    } catch (error: any) {
      if (error.code === 'P2002') {
        return res.status(400).json({ error: 'A warehouse with that name already exists.' });
      }
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
      // No franchise = no filter (see everything), same rule raw-materials.controller.ts
      // already uses — previously this substituted an arbitrary franchise
      // instead, which silently hid stock that lives under a different one.
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string) || undefined;
      const warehouseId = (req.query.warehouseId as string) || undefined;
      const category = (req.query.category as any) || undefined;

      const summary = await InventoryService.getRawMaterialStockSummary(warehouseId, franchiseId, category);
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getRawMaterialConsumption(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string) || undefined;
      const warehouseId = (req.query.warehouseId as string) || undefined;
      const category = (req.query.category as any) || undefined;

      const consumption = await InventoryService.getRawMaterialConsumption(warehouseId, franchiseId, category);
      res.json(consumption);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // Chronological ledger across every item category by default (Raw
  // Material, Packaging, Semi-Finished, Finished Good) — pass ?category=
  // to narrow it back down to one, same as the old raw-materials-only view.
  static async getRawMaterialLedger(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      // No franchise = no filter (see everything) for SUPER_ADMIN — same rule
      // as getInventory/getRawMaterialStockSummary above. Previously this
      // substituted HQ (or any franchise) instead, silently hiding every
      // other branch's movements from a "global" ledger request.
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string) || undefined;
      const { itemId, category } = req.query;

      const ledger = await InventoryService.getInventoryLedger(
        franchiseId,
        itemId as string | undefined,
        category as any
      );
      res.json(ledger);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}

