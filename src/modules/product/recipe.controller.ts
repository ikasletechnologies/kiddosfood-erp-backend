import { Request, Response } from 'express';
import { RecipeService } from './recipe.service';

export class RecipeController {
  static async getAll(req: Request, res: Response) {
    try {
      const recipes = await RecipeService.getAll();
      res.json(recipes);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const recipe = await RecipeService.create(req.body);
      res.status(201).json(recipe);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
