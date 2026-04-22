import { Request, Response } from 'express';
import { MenuService } from './menu.service';

export class MenuController {
  static async getItems(req: Request, res: Response) {
    try {
      const items = await MenuService.getItems(
        req.query.category as string,
        req.query.search as string
      );
      res.json(items);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createItem(req: Request, res: Response) {
    try {
      const item = await MenuService.createItem(req.body);
      res.status(201).json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateItem(req: Request, res: Response) {
    try {
      const item = await MenuService.updateItem(req.params.id, req.body);
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async deleteItem(req: Request, res: Response) {
    try {
      await MenuService.deleteItem(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getCategories(req: Request, res: Response) {
    try {
      const categories = await MenuService.getCategories();
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createCategory(req: Request, res: Response) {
    try {
      const result = await MenuService.createCategory(req.body.name);
      res.status(201).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
