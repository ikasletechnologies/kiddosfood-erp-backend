import { Request, Response } from 'express';
import { WarehouseService } from './warehouse.service';

export class WarehouseController {
  static async getPrimaryWarehouse(req: Request, res: Response) {
    try {
      const franchiseId = req.query.franchiseId as string;
      if (!franchiseId) {
        return res.status(400).json({ error: 'franchiseId is required' });
      }

      const warehouse = await WarehouseService.getPrimaryWarehouse(franchiseId);
      res.json(warehouse);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async getWarehouseStock(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
      const stock = await WarehouseService.getWarehouseStock(warehouseId);
      res.json(stock);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async createBin(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
      const { code, description } = req.body;
      const bin = await WarehouseService.createBin(warehouseId, code, description);
      res.status(201).json(bin);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async updateBin(req: Request, res: Response) {
    try {
      const { binId } = req.params;
      const { code, description } = req.body;
      const bin = await WarehouseService.updateBin(binId, code, description);
      res.json(bin);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async deleteBin(req: Request, res: Response) {
    try {
      const { binId } = req.params;
      await WarehouseService.deleteBin(binId);
      res.status(204).send();
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async assignBin(req: Request, res: Response) {
    try {
      const { warehouseId } = req.params;
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
      res.status(400).json({ error: error.message });
    }
  }
}
