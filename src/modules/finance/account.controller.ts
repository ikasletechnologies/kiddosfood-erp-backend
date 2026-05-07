import { Request, Response } from 'express';
import { AccountService } from './account.service';

export class AccountController {
  static async getAll(req: Request, res: Response) {
    try {
      const accounts = await AccountService.getAccounts();
      res.json(accounts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const account = await AccountService.getAccountById(req.params.id);
      if (!account) return res.status(404).json({ error: 'Account not found' });
      res.json(account);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
