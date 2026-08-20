import { Request, Response } from 'express';
import { RecipeService } from './recipe.service';

export class RecipeController {
  static async upsert(req: Request, res: Response) {
    try {
      const recipe = await RecipeService.upsertRecipe(req.body);
      res.status(201).json(recipe);
    } catch (error: any) {
      // RecipeService pre-checks the productId conflict and throws a plain
      // Error with a specific message — this P2002 branch is only a
      // backstop for a race (two saves for the same product landing
      // between the pre-check and the write), so it still needs to be
      // client-friendly rather than leaking the raw Prisma error.
      if (error.code === 'P2002' && error.meta?.target?.includes?.('productId')) {
        return res.status(400).json({ error: 'This product is already linked to another recipe — each product can only have one recipe.' });
      }
      res.status(400).json({ error: (error as Error).message });
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

  static async getCategories(req: Request, res: Response) {
    try {
      const categories = await RecipeService.getCategories();
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async createCategory(req: Request, res: Response) {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'Name is required' });
      const category = await RecipeService.createCategory(name);
      res.status(201).json(category);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
