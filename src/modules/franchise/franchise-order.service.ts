import prisma from '../../lib/prisma';
import { FranchiseOrderStatus, FranchiseOrderType, PaymentType, ProductType, LedgerType, FranchiseLedgerRefType } from '@prisma/client';
import { FinanceService } from '../finance/finance.service';
import { InventoryService } from '../inventory/inventory.service';
import { FranchiseService } from './franchise.service';
import SocketService from '../../lib/socket';

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `FO-${ts}-${rnd}`;
}

// Kept as a thin wrapper (rather than inlining FranchiseService calls at
// every call site) so both existing callers below — one treats "no HQ" as a
// soft no-op, the other throws a specific user-facing message — keep working
// unchanged while sharing one detection mechanism (Franchise.isHQ).
async function getHqFranchise(tx: any) {
  return FranchiseService.getHqFranchiseOrNull(tx);
}

async function findHqStockItem(tx: any, hqId: string, product: { sku: string | null; name: string }) {
  return tx.inventoryItem.findFirst({
    where: {
      franchiseId: hqId,
      OR: [
        ...(product.sku ? [{ sku: product.sku }] : []),
        { name: { contains: product.name, mode: 'insensitive' } }
      ]
    }
  });
}

// Decides whether an order can be pulled straight from HQ's finished-goods stock,
// or needs to go through production — and if so, whether the raw materials for the
// shortfall are actually on hand. Production is a fulfillment path, not a mandatory
// status: an order only needs it when HQ doesn't already have enough finished stock.
async function computeFulfillment(tx: any, orderId: string) {
  const fullOrder = await tx.franchiseOrder.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: {
          product: {
            include: { recipe: { include: { recipeItems: { include: { inventoryItem: true } } } } }
          }
        }
      }
    }
  });

  const hq = await getHqFranchise(tx);
  let allInStock = true;
  const shortfalls: Array<{
    product: string;
    neededFromProduction: number;
    recipeConfigured: boolean;
    materials: Array<{ name: string; unit: string; required: number; available: number; shortBy: number }>;
  }> = [];

  for (const item of fullOrder.items) {
    const product = item.product;
    const isFinishedGood = item.productType === ProductType.FINISHED_GOOD;

    // MADE_TO_ORDER items are never carried as HQ finished stock — they always route to production.
    const invItem = isFinishedGood && hq ? await findHqStockItem(tx, hq.id, product) : null;
    const available = invItem?.currentStock || 0;
    const shortBy = Math.max(0, item.quantity - available);

    if (shortBy <= 0) continue;
    allInStock = false;

    const recipe = product.recipe;
    if (!recipe || recipe.recipeItems.length === 0) {
      shortfalls.push({ product: product.name, neededFromProduction: shortBy, recipeConfigured: false, materials: [] });
      continue;
    }

    const materials = recipe.recipeItems.map((ri: any) => {
      const required = Math.round((ri.quantityRequired / (recipe.yieldQty || 1)) * shortBy * 100) / 100;
      const availableQty = ri.inventoryItem.currentStock || 0;
      return {
        name: ri.inventoryItem.name,
        unit: ri.unit,
        required,
        available: availableQty,
        shortBy: Math.max(0, Math.round((required - availableQty) * 100) / 100),
      };
    });

    shortfalls.push({ product: product.name, neededFromProduction: shortBy, recipeConfigured: true, materials });
  }

  const fulfillmentPath = allInStock ? 'STOCK' : 'PRODUCTION';
  const materialsReady = allInStock || shortfalls.every(s => s.recipeConfigured && s.materials.every(m => m.shortBy <= 0));

  return { fulfillmentPath, materialsReady, materialsShortfall: allInStock ? null : shortfalls };
}

export class FranchiseOrderService {
  // ─── Create Order ──────────────────────────────────────────────────────────
  static async createOrder(data: {
    franchiseId: string;
    orderType?: FranchiseOrderType;
    paymentType?: PaymentType;
    expectedDispatchDate?: string;
    priority?: string;
    notes?: string;
    items: Array<{ productId: string; quantity: number }>;
  }) {
    const orderType = data.orderType ?? FranchiseOrderType.STOCK;
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

        // FINISHED_GOOD under a STOCK order → check available stock from InventoryItem at HQ.
        // REQUEST orders (Make to Order) skip this check entirely: the franchise is asking
        // HQ to fulfill regardless of current availability, and HQ decides how/when to produce it.
        if (product.productType === ProductType.FINISHED_GOOD && orderType === FranchiseOrderType.STOCK) {
          console.log(`🔍 [OrderSync] Starting validation for: ${product.name}`);

          const hq = await getHqFranchise(tx);
          if (!hq) {
            console.error("❌ [OrderSync] Headquarters NOT FOUND in database!");
            throw new Error("Headquarters stock repository not found. Please contact administrator.");
          }

          const invItem = await findHqStockItem(tx, hq.id, product);
          const availableStock = invItem?.currentStock || 0;
          console.log(`📦 [OrderSync] Product: ${product.name} | HQ Found: ${hq.name} | Inv Match: ${invItem?.name || 'NONE'} | Stock: ${availableStock}`);

          if (availableStock < reqItem.quantity) {
            throw new Error(
              `Only ${availableStock} units available in HQ warehouse for "${product.name}". Please reduce quantity or place this as a Request / Make to Order instead.`
            );
          }
        }
        // MADE_TO_ORDER products, and any item on a REQUEST order → allowed without stock check

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

      const subtotal    = orderItems.reduce((s, i) => s + i.totalAmount, 0);
      const taxAmount   = Math.round(subtotal * 0.05); // 5% GST
      const delivery    = 50; // Flat delivery charge
      const grandTotal  = subtotal + taxAmount + delivery;

      const order = await tx.franchiseOrder.create({
        data: {
          orderNumber: generateOrderNumber(),
          franchiseId: data.franchiseId,
          orderType,
          paymentType: data.paymentType ?? PaymentType.CREDIT,
          subtotal,
          taxAmount,
          deliveryCharges: delivery,
          totalAmount: grandTotal,
          priority: data.priority ?? 'NORMAL',
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

      // 3. Create Franchise Ledger Entry (DEBIT)
      const currentFranchise = await tx.franchise.findUnique({ where: { id: data.franchiseId } });
      const newOutstanding = (currentFranchise?.outstandingAmount || 0) + grandTotal;

      await tx.franchiseLedger.create({
        data: {
          franchiseId: data.franchiseId,
          type: LedgerType.DEBIT,
          amount: grandTotal,
          balanceAfter: newOutstanding,
          referenceType: FranchiseLedgerRefType.ORDER,
          referenceId: order.orderNumber,
          note: `Order ${order.orderNumber} placed`,
        }
      });

      // 4. Update Franchise Balance
      await tx.franchise.update({
        where: { id: data.franchiseId },
        data: { outstandingAmount: newOutstanding }
      });

      // 5. Real-time Notification
      try {
        SocketService.io.emit('new-franchise-order', order);
      } catch (err) {
        console.error('[Socket] Failed to emit new-franchise-order', err);
      }

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

    // On approval, decide the fulfillment path (straight from stock vs. needs production)
    // and, if production is needed, whether the raw materials for the shortfall are on hand.
    // Re-checked on the move into production too, in case stock shifted since approval.
    if (status === FranchiseOrderStatus.APPROVED || status === FranchiseOrderStatus.IN_PRODUCTION) {
      const fulfillment = await computeFulfillment(prisma, id);
      updateData.fulfillmentPath = fulfillment.fulfillmentPath;
      updateData.materialsReady = fulfillment.materialsReady;
      updateData.materialsShortfall = fulfillment.materialsShortfall;

      // Production can't start on a shortfall the system can't back up with raw materials —
      // this mirrors the disabled state in the UI, but enforced here so it can't be bypassed.
      if (status === FranchiseOrderStatus.IN_PRODUCTION && !fulfillment.materialsReady) {
        throw new Error('Cannot start production: raw materials are insufficient (or no recipe is configured) for this order.');
      }
    }

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
            await deductBatchStock(tx, item.productId, item.quantity, order.franchiseId, id, fullOrder!.orderNumber);
          }
        }
        await tx.franchiseOrder.update({ where: { id }, data: updateData });
      });

      return prisma.franchiseOrder.findUnique({
        where: { id },
        include: { items: { include: { product: true } }, franchise: true },
      });
    }

    if (status === FranchiseOrderStatus.DELIVERED) {
      await prisma.$transaction(async tx => {
        const fullOrder = await tx.franchiseOrder.findUnique({
          where: { id },
          include: { items: { include: { product: true } } },
        });

        // Loop through all order items to fulfill inventory updates
        for (const item of fullOrder!.items) {
          if (item.productType === ProductType.FINISHED_GOOD) {
            // STOCK IMPACT: Branch Stock INCREASE
            // Increment/create the Franchise's local InventoryItem for this finished good product.
            const product = item.product;
            const invItem = await tx.inventoryItem.findFirst({
              where: {
                franchiseId: order.franchiseId,
                OR: [
                  ...(product.sku ? [{ sku: product.sku }] : []),
                  { name: { equals: product.name, mode: 'insensitive' } }
                ]
              }
            });

            if (invItem) {
              // Every stock change must leave a ledger trail — this used to
              // increment currentStock directly with no StockMovement row,
              // so the received quantity was invisible to the ledger and to
              // computeStock()-based reads (getInventory/getItemById).
              await InventoryService.recordMovement(tx, {
                itemId: invItem.id,
                type: 'TRANSFER_IN',
                quantity: item.quantity,
                referenceType: 'FRANCHISE_ORDER',
                referenceId: id,
                note: `Received from HQ dispatch (Order ${fullOrder!.orderNumber})`,
              });
            } else {
              // Create new inventory item for the franchise if it doesn't exist.
              // InventoryItem.sku is unique across the whole system, so a branch-level
              // row can't just reuse the master product's SKU once HQ already owns it —
              // scope it to this franchise, with a random fallback on the (rare) collision.
              let sku = product.sku
                ? `${product.sku}-${order.franchiseId.substring(0, 6).toUpperCase()}`
                : `SKU-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
              if (await tx.inventoryItem.findFirst({ where: { sku } })) {
                sku = `${sku}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
              }

              const newInvItem = await tx.inventoryItem.create({
                data: {
                  name: product.name,
                  sku,
                  category: 'FINISHED_GOOD',
                  currentStock: 0,
                  unit: 'PC', // Default or fetch from product
                  franchiseId: order.franchiseId,
                  basePrice: product.basePrice,
                  isActive: true
                }
              });

              // Opening balance for this branch item goes through the ledger
              // too, same as every other inflow, instead of being baked into
              // the create() call with no corresponding movement.
              await InventoryService.recordMovement(tx, {
                itemId: newInvItem.id,
                type: 'TRANSFER_IN',
                quantity: item.quantity,
                referenceType: 'FRANCHISE_ORDER',
                referenceId: id,
                note: `Initial stock received from HQ dispatch (Order ${fullOrder!.orderNumber})`,
              });
            }

            // Create a ProductBatch for the franchise so it shows up in the Branch Stock Registry
            await tx.productBatch.create({
              data: {
                productId: item.productId,
                franchiseId: order.franchiseId,
                quantity: item.quantity,
                batchCode: `RECV-${order.orderNumber.substring(3)}-${item.productId.substring(0, 4)}`,
                expiryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // Default 7 days for now
              }
            });
          }
        }
        await tx.franchiseOrder.update({ where: { id }, data: updateData });
      });

      return prisma.franchiseOrder.findUnique({
        where: { id },
        include: { items: { include: { product: true } }, franchise: true },
      });
    }

    const updatedOrder = await prisma.franchiseOrder.update({
      where: { id },
      data: updateData,
      include: { items: { include: { product: true } }, franchise: true },
    });

    try {
      SocketService.io.emit('franchise-order-updated', updatedOrder);
    } catch (err) {
      console.error('[Socket] Failed to emit franchise-order-updated', err);
    }

    return updatedOrder;
  }

  // ─── Payment ───────────────────────────────────────────────────────────────
  static async recordPayment(id: string, amount: number, accountId?: string, paidBy?: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.franchiseOrder.findUnique({ where: { id } });
      if (!order) throw new Error('Order not found');

      // Determine source account ID
      let sourceAccountId: string | undefined = accountId;
      if (!sourceAccountId) {
        // Find CASH account for the franchise (or HQ if franchiseId is null)
        const cashAcc = await tx.account.findFirst({
          where: {
            type: 'CASH',
            franchiseId: order.franchiseId || null,
          },
          select: { id: true },
        });
        if (!cashAcc) throw new Error('Default CASH account not found');
        sourceAccountId = cashAcc.id;
      }

      await tx.franchiseOrder.update({
        where: { id },
        data: { paymentStatus: 'PAID' },
      });

      // 1. Central Payment & Account Adjustment (Money IN from Franchise)
      await FinanceService.createPayment({
        tx,
        amount: amount || order.totalAmount,
        flow: 'IN',
        status: 'PAID',
        sourceAccount: sourceAccountId,
        method: order.paymentType as any,
        sourceModule: 'FRANCHISE',
        linkedDocType: 'INVOICE',
        linkedDocId: order.orderNumber,
        entityType: 'FRANCHISE',
        entityId: order.franchiseId,
        createdBy: paidBy || 'FRANCHISE_SYSTEM'
      });

      // 2. Create Franchise Ledger Entry (CREDIT)
      const currentFranchise = await tx.franchise.findUnique({ where: { id: order.franchiseId } });
      const payAmount = amount || order.totalAmount;
      const newOutstanding = (currentFranchise?.outstandingAmount || 0) - payAmount;

      await tx.franchiseLedger.create({
        data: {
          franchiseId: order.franchiseId,
          type: LedgerType.CREDIT,
          amount: payAmount,
          balanceAfter: newOutstanding,
          referenceType: FranchiseLedgerRefType.PAYMENT,
          referenceId: order.orderNumber,
          note: `Payment for order ${order.orderNumber}`,
        }
      });

      // 3. Update Franchise Balance
      return tx.franchise.update({
        where: { id: order.franchiseId },
        data: { outstandingAmount: newOutstanding }
      });
    });
  }
}

// FIFO batch deduction
async function deductBatchStock(tx: any, productId: string, quantityNeeded: number, franchiseId?: string, orderId?: string, orderNumber?: string) {
  const batches = await tx.productBatch.findMany({
    where: {
      productId,
      ...(franchiseId ? { franchiseId } : {}),
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

  // Synchronize with Master InventoryItem at HQ
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (product) {
    const hq = await FranchiseService.getHqFranchiseOrNull(tx);

    if (hq) {
      const invItem = await tx.inventoryItem.findFirst({
        where: {
          franchiseId: hq.id,
          OR: [
            ...(product.sku ? [{ sku: product.sku }] : []),
            { name: { equals: product.name, mode: 'insensitive' } }
          ]
        }
      });

      if (invItem) {
        // Ledger-backed decrement — this used to bypass StockMovement
        // entirely, so HQ's dispatch to a franchise never appeared in the
        // ledger even though currentStock changed.
        await InventoryService.recordMovement(tx, {
          itemId: invItem.id,
          type: 'TRANSFER_OUT',
          quantity: -quantityNeeded,
          referenceType: 'FRANCHISE_ORDER',
          referenceId: orderId,
          note: orderNumber ? `Dispatched to franchise (Order ${orderNumber})` : 'Dispatched to franchise',
        });
      }
    }
  }

  // We allow dispatch even if batch stock is 0 (over-dispatch) as per earlier discussion
  // but we log it. If you want to block it, uncomment below:
  // if (remaining > 0) throw new Error(`Insufficient batch stock...`);
}
