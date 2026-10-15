import { Request, Response } from 'express';
import { RecipeImportService } from './recipe-import.service';

const statusOf = (error: any) => (error?.status && error.status < 500 ? error.status : 500);

export class RecipeImportController {
  /** POST { fileName, contentBase64 } → review session (nothing imported yet). */
  static async upload(req: Request, res: Response) {
    try {
      res.status(201).json(await RecipeImportService.upload(req.body || {}, (req as any).user?.userId));
    } catch (error: any) {
      res.status(statusOf(error)).json({ error: error.message });
    }
  }

  static async list(_req: Request, res: Response) {
    try {
      res.json(await RecipeImportService.listSessions());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async review(req: Request, res: Response) {
    try {
      res.json(await RecipeImportService.review(req.params.id));
    } catch (error: any) {
      res.status(statusOf(error)).json({ error: error.message });
    }
  }

  /** Confirms one reviewed recipe. */
  static async confirm(req: Request, res: Response) {
    try {
      res.json(await RecipeImportService.confirm(req.params.id, req.params.key, req.body || {}, (req as any).user?.userId));
    } catch (error: any) {
      res.status(statusOf(error)).json({ error: error.message });
    }
  }

  /** POST { skip: boolean } — keep a recipe out of this import, or reopen it. */
  static async skip(req: Request, res: Response) {
    try {
      res.json(await RecipeImportService.skip(req.params.id, req.params.key, req.body?.skip !== false, (req as any).user?.userId));
    } catch (error: any) {
      res.status(statusOf(error)).json({ error: error.message });
    }
  }
}
