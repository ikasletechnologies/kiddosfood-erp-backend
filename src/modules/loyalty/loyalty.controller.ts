import { Request, Response } from 'express';
import { CustomerService } from '../customers/customer.service';

export class LoyaltyController {
  static async getLoyalty(req: Request, res: Response) {
    try {
      const loyalty = await CustomerService.getLoyalty(req.params.customerId);
      if (!loyalty) return res.status(404).json({ error: 'Customer not found' });
      res.json(loyalty);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async addPoints(req: Request, res: Response) {
    try {
      const { customerId, points } = req.body;
      const customer = await CustomerService.addPoints(customerId, points);
      res.json(customer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async redeem(req: Request, res: Response) {
    try {
      const { customerId, points } = req.body;
      const customer = await CustomerService.redeemPoints(customerId, points);
      res.json(customer);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
