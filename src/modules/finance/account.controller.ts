import { Request, Response } from 'express';
import { AccountService } from './account.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class AccountController {
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = franchiseFilter.franchiseId !== undefined ? franchiseFilter.franchiseId : (req.query.franchiseId as string || null);
      const accounts = await AccountService.getAccounts(franchiseId);
      res.json(accounts);
    } catch (error: any) {
      console.error('[AccountController.getAll] Error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const account = await AccountService.getAccountById(req.params.id);
      if (!account) {
        return res.status(404).json({ error: 'Account not found' });
      }
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);
      const account = await AccountService.createAccount({ ...req.body, franchiseId });
      res.status(201).json(account);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async delete(req: Request, res: Response) {
    try {
      await AccountService.deleteAccount(req.params.id);
      res.status(204).send();
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
