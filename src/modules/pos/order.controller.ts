import { Request, Response } from 'express';
import { POSService } from './pos.service';
import { IsolationUtil } from '../../utils/isolation.util';

export class OrderController {
  
  // --- New Step-by-Step API ---
  static async createOrder(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);

      const order = await POSService.createOrder({ ...req.body, franchiseId });
      res.status(201).json({ orderId: order.id, order });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async addItems(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const existing = await POSService.getOrderById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && existing.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to this order' });
      }

      const items = req.body.items || [req.body]; // accept array or single object inside {items}
      const order = await POSService.addItemsToOrder(req.params.id, items);
      res.status(200).json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async updateStatus(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const existing = await POSService.getOrderById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && existing.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to this order' });
      }

      const { status } = req.body;
      const order = await POSService.updateOrderStatus(req.params.id, status);
      res.json(order);
    } catch (error: any) {
      // Meaningful status codes for Out of Stock or Missing Inventory conditions
      const cleanMsg = error.message.toLowerCase();
      const isBadRequest = cleanMsg.includes('out of stock') || cleanMsg.includes('already completed') || cleanMsg.includes('not found');
      res.status(isBadRequest ? 400 : 500).json({ error: error.message });
    }
  }

  static async addPayment(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const existing = await POSService.getOrderById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && existing.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to this order' });
      }

      // Ensure 'method' maps to enum ('CASH', 'UPI', 'CARD')
      const method = req.body.method || req.body.paymentMode || 'CASH';
      const accountId = req.body.accountId;
      const order = await POSService.payOrder(req.params.id, method, accountId, user?.userId);
      res.status(200).json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // --- Legacy Monolithic API (Preserved to avoid frontend apps crashing) ---
  static async checkout(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseId = await IsolationUtil.enforceFranchiseMatch(user, req.body.franchiseId);

      const order = await POSService.checkout({ ...req.body, franchiseId });
      res.status(201).json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // --- Read Operations ---
  static async getAll(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      const franchiseId = user.role === 'SUPER_ADMIN' ? (req.query.franchiseId as string || franchiseFilter.franchiseId) : franchiseFilter.franchiseId;

      const filters: any = {};
      if (franchiseId) filters.franchiseId = franchiseId;
      if (req.query.status) Object.assign(filters, { status: req.query.status });
      
      const orders = await POSService.getAllOrders(filters);
      res.json(orders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOne(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const order = await POSService.getOrderById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && order.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to this order' });
      }
      res.json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getInvoice(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const order = await POSService.getOrderById(req.params.orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (user && user.role !== 'SUPER_ADMIN' && order.franchiseId !== user.franchiseId) {
        return res.status(403).json({ error: 'Forbidden: Access denied to this order' });
      }

      res.json({
        invoiceNum: order.invoiceNum,
        date: order.createdAt,
        customer: order.customer,
        franchise: order.franchise,
        items: order.orderItems,
        subTotal: order.subTotal,
        taxAmount: order.taxAmount,
        discountAmount: order.discountAmount,
        totalAmount: order.totalAmount,
        payments: order.payments
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
