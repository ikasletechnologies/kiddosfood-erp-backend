import { Request, Response } from 'express';
import { DraftsService } from './drafts.service';

export class DraftsController {
  static async getDrafts(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const type = req.query.type as string;
      const drafts = await DraftsService.getDrafts(userId, type);
      res.json(drafts);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async saveDraft(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const draft = req.body; // { id?, type, data }
      const saved = await DraftsService.saveDraft(userId, draft);
      res.json(saved);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async deleteDraft(req: Request, res: Response) {
    try {
      const { id } = req.params;
      await DraftsService.deleteDraft(id);
      res.status(204).send();
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
