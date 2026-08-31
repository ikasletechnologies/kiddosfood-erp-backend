import { Request, Response } from 'express';
import { FranchiseOrderService } from './franchise-order.service';
import { FranchiseOrderStatus } from '@prisma/client';

export class FranchiseOrderController {
  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = req.body.franchiseId ?? user.franchiseId;
      if (!franchiseId) return res.status(400).json({ error: 'franchiseId required' });

      const order = await FranchiseOrderService.createOrder({ ...req.body, franchiseId });
      res.status(201).json(order);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }

  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId =
        user.role === 'FRANCHISE_ADMIN'
          ? user.franchiseId
          : (req.query.franchiseId as string | undefined);

      const status = req.query.status as FranchiseOrderStatus | undefined;
      const orders = await FranchiseOrderService.getOrders({ franchiseId, status });
      res.json(orders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const order = await FranchiseOrderService.getOrderById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json(order);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const order = await FranchiseOrderService.getOrderById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      if (user.role === 'FRANCHISE_ADMIN' && order.franchiseId !== user.franchiseId) {
        const message = 'Forbidden: You can only receive your own franchise\'s orders';
        return res.status(403).json({ error: message, message });
      }

      const { status, actualDispatchDate } = req.body;
      const updated = await FranchiseOrderService.updateStatus(
        req.params.id,
        status as FranchiseOrderStatus,
        { actualDispatchDate }
      );
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message, message: e.message });
    }
  }

  static async recordPayment(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const order = await FranchiseOrderService.getOrderById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      if (user.role === 'FRANCHISE_ADMIN' && order.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: You can only pay for your own orders' });
      }

      const { amount, accountId } = req.body;
      const updated = await FranchiseOrderService.recordPayment(
        req.params.id, 
        amount, 
        accountId,
        user?.fullName || user?.email || 'System'
      );
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
}
