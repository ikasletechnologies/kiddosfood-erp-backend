import { Request, Response } from 'express';
import { POSService } from './pos.service';
import prisma from '../../lib/prisma';
import { IsolationUtil } from '../../utils/isolation.util';

export class POSController {
  /**
   * POS Checkout — frontend sends recipeId or productId in items.
   * We resolve recipeId → productId automatically.
   */
  static async checkout(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const {
        franchiseId: bodyFranchiseId,
        customerId,
        customerName,
        items,
        subtotal,
        taxAmount,
        discountAmount,
        totalAmount,
        paymentMode
      } = req.body;

      const franchiseId = IsolationUtil.enforceFranchiseMatch(user, bodyFranchiseId);

      // Resolve recipeId → productId for each item
      const resolvedItems = await Promise.all(
        (items as any[]).map(async (item) => {
          if (item.productId) return item;

          const recipe = await prisma.recipe.findUnique({
            where: { id: item.recipeId },
            include: { product: true }
          });
          if (!recipe) throw new Error(`Recipe not found: ${item.recipeId}`);

          return {
            productId: recipe.productId!,
            quantity: item.quantity,
            price: item.price ?? recipe.product?.basePrice ?? 0
          };
        })
      );

      const order = await POSService.checkout({
        franchiseId: franchiseId || 'hq-001',
        customerId,
        accountId: req.body.accountId,
        items: resolvedItems,
        subTotal: subtotal ?? totalAmount,
        taxAmount: taxAmount ?? 0,
        discountAmount: discountAmount ?? 0,
        totalAmount,
        paymentMode: paymentMode || 'CASH'
      });

      // Auto-add loyalty points: 1 point per ₹10 spent
      let cid = customerId;
      if (!cid && customerName) {
        const existing = await prisma.customer.findFirst({ where: { name: customerName } });
        cid = existing?.id;
      }
      if (cid && !/walk[-_ ]?in/i.test(cid)) {
        const pts = Math.floor(totalAmount / 10);
        if (pts > 0) {
          await prisma.customer.update({
            where: { id: cid },
            data: { loyaltyPoints: { increment: pts } }
          });
        }
      }

      res.status(201).json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async getOrders(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const franchiseFilter = IsolationUtil.getFranchiseFilter(user);
      
      const filters: any = { ...franchiseFilter };
      if (req.query.franchiseId && user.role === 'SUPER_ADMIN') filters.franchiseId = req.query.franchiseId as string;
      if (req.query.status) filters.status = req.query.status as string;

      const orders = await POSService.getAllOrders(filters);
      res.json(orders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}
