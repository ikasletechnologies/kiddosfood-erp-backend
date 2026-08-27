import { Request, Response } from 'express';
import { SystemSetupService } from './setup.service';

export class SetupController {
  static async getStatus(req: Request, res: Response) {
    try {
      const status = await SystemSetupService.getSetupStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
