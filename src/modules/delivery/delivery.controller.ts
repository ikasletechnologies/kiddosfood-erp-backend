import { Request, Response } from 'express';
import { DeliveryService } from './delivery.service';

export class DeliveryController {
  static async getActive(req: Request, res: Response) {
    try {
      const deliveries = await DeliveryService.getActiveDeliveries();
      res.json(deliveries);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async update(req: Request, res: Response) {
    try {
      const { id, status } = req.body;
      const delivery = await DeliveryService.updateStatus(id, status);
      res.json(delivery);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async verify(req: Request, res: Response) {
    try {
      const { id, otp } = req.body;
      const delivery = await DeliveryService.verifyOTP(id, otp);
      res.json(delivery);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
