import { Request, Response } from 'express';
import { KDSService } from './kds.service';

export class KDSController {
  static async getOrders(req: Request, res: Response) {
    try {
      const orders = await KDSService.getActiveOrders();
      res.json(orders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const { status } = req.body;
      const order = await KDSService.updateOrderStatus(req.params.id, status);
      res.json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
