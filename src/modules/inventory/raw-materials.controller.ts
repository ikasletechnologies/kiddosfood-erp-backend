import { IsolationUtil as DataIsolator } from '../../utils/isolation.util';
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
      const user = (req as any).user;
      const franchiseFilter = DataIsolator.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId ?? (req.query.franchiseId as string | undefined);
      const includeInactive = req.query.includeInactive === 'true';
      const items = await prisma.inventoryItem.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          ...(includeInactive ? {} : { isActive: true })
        },
        orderBy: { name: 'asc' }
      });
      res.json(items);
    } catch (error) {
      console.error('[RawMaterialsController.getAll] Error:', error);
      res.status(500).json({ 
        error: (error as Error).message,
        stack: process.env.NODE_ENV === 'development' ? (error as Error).stack : undefined 
      });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = DataIsolator.enforceFranchiseMatch(user, req.body.franchiseId);
      
      if (!franchiseId) {
        return res.status(400).json({ error: "Franchise identification is required to create a material." });
      }

      console.log(`[RawMaterials] Creating material for franchise: ${franchiseId}`);

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
        franchiseId: franchiseId,
        minimumStock: req.body.minimumStock,
        initialStock: req.body.initialStock,
        hsnCode: req.body.hsnCode,
        gstRate: req.body.gstRate,
        userId: user.id
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
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
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

  static async deactivate(req: Request, res: Response) {
    try {
      await InventoryService.deactivateItem(req.params.id);
      res.json({ message: 'Material marked as inactive' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async activate(req: Request, res: Response) {
    try {
      await InventoryService.activateItem(req.params.id);
      res.json({ message: 'Material reactivated' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async getById(req: Request, res: Response) {
    console.log(`🔍 [RawMaterials] Fetching material by ID: ${req.params.id}`);
    try {
      const item = await InventoryService.getItemById(req.params.id);
      if (!item) {
        console.warn(`⚠️ [RawMaterials] Material not found: ${req.params.id}`);
        return res.status(404).json({ error: 'Material not found' });
      }
      console.log(`✅ [RawMaterials] Found material: ${item.name}`);
      res.json(item);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
