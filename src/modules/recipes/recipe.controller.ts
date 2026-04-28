import { Request, Response } from 'express';
import { RecipeService } from './recipe.service';

export class RecipeController {
  static async upsert(req: Request, res: Response) {
    try {
      const recipe = await RecipeService.upsertRecipe(req.body);
      res.status(201).json(recipe);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getAll(req: Request, res: Response) {
    try {
      const recipes = await RecipeService.getRecipes();
      res.json(recipes);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const recipe = await RecipeService.getRecipeById(req.params.id);
      if (!recipe) return res.status(404).json({ error: 'Recipe not found' });
      res.json(recipe);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async getByProduct(req: Request, res: Response) {
    try {
      const recipe = await RecipeService.getRecipeByProduct(req.params.productId);
      if (!recipe) return res.status(404).json({ error: 'Recipe not found for this product' });
      res.json(recipe);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async calculateCost(req: Request, res: Response) {
    try {
      const cost = await RecipeService.calculateCost(req.params.id);
      res.json(cost);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await RecipeService.deleteRecipe(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
