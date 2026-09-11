import { Request, Response } from 'express';
import { WarehouseService } from './warehouse.service';
import { IsolationUtil } from '../../utils/isolation.util';
import prisma from '../../lib/prisma';

// FRANCHISE_ADMIN may only act on their own franchise's primary warehouse —
// throws if the given warehouseId isn't it. No-op for SUPER_ADMIN (global).
async function assertWarehouseAccess(user: any, warehouseId: string) {
  const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
  if (!franchiseFilter.franchiseId) return; // SUPER_ADMIN — unrestricted
  const franchise = await prisma.franchise.findUnique({
    where: { id: franchiseFilter.franchiseId },
    select: { primaryWarehouseId: true },
  });
  if (!franchise || franchise.primaryWarehouseId !== warehouseId) {
    throw Object.assign(new Error('You do not have access to this warehouse.'), { status: 403 });
  }
}

export class WarehouseController {
  // FRANCHISE_ADMIN is always resolved to their own franchiseId regardless
  // of what the query string asks for — never trust a client-supplied
  // franchiseId to look up another franchise's warehouse.
  static async getPrimaryWarehouse(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      if (!franchiseId) {
        return res.status(400).json({ error: 'franchiseId is required' });
      }

      const warehouse = await WarehouseService.getPrimaryWarehouse(franchiseId);
      res.json(warehouse);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // SUPER_ADMIN can look up any warehouse by id (used when they pick one
  // from the global list). FRANCHISE_ADMIN can only look up their own.
  static async getWarehouseById(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
      await assertWarehouseAccess((req as any).user, warehouseId);
      const warehouse = await WarehouseService.getWarehouseById(warehouseId);
      res.json(warehouse);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  // SUPER_ADMIN can view any warehouse's stock. FRANCHISE_ADMIN can only
  // view their own franchise's primary warehouse.
  static async getWarehouseStock(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
      await assertWarehouseAccess((req as any).user, warehouseId);
      const stock = await WarehouseService.getWarehouseStock(warehouseId);
      res.json(stock);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async getAllBins(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      let warehouseId = req.query.warehouseId as string | undefined;

      if (franchiseFilter.franchiseId) {
        const franchise = await prisma.franchise.findUnique({
          where: { id: franchiseFilter.franchiseId },
          select: { primaryWarehouseId: true },
        });
        if (!franchise?.primaryWarehouseId) {
          return res.json([]);
        }
        warehouseId = franchise.primaryWarehouseId;
      }

      const bins = await WarehouseService.getAllBins({ warehouseId });
      res.json(bins);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async createBinDirect(req: Request, res: Response) {
    try {
      const { warehouseId, code, description } = req.body;
      if (!warehouseId) {
        return res.status(400).json({ error: 'Warehouse is required' });
      }
      if (!code || !code.trim()) {
        return res.status(400).json({ error: 'Bin code is required' });
      }
      await assertWarehouseAccess((req as any).user, warehouseId);
      const bin = await WarehouseService.createBin(warehouseId, code, description);
      res.status(201).json(bin);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async createBin(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
      await assertWarehouseAccess((req as any).user, warehouseId);
      const { code, description } = req.body;
      const bin = await WarehouseService.createBin(warehouseId, code, description);
      res.status(201).json(bin);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async updateBin(req: Request, res: Response) {
    try {
      const { binId } = req.params;
      const bin = await prisma.warehouseBin.findUnique({ where: { id: binId }, select: { warehouseId: true } });
      if (!bin) return res.status(404).json({ error: 'Bin not found' });
      await assertWarehouseAccess((req as any).user, bin.warehouseId);
      const { code, description } = req.body;
      const updated = await WarehouseService.updateBin(binId, code, description);
      res.json(updated);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async deleteBin(req: Request, res: Response) {
    try {
      const { binId } = req.params;
      const bin = await prisma.warehouseBin.findUnique({ where: { id: binId }, select: { warehouseId: true } });
      if (!bin) return res.status(404).json({ error: 'Bin not found' });
      await assertWarehouseAccess((req as any).user, bin.warehouseId);
      await WarehouseService.deleteBin(binId);
      res.status(204).send();
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }

  static async assignBin(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
      await assertWarehouseAccess((req as any).user, warehouseId);
      const { itemId, batchId, quantity, newBinId } = req.body;
      const userId = (req as any).user?.id; // Assuming auth middleware sets this

      const result = await WarehouseService.assignBin({
        warehouseId,
        itemId,
        batchId,
        quantity: Number(quantity),
        newBinId,
        userId,
      });

      res.json(result);
    } catch (error: any) {
      res.status(error.status || 400).json({ error: error.message });
    }
  }
}
