import { Request, Response } from 'express';
import { ProductService, DuplicateProductError } from './product.service';
import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';

export class ProductController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      let franchiseId = req.query.franchiseId as string;
      let stockSource = req.query.stockSource as string;

      // GLOBAL is a SUPER_ADMIN-only directive — checked here, server-side,
      // never trusted from the client. A FRANCHISE_ADMIN passing it must be
      // treated exactly as if they hadn't passed it at all, so it falls
      // through to their own-franchise resolution below untouched (rather
      // than merely skipping the GLOBAL branch while still perturbing the
      // "no stockSource" checks further down, which would leave franchiseId
      // unset and unintentionally return the unfiltered global catalog).
      if (stockSource === 'GLOBAL' && user?.role !== 'SUPER_ADMIN') {
        stockSource = '';
      }

      // Super Admin can explicitly ask for the full global finished-goods
      // catalog — every product regardless of which franchise (if any)
      // stocks it — instead of being silently narrowed to one franchise's
      // inventory. ProductService.getAll() with no franchiseId already
      // returns the unfiltered catalog (no per-franchise stock
      // enrichment/dropping) — callers that need per-franchise stock keep
      // computing it themselves from /api/raw-materials, same as
      // FinishedGoodsStockClient does today.
      if (stockSource === 'GLOBAL') {
        const category = req.query.category as string;
        const products = await ProductService.getAll(category ? { category } : {});
        return res.json(products);
      }

      // If user is a franchise user, strictly enforce their franchiseId
      if (user?.role !== 'SUPER_ADMIN' && user?.franchiseId) {
        franchiseId = user.franchiseId;
      } else if (!franchiseId && !stockSource && user?.franchiseId) {
        franchiseId = user.franchiseId;
      }

      // If HQ stock is requested, or if no context is available for a Super Admin
      if (stockSource === 'HQ' || (!franchiseId && user?.role === 'SUPER_ADMIN')) {
        // "First active franchise" is not a valid definition of HQ — an
        // arbitrary branch silently standing in for HQ here is exactly how
        // POS/Stock Hub ended up disagreeing with each other before. If
        // there's genuinely no HQ configured, return the empty/unfiltered
        // catalog rather than guess.
        const hq = await FranchiseService.getHqFranchiseOrNull();
        franchiseId = hq?.id || "";
      }
      
      console.log(`📦 [ProductAPI] Fetching products for Franchise: ${franchiseId || 'NONE'}`);
      
      const category = req.query.category as string;
      const products = await ProductService.getAll(
        category ? { category } : {},
        franchiseId
      );
      res.json(products);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const product = await ProductService.create(req.body);
      res.status(201).json(product);
    } catch (error: any) {
      if (error instanceof DuplicateProductError) {
        return res.status(400).json({ error: error.message, code: 'DUPLICATE_SKU' });
      }
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * POST /api/products/bulk-import
   * Body: { rows: Array<{ category?, name, size?, unit?, gstPercent? }> }
   * Creates Finished Good catalog entries only — no stock. Never aborts on
   * a single bad row; returns per-row success/duplicate/invalid buckets.
   */
  static async bulkImport(req: Request, res: Response) {
    try {
      const rows = req.body?.rows;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ error: 'rows must be a non-empty array' });
      }
      const result = await ProductService.bulkCreateFinishedGoods(rows);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const product = await ProductService.getById(req.params.id);
      if (!product) return res.status(404).json({ error: 'Product not found' });
      res.json(product);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const product = await ProductService.update(req.params.id, req.body);
      res.json(product);
    } catch (error: any) {
      if (error instanceof DuplicateProductError) {
        return res.status(400).json({ error: error.message, code: 'DUPLICATE_SKU' });
      }
      res.status(500).json({ error: error.message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await ProductService.delete(req.params.id);
      res.json({ message: 'Product deleted successfully' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async linkExistingProduct(req: Request, res: Response) {
    try {
      const result = await ProductService.linkExistingProduct(req.body);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
