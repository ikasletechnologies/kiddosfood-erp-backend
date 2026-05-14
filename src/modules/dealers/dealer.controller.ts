import { Request, Response } from 'express';
import { DealerService } from './dealer.service';

export class DealerController {
  static async getAll(req: Request, res: Response) {
    try {
      const { franchiseId } = req.query;
      const dealers = await DealerService.getAll(franchiseId as string);
      res.json(dealers);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const dealer = await DealerService.create(req.body);
      res.status(201).json(dealer);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await DealerService.delete(req.params.id);
      res.json({ message: 'Dealer deleted successfully' });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
