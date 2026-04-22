import { Request, Response } from 'express';
import { InventoryService } from './inventory.service';
import prisma from '../../lib/prisma';

/**
 * Raw Materials Controller
 * Maps to InventoryItem model in Prisma
 */
export class RawMaterialsController {
  
  static async getActiveFranchiseId(requestedId?: string): Promise<string> {
    // 1. Check if the specific requested ID exists
    if (requestedId && requestedId.length > 5) {
      const exists = await prisma.franchise.findUnique({ where: { id: requestedId } });
      if (exists) return requestedId;
    }

    // 2. Try seeded defaults
    const defaults = ['hq-001', 'branch-001'];
    for (const id of defaults) {
      const exists = await prisma.franchise.findUnique({ where: { id } });
      if (exists) return id;
    }

    // 3. Fallback to first available
    const first = await prisma.franchise.findFirst();
    if (first) return first.id;

    // 4. ABSOLUTE FALLBACK: Create a default franchise so the app doesn't break
    console.log('⚠️ No franchises found. Creating a default "Main Branch"...');
    const root = await prisma.franchise.create({
      data: {
        id: 'hq-001',
        name: 'Main Headquarters',
        location: 'Default Location',
        ownerName: 'Admin',
        contactNum: '0000000000'
      }
    });
    return root.id;
  }

  /**
   * GET /api/raw-materials
   */
  static async getAll(req: Request, res: Response) {
    try {
      const franchiseId = await RawMaterialsController.getActiveFranchiseId(req.query.franchiseId as string);
      const items = await InventoryService.getInventory(franchiseId);
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      console.log('[Procurement] Creating material:', req.body);
      const franchiseId = await RawMaterialsController.getActiveFranchiseId(req.body.franchiseId);
      console.log('[Procurement] Resolved Franchise ID:', franchiseId);

      let sku = req.body.sku || ('RM-' + Math.random().toString(36).substring(7).toUpperCase());
      
      // Ensure SKU is unique within this franchise
      const existing = await prisma.inventoryItem.findFirst({ where: { sku, franchiseId } });
      if (existing) {
        sku += '-' + Math.random().toString(36).substring(9).toUpperCase();
      }

      const data = {
        name: req.body.name,
        sku: sku,
        unit: req.body.unit || 'kg',
        category: req.body.category || 'RAW_MATERIAL',
        franchiseId: franchiseId
      };
      
      const item = await InventoryService.createItem(data);
      console.log('[Procurement] Successfully created item:', item.id);
      res.status(201).json(item);
    } catch (error: any) {
      console.error('[Procurement] Create Item Error:', error);
      res.status(400).json({ 
        error: error.message,
        details: error.code // Prisma error codes are helpful
      });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const item = await InventoryService.updateItem(req.params.id, req.body);
      res.json(item);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await InventoryService.deleteItem(req.params.id);
      res.json({ message: 'Raw material deleted' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
