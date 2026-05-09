import prisma from '../../lib/prisma';
import { FranchiseOrderStatus, PaymentType, ProductType } from '@prisma/client';
import { FinanceService } from '../finance/finance.service';

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FO-${ts}-${rnd}`;
}

export class FranchiseOrderService {
  // ─── Create Order ──────────────────────────────────────────────────────────
  static async createOrder(data: {
    franchiseId: string;
    paymentType?: PaymentType;
    expectedDispatchDate?: string;
    notes?: string;
    items: Array<{ productId: string; quantity: number }>;
  }) {
    return prisma.$transaction(async tx => {
      // Load products to validate and price them
      const productIds = data.items.map(i => i.productId);
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, isActive: true },
      });

      if (products.length !== productIds.length) {
        throw new Error('One or more products not found or inactive');
      }

      const orderItems: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
        totalAmount: number;
        productType: ProductType;
      }> = [];

      for (const reqItem of data.items) {
        const product = products.find(p => p.id === reqItem.productId)!;

        // FINISHED_GOOD → check available stock from ProductBatch
        if (product.productType === ProductType.FINISHED_GOOD) {
          const batches = await tx.productBatch.findMany({
            where: {
              productId: product.id,
              quantity: { gt: 0 },
              OR: [
                { expiryDate: null },
                { expiryDate: { gte: new Date() } },
              ],
            },
          });
          const availableStock = batches.reduce((sum, b) => sum + b.quantity, 0);
          if (availableStock < reqItem.quantity) {
            throw new Error(
              `Insufficient stock for "${product.name}". ` +
              `Available: ${availableStock}, Requested: ${reqItem.quantity}`
            );
          }
        }
        // MADE_TO_ORDER → allowed without stock check

        const unitPrice   = product.basePrice;
        const totalAmount = unitPrice * reqItem.quantity;
        orderItems.push({
          productId: product.id,
          quantity: reqItem.quantity,
          unitPrice,
          totalAmount,
          productType: product.productType,
        });
      }

      const totalAmount = orderItems.reduce((s, i) => s + i.totalAmount, 0);

      const order = await tx.franchiseOrder.create({
        data: {
          orderNumber: generateOrderNumber(),
          franchiseId: data.franchiseId,
          paymentType: data.paymentType ?? PaymentType.COD,
          totalAmount,
          notes: data.notes,
          expectedDispatchDate: data.expectedDispatchDate
            ? new Date(data.expectedDispatchDate)
            : null,
          items: { create: orderItems },
        },
        include: {
          items: { include: { product: true } },
          franchise: true,
        },
      });

      return order;
    });
  }

  // ─── Get Orders ────────────────────────────────────────────────────────────
  static async getOrders(filters: { franchiseId?: string; status?: FranchiseOrderStatus }) {
    return prisma.franchiseOrder.findMany({
      where: {
        ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        items: { include: { product: true } },
        franchise: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getOrderById(id: string) {
    return prisma.franchiseOrder.findUnique({
      where: { id },
      include: { items: { include: { product: true } }, franchise: true },
    });
  }

  // ─── Status Transitions ────────────────────────────────────────────────────
  static async updateStatus(
    id: string,
    status: FranchiseOrderStatus,
    extra?: { actualDispatchDate?: string }
  ) {
    const order = await prisma.franchiseOrder.findUnique({ where: { id } });
    if (!order) throw new Error('Order not found');

    const updateData: any = { status };

    if (status === FranchiseOrderStatus.DISPATCHED) {
      const actual = extra?.actualDispatchDate
        ? new Date(extra.actualDispatchDate)
        : new Date();
      updateData.actualDispatchDate = actual;

      // Phase 8: auto-flag delays
      if (order.expectedDispatchDate && actual > order.expectedDispatchDate) {
        updateData.delayStatus = 'DELAYED';
      } else {
        updateData.delayStatus = 'ON_TIME';
      }

      // Deduct batch stock for FINISHED_GOOD items (FIFO)
      await prisma.$transaction(async tx => {
        const fullOrder = await tx.franchiseOrder.findUnique({
          where: { id },
          include: { items: true },
        });
        for (const item of fullOrder!.items) {
          if (item.productType === ProductType.FINISHED_GOOD) {
            await deductBatchStock(tx, item.productId, item.quantity);
          }
        }
        await tx.franchiseOrder.update({ where: { id }, data: updateData });
      });

      return prisma.franchiseOrder.findUnique({
        where: { id },
        include: { items: { include: { product: true } }, franchise: true },
      });
    }

    return prisma.franchiseOrder.update({
      where: { id },
      data: updateData,
      include: { items: { include: { product: true } }, franchise: true },
    });
  }

  // ─── Payment ───────────────────────────────────────────────────────────────
  static async recordPayment(id: string, amount: number, accountId: string, paidBy?: string) {
    if (!accountId) throw new Error('Source Account ID is required for franchise payments.');

    return prisma.$transaction(async (tx) => {
      const order = await tx.franchiseOrder.findUnique({ where: { id } });
      if (!order) throw new Error('Order not found');

      // 1. Central Payment & Account Adjustment (Money IN from Franchise)
      await FinanceService.createPayment({
        tx,
        amount: amount || order.totalAmount,
        flow: 'IN',
        status: 'PAID',
        sourceAccount: accountId,
        method: order.paymentType as any,
        sourceModule: 'FRANCHISE',
        linkedDocType: 'INVOICE',
        linkedDocId: order.orderNumber,
        entityType: 'FRANCHISE',
        entityId: order.franchiseId,
        createdBy: paidBy || 'FRANCHISE_SYSTEM'
      });

      return tx.franchiseOrder.update({
        where: { id },
        data: { paymentStatus: 'PAID' },
      });
    });
  }
}

// FIFO batch deduction
async function deductBatchStock(tx: any, productId: string, quantityNeeded: number) {
  const batches = await tx.productBatch.findMany({
    where: {
      productId,
      quantity: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gte: new Date() } }],
    },
    orderBy: { createdAt: 'asc' }, // FIFO
  });

  let remaining = quantityNeeded;
  for (const batch of batches) {
    if (remaining <= 0) break;
    const deduct = Math.min(batch.quantity, remaining);
    await tx.productBatch.update({
      where: { id: batch.id },
      data: { quantity: { decrement: deduct } },
    });
    remaining -= deduct;
  }

  if (remaining > 0) {
    throw new Error(`Insufficient batch stock for product dispatch. Shortfall: ${remaining}`);
  }
}
