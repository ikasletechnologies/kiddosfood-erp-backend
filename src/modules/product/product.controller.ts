import { Request, Response } from 'express';
import { ProductService } from './product.service';

export class ProductController {
  static async getAll(req: Request, res: Response) {
    try {
      const category = req.query.category as string;
      const products = await ProductService.getAll(category ? { category } : {});
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
