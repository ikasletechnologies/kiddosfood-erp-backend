import { Request, Response } from 'express';
import { ProductService } from './product.service';
import prisma from '../../lib/prisma';

export class ProductController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      let franchiseId = user?.franchiseId || (req.query.franchiseId as string);
      
      // Fallback for Super Admins if no franchise context is provided
      if (!franchiseId && user?.role === 'SUPER_ADMIN') {
        const hq = await prisma.franchise.findFirst({ 
          where: { 
            OR: [
              { name: { contains: 'HQ', mode: 'insensitive' } },
              { name: { contains: 'Head', mode: 'insensitive' } },
              { name: { contains: 'Main', mode: 'insensitive' } },
              { name: { contains: 'Home', mode: 'insensitive' } }
            ],
            status: 'ACTIVE' 
          } 
        });
        const first = await prisma.franchise.findFirst({ where: { status: 'ACTIVE' } });
        franchiseId = hq?.id || first?.id;
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
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
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
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
}
