import { Request, Response } from 'express';
import { ChequeService } from './cheque.service';
import { ChequeStatus } from '@prisma/client';
import { IsolationUtil } from '../../utils/isolation.util';

export class ChequeController {
  static async findAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const cheques = await ChequeService.getAll(franchiseId);
      res.json(cheques);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getStats(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId || (req.query.franchiseId as string);

      const stats = await ChequeService.getStats(franchiseId);
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      
      const cheque = await ChequeService.create({ ...req.body, franchiseId });
      res.status(201).json(cheque);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { status, accountId } = req.body;
      const cheque = await ChequeService.updateStatus(id, status as ChequeStatus, accountId);
      res.json(cheque);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
