import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import SocketService from '../../lib/socket';
import { FinanceService } from '../finance/finance.service';
import { AuditService } from '../audit/audit.service';

export class POSService {

  // --- NEW NATIVE API FLOW (Step-by-Step) ---

  // Step 1: Create empty order shell
  static async createOrder(data: { franchiseId: string, customerId?: string, orderType?: string }) {
    return prisma.order.create({
      data: {
        invoiceNum: `INV-${Date.now()}`,
        franchiseId: data.franchiseId || 'root-franchise',
        customerId: data.customerId,
        status: 'PENDING',
        paymentStatus: 'UNPAID',
        orderType: data.orderType || 'TAKEAWAY',
        subTotal: 0, 
        taxAmount: 0, 
        discountAmount: 0, 
        totalAmount: 0
      }
    });
  }

  // Step 2: Add Items
  static async addItemsToOrder(orderId: string, items: { productId: string, quantity: number, price?: number }[]) {
     return prisma.$transaction(async (tx) => {
        for (const it of items) {
           // Resolve price if not provided
           let price = it.price;
           if (price === undefined) {
             const prod = await tx.product.findUnique({ where: { id: it.productId } });
             if (!prod) throw new Error(`Product ${it.productId} not found`);
             price = prod.basePrice;
           }

           const tax = Number((price * 0.05).toFixed(2));
           const total = Number((price * it.quantity).toFixed(2));

           await tx.orderItem.create({
              data: {
                 orderId,
                 productId: it.productId,
                 quantity: it.quantity,
                 price: price,
                 taxAmount: tax,
                 totalAmount: total
              }
           });
        }

        // Recalculate totals
        const orderItems = await tx.orderItem.findMany({ where: { orderId } });
        const finalSubTotal = orderItems.reduce((acc, obj) => acc + (obj.totalAmount || 0), 0);
        const finalTax = Number((finalSubTotal * 0.05).toFixed(2)); // 5% flat overall tax
        const finalTotal = finalSubTotal + finalTax;

        const updatedOrder = await tx.order.update({
          where: { id: orderId },
          data: {
            subTotal: finalSubTotal,
            taxAmount: finalTax,
            totalAmount: finalTotal
          },
          include: { orderItems: { include: { product: true } } }
        });

        try {
          SocketService.io.emit('new-order', updatedOrder);
        } catch (err) {
          console.error('[Socket] Failed to emit new-order', err);
        }

        return updatedOrder;
     });
  }

  // Step 3 & 4: Status Updates and Inventory Deduction Enforcement
  static async updateOrderStatus(orderId: string, status: string) {
    // Phase 3: Trigger deduction on READY or COMPLETED
    if (status === 'READY' || status === 'COMPLETED') {
      await this.deductInventoryIfNecessary(orderId);
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status: status as any }
    });

    // Audit log for sensitive status changes
    if (status === 'CANCELLED' || status === 'COMPLETED') {
        await AuditService.log({
            userId: 'system', // Ideally pass userId from controller
            action: `ORDER_${status}`,
            entityType: 'ORDER',
            entityId: order.id,
            targetFranchiseId: order.franchiseId,
            details: { status }
        });
    }

    SocketService.io.emit('order-updated', order);

    // Phase 5: Trigger Accounting (Invoice & Payment) after update succeeds
    if (status === 'COMPLETED') {
        try {
            await FinanceService.createInvoiceFromOrder(orderId);
        } catch (accErr) {
            console.error('[Accounting] Failed to create invoice', accErr);
        }
    }

    return order;
  }

  // Core Deduction Engine wrapped in DB Transaction
  static async deductInventoryIfNecessary(orderId: string) {
    return prisma.$transaction(async (tx) => {
       const order = await tx.order.findUnique({
          where: { id: orderId },
          include: { orderItems: { include: { product: { include: { recipe: { include: { recipeItems: true } } } } } } }
       });

       if (!order) throw new Error('Order not found');
       
       // Safety 2: Prevent Double Deduction
       if (order.inventory_deducted) return order;

       // 1. Inventory Deduction Engine
       for (const orderItem of order.orderItems) {
         const product = orderItem.product;

         // Phase 3: Only menu items will deduct stock
         if (product && product.is_menu_item && product.recipe) {
           const scalar = orderItem.quantity / product.recipe.yieldQty;

           for (const item of product.recipe.recipeItems) {
             const required = item.quantityRequired * scalar;

             // Safety 1: Check Stock Before Deduct
             const inventoryItem = await tx.inventoryItem.findUnique({
               where: { id: item.inventoryItemId }
             });

             if (!inventoryItem) throw new Error(`Inventory mapping missing for recipe item in ${product.name}`);
             if (inventoryItem.currentStock < required) {
               throw new Error(`Out of stock: ${inventoryItem.name}. Required: ${required}, Stock: ${inventoryItem.currentStock}`);
             }

             // Deduct stock explicitly inside tx
             await InventoryService.recordMovement(tx, {
               itemId: item.inventoryItemId,
               type: 'SALES_OUT',
               quantity: -required,
               referenceType: 'ORDER',
               referenceId: order.id,
               note: `Auto-deduction for Order ${order.invoiceNum} (Product: ${product.name})`
             });
           }
         }
       }

       // 2. Mark Final
       return tx.order.update({
         where: { id: orderId },
         data: { inventory_deducted: true },
         include: { orderItems: true }
       });
    });
  }

  // Step 5: Finalize Payment
  static async payOrder(orderId: string, method: 'CASH'|'UPI'|'CARD') {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error('Order not found');

      await tx.payment.create({
        data: {
          orderId,
          paymentMode: method,
          paidAmount: order.totalAmount,
          status: 'SUCCESS'
        }
      });

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'PAID' },
        include: { payments: true }
      });
      return updated;
    });
  }


  // --- LEGACY SUPPORT ---
  /**
   * Main POS Checkout Flow (Legacy, wraps old calls)
   */
  static async checkout(data: {
    franchiseId: string,
    customerId?: string,
    items: { productId: string, quantity: number, price: number }[],
    subTotal: number,
    taxAmount: number,
    discountAmount: number,
    totalAmount: number,
    paymentMode: 'CASH' | 'UPI' | 'CARD'
  }) {
    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          invoiceNum: `INV-${Date.now()}`,
          franchiseId: data.franchiseId,
          customerId: data.customerId,
          subTotal: data.subTotal,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          totalAmount: data.totalAmount,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          orderItems: {
            create: data.items.map(item => ({
              productId: item.productId,
              quantity: item.quantity,
              price: item.price,
              taxAmount: Number((item.price * 0.05).toFixed(2)),
              totalAmount: Number((item.price * item.quantity).toFixed(2))
            }))
          },
          payments: {
            create: {
              paymentMode: data.paymentMode,
              paidAmount: data.totalAmount,
              status: 'SUCCESS'
            }
          }
        },
        include: { orderItems: true, payments: true, customer: true }
      });

      for (const orderItem of data.items) {
        const product = await tx.product.findUnique({
          where: { id: orderItem.productId },
          include: { recipe: { include: { recipeItems: true } } }
        });

        if (product && product.is_menu_item && product.recipe) {
          const scalar = orderItem.quantity / product.recipe.yieldQty;
          for (const item of product.recipe.recipeItems) {
            const quantityToDeduct = item.quantityRequired * scalar;
            
            // Check stock even in legacy checkout if possible
            const inv = await tx.inventoryItem.findUnique({ where: { id: item.inventoryItemId } });
            if (inv && inv.currentStock < quantityToDeduct) {
               throw new Error(`Out of stock during checkout: ${inv.name}`);
            }

            await InventoryService.recordMovement(tx, {
              itemId: item.inventoryItemId,
              type: 'SALES_OUT',
              quantity: -quantityToDeduct,
              referenceType: 'ORDER',
              referenceId: order.id,
              note: `Legacy checkout for ${orderItem.quantity}x ${product.name}`
            });
          }
        }
      }
      const updated = await tx.order.update({
        where: { id: order.id },
        data: { inventory_deducted: true },
        include: { orderItems: true, payments: true, customer: true }
      });

      return updated;
    });

    // Phase 5: Trigger Invoice for Legacy Checkout
    try {
        await FinanceService.createInvoiceFromOrder(result.id);
    } catch (err) {
        console.error('[Accounting] Legacy checkout invoice failed', err);
    }

    return result;
  }

  static async getAllOrders(filters: any) {
    return prisma.order.findMany({
      where: filters,
      include: { 
        orderItems: { include: { product: true } }, 
        customer: true, 
        payments: true 
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getOrderById(id: string) {
    return prisma.order.findUnique({
      where: { id },
      include: { 
        orderItems: { include: { product: true } }, 
        customer: true, 
        payments: true,
        franchise: true 
      }
    });
  }

  static async addPayment(orderId: string, data: any) {
    return this.payOrder(orderId, data.paymentMode);
  }
}
