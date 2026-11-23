import { Request, Response } from 'express';
import { KDSService } from './kds.service';
import { POSService } from '../pos/pos.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class KDSController {
  static async getOrders(req: Request, res: Response) {
    try {
      // Kitchen screen shows only the caller's own branch (audit H-08 follow-up:
      // it listed every franchise's orders).
      const user = (req as any).user;
      const franchiseId = IsolationUtil.getFranchiseFilter(user).franchiseId;
      const orders = await KDSService.getActiveOrders(franchiseId);
      res.json(orders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const { status } = req.body || {};
      // Same guarded path as the POS order route: forward kitchen progress
      // only, owner-checked, row-locked, side effects exactly once. This used
      // to write any status to any Order (including tax invoices) directly.
      const order = await POSService.updateOrderStatus(req.params.id, status, (req as any).user);
      res.json(order);
    } catch (error: any) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
}
