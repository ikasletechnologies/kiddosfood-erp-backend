import { Request, Response } from 'express';
import { FranchiseOrderService } from './franchise-order.service';
import { FranchiseOrderStatus } from '@prisma/client';

export class FranchiseOrderController {
  static async create(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      // Audit C-03: a franchise admin always orders for its own franchise —
      // a body-supplied franchiseId used to let it debit another franchise.
      const franchiseId = user.role === 'SUPER_ADMIN' ? (req.body.franchiseId ?? user.franchiseId) : user.franchiseId;
      if (!franchiseId) return res.status(400).json({ error: 'franchiseId required' });

      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'At least one item is required' });
      }
      for (const it of items) {
        const q = Number(it?.quantity);
        if (typeof it?.productId !== 'string' || !Number.isFinite(q) || q <= 0) {
          return res.status(400).json({ error: 'Every item needs a productId and a quantity greater than zero' });
        }
      }

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

      if (user.role === 'FRANCHISE_ADMIN' && !user.franchiseId) {
        return res.status(403).json({ error: 'No franchise assigned' });
      }
      const status = req.query.status as FranchiseOrderStatus | undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const orders = await FranchiseOrderService.getOrders({ franchiseId, status, search });
      res.json(orders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }

  static async getById(req: Request, res: Response) {
    try {
      const order = await FranchiseOrderService.getOrderById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const user = (req as any).user;
      if (user.role === 'FRANCHISE_ADMIN' && (!user.franchiseId || order.franchiseId !== user.franchiseId)) {
        return res.status(403).json({ error: 'Forbidden: You can only view your own franchise orders' });
      }
      res.json(order);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const { status, actualDispatchDate, notes } = req.body || {};
      // Role, ownership and transition rules are enforced inside the service,
      // under the order's row lock (audit C-03).
      const updated = await FranchiseOrderService.updateStatus(
        req.params.id,
        status as FranchiseOrderStatus,
        { actualDispatchDate, notes },
        { userId: user?.userId, role: user?.role, franchiseId: user?.franchiseId ?? null, label: user?.fullName || user?.email || null }
      );
      res.json(updated);
    } catch (e: any) {
      const code = e.statusCode || 400;
      res.status(code).json({ error: e.message, message: e.message });
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

      const isHqAdmin = user.role !== 'FRANCHISE_ADMIN' && user.role !== 'FRANCHISE';
      const { amount, accountId } = req.body;
      const updated = await FranchiseOrderService.recordPayment(
        req.params.id, 
        amount, 
        accountId,
        user?.fullName || user?.email || (isHqAdmin ? 'HQ Admin' : 'Franchise User'),
        isHqAdmin
      );
      res.json(updated);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  }
}
