import { Request, Response } from 'express';
import { CartonService } from './carton.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class CartonController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);
      const cartons = await CartonService.getAll(franchiseId);
      res.json(cartons);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      const carton = await CartonService.create({ ...req.body, franchiseId, createdBy: user?.userId });
      res.status(201).json(carton);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }
}
