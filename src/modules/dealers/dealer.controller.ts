import { Request, Response } from 'express';
import { DealerService } from './dealer.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class DealerController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      // SUPER_ADMIN may pick any scope (HQ or a specific franchise) via the query
      // param; FRANCHISE_ADMIN is always forced to their own franchise.
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = user?.role === 'SUPER_ADMIN'
        ? (req.query.franchiseId as string | undefined)
        : ownFranchiseId;
      const dealers = await DealerService.getAll(franchiseId);
      res.json(dealers);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      // SUPER_ADMIN may target any franchise (including HQ) via req.body.franchiseId;
      // FRANCHISE_ADMIN is always forced to their own franchise, ignoring the body.
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      if (!franchiseId) {
        return res.status(400).json({ error: 'franchiseId is required' });
      }
      const dealer = await DealerService.create({ ...req.body, franchiseId });
      res.status(201).json(dealer);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { franchiseId: ownFranchiseId } = IsolationUtil.getFranchiseFilter(user);
      await DealerService.delete(req.params.id, ownFranchiseId);
      res.json({ message: 'Dealer deleted successfully' });
    } catch (error) {
      const status = (error as Error).message === 'Dealer not found' ? 404 : 500;
      res.status(status).json({ error: (error as Error).message });
    }
  }
}
