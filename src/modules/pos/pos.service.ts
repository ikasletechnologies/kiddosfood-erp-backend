import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import SocketService from '../../lib/socket';
import { FinanceService } from '../finance/finance.service';
import { AuditService } from '../audit/audit.service';
import { AccountService } from '../finance/account.service';

export class POSService {

  // --- NEW NATIVE API FLOW (Step-by-Step) ---

  // Step 1: Create empty order shell
  static async createOrder(data: { franchiseId?: string, customerId?: string, orderType?: string }) {
    let fid = data.franchiseId || 'hq-001';
    
    // Safety check: verify franchise exists, else pick the first one
    const exists = await prisma.franchise.findUnique({ where: { id: fid } });
    if (!exists) {
      const first = await prisma.franchise.findFirst();
      if (!first) throw new Error('No franchises found in the system. Please create one first.');
      fid = first.id;
    }

    return prisma.order.create({
      data: {
        invoiceNum: `INV-${Date.now()}`,
        franchiseId: fid,
        customerId: (data.customerId && !/walk[-_ ]?in/i.test(data.customerId)) ? data.customerId : null,
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

           const tax = Number((price! * 0.05).toFixed(2));
           const total = Number((price! * it.quantity).toFixed(2));

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
            await prisma.customerLedger.create({
              data: {
                customerId: order.customerId!,
                type: 'DEBIT',
                amount: order.totalAmount,
                paymentMode: 'CASH', // Placeholder until payment
                referenceType: 'SALE',
                referenceId: order.id,
                note: `POS Sale — Invoice #${order.invoiceNum}`
              }
            });
            await FinanceService.createInvoiceFromOrder(orderId);
        } catch (accErr) {
            console.error('[Accounting] Failed to create invoice/ledger', accErr);
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
         if (product && product.is_menu_item) {
           if (product.recipe) {
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
           } else {
             // FALLBACK: If no recipe exists, try to deduct directly from InventoryItem with matching SKU or Name
             const inventoryItem = await tx.inventoryItem.findFirst({
               where: {
                 OR: [
                   { sku: product.sku || '___NON_EXISTENT___' },
                   { name: { equals: product.name, mode: 'insensitive' } }
                 ],
                 franchiseId: order.franchiseId
               }
             });

             if (inventoryItem) {
                if (inventoryItem.currentStock < orderItem.quantity) {
                  throw new Error(`Out of stock: ${inventoryItem.name}. Required: ${orderItem.quantity}, Stock: ${inventoryItem.currentStock}`);
                }

                await InventoryService.recordMovement(tx, {
                  itemId: inventoryItem.id,
                  type: 'SALES_OUT',
                  quantity: -orderItem.quantity,
                  referenceType: 'ORDER',
                  referenceId: order.id,
                  note: `Direct auto-deduction for Order ${order.invoiceNum} (No recipe)`
                });
             }
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
  static async payOrder(orderId: string, method: 'CASH'|'UPI'|'CARD', accountId: string, createdBy?: string) {
    if (!accountId) throw new Error('Source Account ID is required for POS payments.');

    const order = await prisma.order.findUnique({ 
      where: { id: orderId },
      include: { invoice: true }
    });
    if (!order) throw new Error('Order not found');

    // 1. Create Centralized Payment via FinanceService
    await FinanceService.createPayment({
      amount: order.totalAmount,
      flow: 'IN',
      status: 'PAID',
      sourceAccount: accountId, // This might need mapping if accountId is a UUID
      method: method,
      sourceModule: 'POS',
      linkedDocType: 'INVOICE',
      linkedDocId: order.invoice?.id || order.invoiceNum,
      entityType: 'CUSTOMER',
      entityId: order.customerId || 'WALK_IN',
      orderId: order.id,
      createdBy: createdBy || 'POS_SYSTEM'
    });

    // 2. Customer Ledger CREDIT (They paid us)
    if (order.customerId) {
      await prisma.customerLedger.create({
        data: {
          customerId: order.customerId,
          type: 'CREDIT',
          amount: order.totalAmount,
          paymentMode: method,
          referenceType: 'PAYMENT',
          referenceId: order.id,
          accountId,
          note: `Payment for Order #${order.invoiceNum}`
        }
      });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'PAID' },
      include: { payments: true }
    });
    return updated;
  }


  // --- LEGACY SUPPORT ---
  /**
   * Main POS Checkout Flow (Legacy, wraps old calls)
   */
  static async checkout(data: { 
    franchiseId?: string, 
    customerId?: string, 
    accountId?: string,
    items: { productId: string, quantity: number, price: number }[],
    subTotal: number,
    taxAmount: number,
    discountAmount: number,
    totalAmount: number,
    paymentMode: string
  }) {
    let fid = data.franchiseId;
    if (!fid) {
      const hq = await prisma.franchise.findFirst({ 
        where: { 
          OR: [
            { name: { contains: 'HQ', mode: 'insensitive' } },
            { name: { contains: 'Head', mode: 'insensitive' } },
            { name: { contains: 'Main', mode: 'insensitive' } },
            { name: { contains: 'Home', mode: 'insensitive' } }
          ],
          status: 'ACTIVE' 
        } 
      });
      const first = await prisma.franchise.findFirst({ where: { status: 'ACTIVE' } });
      fid = hq?.id || first?.id || 'hq-001';
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          invoiceNum: `INV-${Date.now()}`,
          franchiseId: fid,
          customerId: (data.customerId && !/walk[-_ ]?in/i.test(data.customerId)) ? data.customerId : null,
          subTotal: data.subTotal || (data as any).subtotal || 0,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          totalAmount: data.totalAmount,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          orderItems: {
            create: data.items.map((item: any) => ({
              productId: item.productId || item.id,
              quantity: item.quantity,
              price: item.price || item.unitPrice || 0,
              taxAmount: Number(((item.price || item.unitPrice || 0) * 0.05).toFixed(2)),
              totalAmount: Number(((item.price || item.unitPrice || 0) * item.quantity).toFixed(2))
            }))
          },
        },
        include: { orderItems: true, customer: true }
      });

      // 1. Handle Payment through central logic
      const accountTypeMap: Record<string, 'CASH' | 'BANK' | 'UPI'> = {
        'CASH': 'CASH',
        'UPI': 'UPI',
        'CARD': 'BANK'
      };
      const targetType = accountTypeMap[data.paymentMode] || 'CASH';
      
      // Use provided accountId or fallback to default for the payment mode
      let finalAccountId = data.accountId;
      if (!finalAccountId) {
        const defaultAccount = await tx.account.findFirst({ where: { type: targetType } });
        finalAccountId = defaultAccount?.id || targetType;
      }
      
      await FinanceService.createPayment({
        tx,
        amount: data.totalAmount,
        flow: 'IN',
        status: 'PAID',
        sourceAccount: finalAccountId, 
        method: data.paymentMode,
        sourceModule: 'POS',
        linkedDocType: 'INVOICE',
        linkedDocId: order.invoiceNum,
        entityType: 'CUSTOMER',
        entityId: data.customerId || 'WALK_IN',
        orderId: order.id,
        createdBy: 'POS_CHECKOUT'
      });

      // 2. Inventory Deduction
      for (const item of data.items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId || (item as any).id },
          include: { recipe: { include: { recipeItems: true } } }
        });

        if (product) {
          const pName = (product.name || '').trim();
          if (product.recipe && product.recipe.recipeItems.length > 0) {
            const scalar = item.quantity / product.recipe.yieldQty;
            for (const ri of product.recipe.recipeItems) {
              const quantityToDeduct = ri.quantityRequired * scalar;
              await InventoryService.recordMovement(tx, {
                itemId: ri.inventoryItemId,
                type: 'SALES_OUT',
                quantity: -quantityToDeduct,
                referenceType: 'ORDER',
                referenceId: order.id,
                note: `POS Sale: ${item.quantity}x ${product.name}`
              });
            }
          } else {
            // Direct deduction fallback
            const inventoryItem = await tx.inventoryItem.findFirst({
              where: {
                OR: [
                  { sku: product.sku || '___NONE_EXISTENT___' },
                  { name: { equals: pName, mode: 'insensitive' } }
                ],
                franchiseId: fid
              }
            });

            if (inventoryItem) {
              await InventoryService.recordMovement(tx, {
                itemId: inventoryItem.id,
                type: 'SALES_OUT',
                quantity: -item.quantity,
                referenceType: 'ORDER',
                referenceId: order.id,
                note: `Direct stock reduction: ${item.quantity}x ${product.name}`
              });
            }
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

    try {
      SocketService.io.emit('new-order', result);
    } catch (err) {
      console.error('[Socket] Failed to emit new-order (legacy)', err);
    }

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
    return this.payOrder(orderId, data.paymentMode, data.accountId);
  }
}
