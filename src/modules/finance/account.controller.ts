import { Request, Response } from 'express';
import { AccountService } from './account.service';

export class AccountController {
  static async getAll(req: Request, res: Response) {
    try {
      const accounts = await AccountService.getAccounts();
      res.json(accounts);
    } catch (error: any) {
      console.error('[AccountController.getAll] Error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  static async create(req: Request, res: Response) {
    try {
      const account = await AccountService.createAccount(req.body);
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
