import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import SocketService from '../../lib/socket';
import { FinanceService } from '../finance/finance.service';
import { AuditService } from '../audit/audit.service';
import { AccountService } from '../finance/account.service';
import { FranchiseService } from '../franchise/franchise.service';

export class POSService {

  // --- NEW NATIVE API FLOW (Step-by-Step) ---

  // Step 1: Create empty order shell
  static async createOrder(data: { franchiseId?: string, customerId?: string, orderType?: string }) {
    let fid: string | undefined = data.franchiseId;

    // Safety check: verify an explicitly-passed franchise actually exists.
    if (fid) {
      const exists = await prisma.franchise.findUnique({ where: { id: fid } });
      if (!exists) fid = undefined;
    }

    // No (valid) franchise given — default to HQ, not a literal id that may
    // not correspond to any real franchise in this database.
    if (!fid) {
      const hq = await FranchiseService.getHqFranchiseOrNull();
      fid = hq?.id;
    }

    if (!fid) {
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
           const prod = await tx.product.findUnique({ where: { id: it.productId } });
           if (!prod) throw new Error(`Product ${it.productId} not found`);
           if (price === undefined) {
             price = prod.basePrice;
           }
           if (price <= 0) {
             throw new Error(`Product "${prod.name}" does not have a valid selling price configured. Please update its Customer Retail price in inventory.`);
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

    // Phase 5: Trigger Accounting (Invoice & Payment) after update succeeds.
    // Ledger and invoice creation are posted independently — a walk-in order
    // has no customerId, so CustomerLedger (which requires one) is skipped
    // for it, but the Invoice (the record P&L/reports actually read) must
    // still get created regardless of whether that ledger entry was posted.
    if (status === 'COMPLETED') {
        if (order.customerId) {
            try {
                await prisma.customerLedger.create({
                  data: {
                    customerId: order.customerId,
                    type: 'DEBIT',
                    amount: order.totalAmount,
                    paymentMode: 'CASH', // Placeholder until payment
                    referenceType: 'SALE',
                    referenceId: order.id,
                    note: `POS Sale — Invoice #${order.invoiceNum}`
                  }
                });
            } catch (ledgerErr) {
                console.error('[Accounting] Failed to create customer ledger entry', ledgerErr);
            }
        }
        try {
            await FinanceService.createInvoiceFromOrder(orderId);
        } catch (invErr) {
            console.error('[Accounting] Failed to create invoice', invErr);
        }
    }

    return order;
  }

  // Core Deduction Engine wrapped in DB Transaction
  static async deductInventoryIfNecessary(orderId: string, externalTx?: any) {
    const run = async (tx: any) => {
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
             // Actual FIFO cost of whatever this line item consumed, summed
             // across its recipe ingredients, instead of relying on a live
             // recipe-average recompute at P&L time.
             let lineCost = 0;

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
               const { fifo } = await InventoryService.recordMovement(tx, {
                 itemId: item.inventoryItemId,
                 type: 'SALES_OUT',
                 quantity: -required,
                 referenceType: 'ORDER',
                 referenceId: order.id,
                 note: `Auto-deduction for Order ${order.invoiceNum} (Product: ${product.name})`
               });

               const untracked = required - (fifo?.consumedFromBatches || 0);
               lineCost += (fifo?.totalCost || 0) + untracked * (inventoryItem.costPrice || 0);
             }

             await tx.orderItem.update({
               where: { id: orderItem.id },
               data: {
                 unitCost: orderItem.quantity > 0 ? lineCost / orderItem.quantity : 0,
                 totalCost: lineCost,
               },
             });
           } else {
             // FALLBACK: If no recipe exists, deduct directly from the
             // InventoryItem with matching SKU or Name. order.franchiseId is
             // a real Franchise id (Order.franchiseId is a required column,
             // never null) — but InventoryItem scoping uses the separate
             // null-means-HQ convention, so it must be resolved through the
             // same canonical converter every other writer uses, not
             // compared to order.franchiseId directly. Comparing directly
             // is exactly what silently found nothing for every correctly
             // HQ-scoped (franchiseId=NULL) item once normalized.
             const scopeFranchiseId = await FranchiseService.toInventoryScopeId(tx, order.franchiseId);
             // Match by SKU alone when the product has one — OR-ing in a
             // name match let two distinctly-SKU'd weight variants sharing
             // the same product name (e.g. 250G/500G) collide, since
             // findFirst has no reason to prefer the SKU-matching row over
             // any other row the name also matches. Name-only lookup is
             // only correct for the legacy case of a product with no SKU.
             const inventoryItem = product.sku
               ? await tx.inventoryItem.findFirst({ where: { sku: product.sku, franchiseId: scopeFranchiseId } })
               : await tx.inventoryItem.findFirst({ where: { name: { equals: product.name, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });

             // A silent no-op here used to let the sale, payment, and
             // account balance all complete while reporting
             // inventory_deducted=true with zero stock actually moved — and
             // that flag then permanently blocked any retry (see the
             // "Safety 2" guard above). Failing the whole transaction is
             // the safe behavior: no Order, no Payment, no Account update,
             // no false inventory_deducted, until the real mapping exists.
             if (!inventoryItem) {
               throw new Error(`Inventory item not found for SKU ${product.sku || product.name} — cannot complete this sale.`);
             }

             // Apply unit conversion
             const conversionResult = await InventoryService.convertUnitToBase(inventoryItem.id, orderItem.unit || 'NONE', orderItem.quantity, tx);
             const requiredBaseQty = conversionResult.requiredBaseQty;
             const unitId = conversionResult.unitId;

             if (inventoryItem.currentStock < requiredBaseQty) {
               throw new Error(`Out of stock: ${inventoryItem.name}. Required: ${requiredBaseQty} (Base Units), Stock: ${inventoryItem.currentStock}`);
             }

             // This is the path finished goods sold as-is (produced via the
             // Production module) take — so `fifo` here reflects the exact
             // ProductBatch(es) this sale drew from (see InventoryBatch.productBatchId).
             const { fifo } = await InventoryService.recordMovement(tx, {
               itemId: inventoryItem.id,
               type: 'SALES_OUT',
               quantity: -orderItem.quantity, // original selected quantity
               baseQty: -requiredBaseQty,     // converted base quantity
               transactionUnit: unitId,
               referenceType: 'ORDER',
               referenceId: order.id,
               note: `Direct auto-deduction for Order ${order.invoiceNum} (No recipe)`
             });

             const untracked = requiredBaseQty - (fifo?.consumedFromBatches || 0);
             const totalCost = (fifo?.totalCost || 0) + untracked * (inventoryItem.costPrice || 0);
             await tx.orderItem.update({
               where: { id: orderItem.id },
               data: {
                 unitCost: orderItem.quantity > 0 ? totalCost / orderItem.quantity : 0,
                 totalCost,
               },
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
    };
    return externalTx ? run(externalTx) : prisma.$transaction(run);
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
      franchiseId: order.franchiseId,
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
    // Validate prices first before proceeding
    if (data.items) {
      for (const item of data.items) {
        const price = item.price || (item as any).unitPrice || 0;
        if (price <= 0) {
          throw new Error(`Cannot checkout. One or more items do not have a valid selling price configured.`);
        }
      }
    }

    let fid = data.franchiseId;
    if (!fid) {
      // "First active franchise" is not a valid definition of HQ (see
      // FranchiseService.getHqFranchise) — an arbitrary branch silently
      // absorbing a checkout meant for HQ is worse than a clear error here.
      const hq = await FranchiseService.getHqFranchiseOrNull();
      fid = hq?.id;
      if (!fid) throw new Error('No HQ franchise is configured (Franchise.isHQ). Set isHQ=true on exactly one franchise before checking out without an explicit franchise.');
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
      const accountTypeMap: Record<string, string> = {
        'CASH': 'CASH',
        'UPI': 'UPI',
        'CARD': 'BANK',
        'BANK_TRANSFER': 'BANK'
      };
      const targetType = accountTypeMap[data.paymentMode] || 'CASH';
      
      // Use provided accountId or fallback to default for the payment mode
      let finalAccountId = data.accountId;
      if (!finalAccountId || finalAccountId === "") {
        const defaultAccount = await tx.account.findFirst({
          where: { 
            type: targetType as any,
            franchiseId: fid || null
          }
        });
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
        franchiseId: fid,
        createdBy: 'POS_CHECKOUT'
      });

      // 2. Inventory Deduction
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        // orderItems was created from data.items in the same order above, so
        // index-align to attach real FIFO cost back onto the matching line.
        const orderItem = order.orderItems[i];
        const product = await tx.product.findUnique({
          where: { id: item.productId || (item as any).id },
          include: { recipe: { include: { recipeItems: true } } }
        });

        if (product) {
          const pName = (product.name || '').trim();
          let lineCost = 0;
          if (product.recipe && product.recipe.recipeItems.length > 0) {
            const scalar = item.quantity / product.recipe.yieldQty;
            for (const ri of product.recipe.recipeItems) {
              const quantityToDeduct = ri.quantityRequired * scalar;
              const invItem = await tx.inventoryItem.findUnique({ where: { id: ri.inventoryItemId } });
              const { fifo } = await InventoryService.recordMovement(tx, {
                itemId: ri.inventoryItemId,
                type: 'SALES_OUT',
                quantity: -quantityToDeduct,
                referenceType: 'ORDER',
                referenceId: order.id,
                note: `POS Sale: ${item.quantity}x ${product.name}`
              });
              const untracked = quantityToDeduct - (fifo?.consumedFromBatches || 0);
              lineCost += (fifo?.totalCost || 0) + untracked * (invItem?.costPrice || 0);
            }
          } else {
            // Direct deduction fallback. fid is a real Franchise id (never
            // null) but InventoryItem scoping uses the separate null-means-
            // HQ convention — resolve through the same canonical converter
            // every other writer uses rather than comparing to fid
            // directly, which silently found nothing for every correctly
            // HQ-scoped (franchiseId=NULL) item once normalized.
            const scopeFranchiseId = await FranchiseService.toInventoryScopeId(tx, fid);
            // Match by SKU alone when the product has one — see the
            // identical fix/comment in deductInventoryIfNecessary above.
            // OR-ing in a name match let same-named weight variants
            // (e.g. 250G/500G) collide onto whichever row the name also
            // matched, ignoring the more specific SKU match.
            const inventoryItem = product.sku
              ? await tx.inventoryItem.findFirst({ where: { sku: product.sku, franchiseId: scopeFranchiseId } })
              : await tx.inventoryItem.findFirst({ where: { name: { equals: pName, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });

            // A silent no-op here used to let the whole transaction (Order,
            // Payment, Account balance) commit while inventory_deducted got
            // set true with zero stock actually moved. Throwing rolls back
            // this entire $transaction — no Order, no Payment, no Account
            // update — instead of reporting a sale that never happened.
            if (!inventoryItem) {
              throw new Error(`Inventory item not found for SKU ${product.sku || pName} — cannot complete this sale.`);
            }

            const itemUnit = (item as any).unit || 'NONE';
            const conversionResult = await InventoryService.convertUnitToBase(inventoryItem.id, itemUnit, item.quantity, tx);
            const requiredBaseQty = conversionResult.requiredBaseQty;
            const unitId = conversionResult.unitId;

            if (inventoryItem.currentStock < requiredBaseQty) {
              throw new Error(`Out of stock: ${inventoryItem.name}. Required: ${requiredBaseQty} (Base Units), Stock: ${inventoryItem.currentStock}`);
            }

            const { fifo } = await InventoryService.recordMovement(tx, {
              itemId: inventoryItem.id,
              type: 'SALES_OUT',
              quantity: -item.quantity,
              baseQty: -requiredBaseQty,
              transactionUnit: unitId,
              referenceType: 'ORDER',
              referenceId: order.id,
              note: `Direct stock reduction: ${item.quantity}x ${product.name}`
            });
            const untracked = requiredBaseQty - (fifo?.consumedFromBatches || 0);
            lineCost = (fifo?.totalCost || 0) + untracked * (inventoryItem.costPrice || 0);
          }

          if (orderItem) {
            await tx.orderItem.update({
              where: { id: orderItem.id },
              data: {
                unitCost: item.quantity > 0 ? lineCost / item.quantity : 0,
                totalCost: lineCost,
              },
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
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        orderItems: { include: { product: true } },
        customer: true,
        payments: true,
        franchise: true
      }
    });
    if (!order) return null;

    // Party name resolution: Order.customerName is a point-in-time snapshot
    // (see SalesService.convertProformaToInvoice) so Orders created before
    // that field existed, or a Customer whose name changed since, still need
    // a live fallback. The `customer` relation above only ever covers
    // partyType CUSTOMER — DEALER/FRANCHISE have no FK relation on Order.
    let customerName = order.customerName || order.customer?.name || null;
    if (!customerName && order.partyId) {
      if (order.partyType === 'DEALER') {
        const dealer = await prisma.dealer.findUnique({ where: { id: order.partyId } });
        customerName = dealer?.name || null;
      } else if (order.partyType === 'FRANCHISE') {
        const franchise = await prisma.franchise.findUnique({ where: { id: order.partyId } });
        customerName = franchise?.name || null;
      }
    }

    let sourceProformaNumber: string | null = null;
    if (order.sourceProformaInvoiceId) {
      const proforma = await prisma.proformaInvoice.findUnique({
        where: { id: order.sourceProformaInvoiceId },
        select: { proformaNumber: true }
      });
      sourceProformaNumber = proforma?.proformaNumber || null;
    }

    return { ...order, customerName, sourceProformaNumber };
  }

  static async addPayment(orderId: string, data: any) {
    return this.payOrder(orderId, data.paymentMode, data.accountId);
  }

  // --- Day Closing / Settlement ---
  // Previously the "Settle" button on the frontend was a pure UI simulation
  // (setTimeout + toast, no backend call) — nothing was persisted and nothing
  // prevented settling the same business day twice. `businessDate` is always
  // computed server-side (never trusted from the client) to stop that.

  private static startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  static async getTodaySettlement(franchiseId: string) {
    return prisma.dailySettlement.findUnique({
      where: { franchiseId_businessDate: { franchiseId, businessDate: this.startOfToday() } }
    });
  }

  static async getLatestSettlement(franchiseId: string) {
    return prisma.dailySettlement.findFirst({
      where: { franchiseId },
      orderBy: { businessDate: 'desc' }
    });
  }

  static async closeDay(franchiseId: string, data: {
    cashTotal: number; upiTotal: number; cardTotal: number; grandTotal: number; orderCount: number;
  }, closedBy?: string) {
    const businessDate = this.startOfToday();

    const existing = await prisma.dailySettlement.findUnique({
      where: { franchiseId_businessDate: { franchiseId, businessDate } }
    });
    if (existing) throw new Error('Today has already been settled.');

    return prisma.dailySettlement.create({
      data: {
        franchiseId,
        businessDate,
        cashTotal: data.cashTotal || 0,
        upiTotal: data.upiTotal || 0,
        cardTotal: data.cardTotal || 0,
        grandTotal: data.grandTotal || 0,
        orderCount: data.orderCount || 0,
        closedBy
      }
    });
  }
}
