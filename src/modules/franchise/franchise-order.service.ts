import prisma from '../../lib/prisma';
import { FranchiseOrderStatus, FranchiseOrderType, FranchiseOrderFulfillment, PaymentType, ProductType, LedgerType, FranchiseLedgerRefType } from '@prisma/client';
import { FinanceService } from '../finance/finance.service';
import { AccountService } from '../finance/account.service';
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

async function findHqStockItem(tx: any, hqId: string | null | undefined, product: { sku?: string | null; name: string }) {
  const scopeFilter = hqId
    ? { OR: [{ franchiseId: hqId }, { franchiseId: null }] }
    : { franchiseId: null };

  if (product.sku) {
    const itemBySku = await tx.inventoryItem.findFirst({
      where: {
        AND: [
          scopeFilter,
          { sku: { equals: product.sku, mode: 'insensitive' } }
        ]
      }
    });
    if (itemBySku) return itemBySku;
  }

  return tx.inventoryItem.findFirst({
    where: {
      AND: [
        scopeFilter,
        { name: { equals: product.name, mode: 'insensitive' } }
      ]
    }
  });
}

// Decides whether an order can be pulled straight from HQ's finished-goods stock,
// or needs to go through production based on orderType (STOCK vs REQUEST) and live HQ inventory.
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

  if (!fullOrder) {
    return { fulfillmentPath: FranchiseOrderFulfillment.STOCK, materialsReady: true, materialsShortfall: null };
  }

  // FLOW 1: Check Stock & Order -> strictly STOCK fulfillment (no production)
  if (fullOrder.orderType === FranchiseOrderType.STOCK) {
    return { fulfillmentPath: FranchiseOrderFulfillment.STOCK, materialsReady: true, materialsShortfall: null };
  }

  const hq = await FranchiseService.getHqFranchiseOrNull(tx);
  const hqId = hq?.id || null;

  const shortfalls: Array<{
    product: string;
    neededFromProduction: number;
    recipeConfigured: boolean;
    materials: Array<{ name: string; unit: string; required: number; available: number; shortBy: number }>;
  }> = [];

  for (const item of fullOrder.items) {
    const product = item.product;
    const requestedQty = Number(item.quantity || 0);

    // Look up HQ finished good stock for this product
    const hqItem = await findHqStockItem(tx, hqId, product);
    const availableHqStock = Math.max(0, Number(hqItem?.currentStock || 0));

    const neededFromProduction = Math.max(0, requestedQty - availableHqStock);

    if (neededFromProduction <= 0) {
      // Line item is fully covered by existing HQ finished goods stock!
      continue;
    }

    const recipe = product.recipe;
    if (!recipe || !recipe.recipeItems || recipe.recipeItems.length === 0) {
      shortfalls.push({
        product: product.name,
        neededFromProduction,
        recipeConfigured: false,
        materials: []
      });
      continue;
    }

    const materials = recipe.recipeItems.map((ri: any) => {
      const required = Math.round((ri.quantityRequired / (recipe.yieldQty || 1)) * neededFromProduction * 100) / 100;
      const availableQty = ri.inventoryItem?.currentStock || 0;
      return {
        name: ri.inventoryItem?.name || 'Raw Material',
        unit: ri.unit,
        required,
        available: availableQty,
        shortBy: Math.max(0, Math.round((required - availableQty) * 100) / 100),
      };
    });

    shortfalls.push({
      product: product.name,
      neededFromProduction,
      recipeConfigured: true,
      materials
    });
  }

  if (shortfalls.length === 0) {
    return { fulfillmentPath: FranchiseOrderFulfillment.STOCK, materialsReady: true, materialsShortfall: null };
  }

  const materialsReady = shortfalls.every(s => s.recipeConfigured && s.materials.every(m => m.shortBy <= 0));
  return { fulfillmentPath: FranchiseOrderFulfillment.PRODUCTION, materialsReady, materialsShortfall: shortfalls };
}

function computeFulfillmentForOrderSync(order: any, hqInventoryMap: { bySku: Map<string, any>; byName: Map<string, any> }) {
  if (order.orderType === FranchiseOrderType.STOCK) {
    return { fulfillmentPath: FranchiseOrderFulfillment.STOCK, materialsReady: true, materialsShortfall: null };
  }

  const shortfalls: Array<{
    product: string;
    neededFromProduction: number;
    recipeConfigured: boolean;
    materials: Array<{ name: string; unit: string; required: number; available: number; shortBy: number }>;
  }> = [];

  for (const item of (order.items || [])) {
    const product = item.product;
    if (!product) continue;
    const requestedQty = Number(item.quantity || 0);

    const hqItem = (product.sku && hqInventoryMap.bySku.get(product.sku.toUpperCase()))
      || hqInventoryMap.byName.get(product.name.toUpperCase());

    const availableHqStock = Math.max(0, Number(hqItem?.currentStock || 0));
    const neededFromProduction = Math.max(0, requestedQty - availableHqStock);

    if (neededFromProduction <= 0) {
      continue;
    }

    const recipe = product.recipe;
    if (!recipe || !recipe.recipeItems || recipe.recipeItems.length === 0) {
      shortfalls.push({
        product: product.name,
        neededFromProduction,
        recipeConfigured: false,
        materials: []
      });
      continue;
    }

    const materials = recipe.recipeItems.map((ri: any) => {
      const required = Math.round((ri.quantityRequired / (recipe.yieldQty || 1)) * neededFromProduction * 100) / 100;
      const availableQty = ri.inventoryItem?.currentStock || 0;
      return {
        name: ri.inventoryItem?.name || 'Raw Material',
        unit: ri.unit,
        required,
        available: availableQty,
        shortBy: Math.max(0, Math.round((required - availableQty) * 100) / 100),
      };
    });

    shortfalls.push({
      product: product.name,
      neededFromProduction,
      recipeConfigured: true,
      materials
    });
  }

  if (shortfalls.length === 0) {
    return { fulfillmentPath: FranchiseOrderFulfillment.STOCK, materialsReady: true, materialsShortfall: null };
  }

  const materialsReady = shortfalls.every(s => s.recipeConfigured && s.materials.every(m => m.shortBy <= 0));
  return { fulfillmentPath: FranchiseOrderFulfillment.PRODUCTION, materialsReady, materialsShortfall: shortfalls };
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
    const orderType = data.orderType ?? FranchiseOrderType.REQUEST;
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
      let lineTax = 0;

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
        // Per-product tax rate (matches how POSService.checkout/the Counter
        // Billing frontend compute GST) instead of a flat 5% applied to the
        // whole order regardless of what's actually in it.
        lineTax += Number((totalAmount * (product.taxPercent / 100)).toFixed(2));
      }

      const subtotal    = orderItems.reduce((s, i) => s + i.totalAmount, 0);
      const taxAmount   = 0; // Excluded for Franchise Product Orders
      const delivery    = 0; // No delivery charge for Franchise Product Orders
      const grandTotal  = subtotal;

      const order = await tx.franchiseOrder.create({
        data: {
          orderNumber: generateOrderNumber(),
          franchiseId: data.franchiseId,
          orderType,
          paymentType: data.paymentType ?? PaymentType.CREDIT,
          subtotal,
          taxAmount: 0,
          deliveryCharges: 0,
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

      const fulfillment = await computeFulfillment(tx, order.id);
      await tx.franchiseOrder.update({
        where: { id: order.id },
        data: {
          fulfillmentPath: fulfillment.fulfillmentPath,
          materialsReady: fulfillment.materialsReady,
          materialsShortfall: fulfillment.materialsShortfall as any,
        }
      });
      (order as any).fulfillmentPath = fulfillment.fulfillmentPath;
      (order as any).materialsReady = fulfillment.materialsReady;
      (order as any).materialsShortfall = fulfillment.materialsShortfall as any;

      return order;
    });
  }

  // ─── Get Orders ────────────────────────────────────────────────────────────
  static async getOrders(filters: { franchiseId?: string; status?: FranchiseOrderStatus }) {
    const orders = await prisma.franchiseOrder.findMany({
      where: {
        ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        items: {
          include: {
            product: {
              include: {
                recipe: {
                  include: {
                    recipeItems: {
                      include: {
                        inventoryItem: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        franchise: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (orders.length === 0) return [];

    const hq = await FranchiseService.getHqFranchiseOrNull(prisma);
    const hqId = hq?.id || null;

    const hqInventory = await prisma.inventoryItem.findMany({
      where: {
        OR: hqId ? [{ franchiseId: hqId }, { franchiseId: null }] : [{ franchiseId: null }]
      }
    });

    const hqInventoryMap = {
      bySku: new Map<string, any>(),
      byName: new Map<string, any>()
    };

    for (const it of hqInventory) {
      if (it.sku) hqInventoryMap.bySku.set(it.sku.toUpperCase(), it);
      if (it.name) hqInventoryMap.byName.set(it.name.toUpperCase(), it);
    }

    const orderIds = orders.map(o => o.id);
    const orderNumbers = orders.map(o => o.orderNumber);

    const salesOrders = await prisma.order.findMany({
      where: {
        OR: [
          { sourceQuotationId: { in: orderIds } },
          { invoice: { notes: { in: orderNumbers.map(num => `Franchise Order Ref: ${num}`) } } },
        ]
      },
      include: { invoice: true }
    });

    const invoiceByOrderId = new Map<string, { id: string; invoiceNum: string; status: string; finalAmount: number }>();
    const invoiceByOrderNumber = new Map<string, { id: string; invoiceNum: string; status: string; finalAmount: number }>();

    for (const so of salesOrders) {
      if (so.invoice) {
        const invData = {
          id: so.invoice.id,
          invoiceNum: so.invoiceNum,
          status: so.invoice.status,
          finalAmount: so.invoice.finalAmount,
        };
        if (so.sourceQuotationId) {
          invoiceByOrderId.set(so.sourceQuotationId, invData);
        }
        for (const oNum of orderNumbers) {
          if (so.invoice.notes?.includes(oNum)) {
            invoiceByOrderNumber.set(oNum, invData);
          }
        }
      }
    }

    return orders.map(order => {
      const inv = invoiceByOrderId.get(order.id) || invoiceByOrderNumber.get(order.orderNumber) || null;

      // Dynamically re-evaluate fulfillment readiness for active orders against live HQ inventory
      let fulfillment: {
        fulfillmentPath: FranchiseOrderFulfillment | null;
        materialsReady: boolean | null;
        materialsShortfall: any;
      } = {
        fulfillmentPath: order.fulfillmentPath,
        materialsReady: order.materialsReady,
        materialsShortfall: order.materialsShortfall,
      };

      if (order.status === FranchiseOrderStatus.PENDING || order.status === FranchiseOrderStatus.APPROVED) {
        fulfillment = computeFulfillmentForOrderSync(order, hqInventoryMap);
      }

      return {
        ...order,
        ...fulfillment,
        hasInvoice: !!inv,
        invoice: inv,
        invoiceNum: inv?.invoiceNum || null,
        invoiceId: inv?.id || null,
      };
    });
  }

  static async getOrderById(id: string) {
    const order = await prisma.franchiseOrder.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              include: {
                recipe: {
                  include: {
                    recipeItems: {
                      include: {
                        inventoryItem: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        franchise: true,
      },
    });
    if (!order) return null;

    const hq = await FranchiseService.getHqFranchiseOrNull(prisma);
    const hqId = hq?.id || null;

    const hqInventory = await prisma.inventoryItem.findMany({
      where: {
        OR: hqId ? [{ franchiseId: hqId }, { franchiseId: null }] : [{ franchiseId: null }]
      }
    });

    const hqInventoryMap = {
      bySku: new Map<string, any>(),
      byName: new Map<string, any>()
    };

    for (const it of hqInventory) {
      if (it.sku) hqInventoryMap.bySku.set(it.sku.toUpperCase(), it);
      if (it.name) hqInventoryMap.byName.set(it.name.toUpperCase(), it);
    }

    let fulfillment: {
      fulfillmentPath: FranchiseOrderFulfillment | null;
      materialsReady: boolean | null;
      materialsShortfall: any;
    } = {
      fulfillmentPath: order.fulfillmentPath,
      materialsReady: order.materialsReady,
      materialsShortfall: order.materialsShortfall,
    };

    if (order.status === FranchiseOrderStatus.PENDING || order.status === FranchiseOrderStatus.APPROVED) {
      fulfillment = computeFulfillmentForOrderSync(order, hqInventoryMap);
    }

    const salesOrder = await prisma.order.findFirst({
      where: {
        OR: [
          { sourceQuotationId: order.id },
          { invoice: { notes: { contains: order.orderNumber } } }
        ]
      },
      include: { invoice: true }
    });

    const inv = salesOrder?.invoice ? {
      id: salesOrder.invoice.id,
      invoiceNum: salesOrder.invoiceNum,
      status: salesOrder.invoice.status,
      finalAmount: salesOrder.invoice.finalAmount,
    } : null;

    return {
      ...order,
      ...fulfillment,
      hasInvoice: !!inv,
      invoice: inv,
      invoiceNum: inv?.invoiceNum || null,
      invoiceId: inv?.id || null,
    };
  }

  // ─── Status Transitions ────────────────────────────────────────────────────
  static async updateStatus(
    id: string,
    status: FranchiseOrderStatus,
    extra?: { actualDispatchDate?: string }
  ) {
    const order = await prisma.franchiseOrder.findUnique({ where: { id } });
    if (!order) throw new Error('Order not found');

    // Receiving is a one-way, strictly-gated transition: only a currently
    // DISPATCHED order can be marked DELIVERED. Blocks double-click, browser
    // retry, and duplicate/concurrent requests from re-running the inventory
    // credit below — checked here (before any work) and re-checked inside
    // the transaction below (against a fresh read) to close the race window.
    if (status === FranchiseOrderStatus.DELIVERED && order.status !== FranchiseOrderStatus.DISPATCHED) {
      throw new Error(`Cannot mark order as DELIVERED: order is currently "${order.status}", not "DISPATCHED". This receipt may have already been processed.`);
    }

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
        const hq = await FranchiseService.getHqFranchiseOrNull(tx);
        for (const item of fullOrder!.items) {
          if (item.productType === ProductType.FINISHED_GOOD) {
            await deductBatchStock(tx, item.productId, item.quantity, hq?.id, id, fullOrder!.orderNumber);
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

        // Re-check inside the transaction against a fresh read, in case a
        // concurrent request already delivered this order between the
        // pre-check above and this transaction acquiring the row.
        if (fullOrder!.status !== FranchiseOrderStatus.DISPATCHED) {
          throw new Error(`Cannot mark order as DELIVERED: order is currently "${fullOrder!.status}", not "DISPATCHED". This receipt may have already been processed.`);
        }

        // Loop through all order items to fulfill inventory updates
        for (const item of fullOrder!.items) {
          if (item.productType === ProductType.FINISHED_GOOD) {
            // STOCK IMPACT: Branch Stock INCREASE
            // Increment/create the Franchise's local InventoryItem for this finished good product.
            const product = item.product;
            // Match by SKU alone when the product has one — OR-ing in a name match
            // let two distinctly-SKU'd weight variants sharing the same product name
            // (e.g. 450G/900G) collide, collapsing different variants onto a single row.
            const invItem = product.sku
              ? await tx.inventoryItem.findFirst({
                  where: {
                    franchiseId: order.franchiseId,
                    sku: product.sku,
                  },
                })
              : await tx.inventoryItem.findFirst({
                  where: {
                    franchiseId: order.franchiseId,
                    name: { equals: product.name, mode: 'insensitive' },
                  },
                });

            if (invItem) {
              // Every stock change must leave a ledger trail — record receiveAtCost so
              // the receiving franchise lot carries the wholesale acquisition price (item.unitPrice).
              await InventoryService.recordMovement(tx, {
                itemId: invItem.id,
                type: 'TRANSFER_IN',
                quantity: item.quantity,
                referenceType: 'FRANCHISE_ORDER',
                referenceId: id,
                note: `Received from HQ dispatch (Order ${fullOrder!.orderNumber})`,
                receiveAtCost: { unitCost: item.unitPrice, batchNumber: `FO-${fullOrder!.orderNumber}` }
              });
            } else {
              // Create new inventory item for the franchise if it doesn't exist.
              // InventoryItem is scoped per franchise (@@unique([sku, franchiseId])),
              // so the franchise row preserves the exact Product SKU.
              let sku = product.sku || `SKU-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

              const newInvItem = await tx.inventoryItem.create({
                data: {
                  name: product.name,
                  sku,
                  category: 'FINISHED_GOOD',
                  currentStock: 0,
                  unit: 'PC', // Default or fetch from product
                  franchiseId: order.franchiseId,
                  basePrice: product.basePrice,
                  costPrice: item.unitPrice,
                  isActive: true
                }
              });

              // Opening balance for this branch item goes through the ledger
              // with the exact wholesale acquisition price (item.unitPrice).
              await InventoryService.recordMovement(tx, {
                itemId: newInvItem.id,
                type: 'TRANSFER_IN',
                quantity: item.quantity,
                referenceType: 'FRANCHISE_ORDER',
                referenceId: id,
                note: `Initial stock received from HQ dispatch (Order ${fullOrder!.orderNumber})`,
                receiveAtCost: { unitCost: item.unitPrice, batchNumber: `FO-${fullOrder!.orderNumber}` }
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
      const order = await tx.franchiseOrder.findUnique({
        where: { id },
        include: { franchise: true }
      });
      if (!order) throw new Error('Order not found');

      if (order.paymentStatus === 'PAID') {
        throw new Error('This order has already been paid.');
      }

      const payAmount = (amount && amount > 0) ? amount : order.totalAmount;
      if (!(payAmount > 0)) {
        throw new Error('Payment amount must be greater than zero.');
      }

      // 1. Resolve & Validate Franchise Payment Account
      let franchiseAcc: any = null;

      if (accountId) {
        franchiseAcc = await tx.account.findUnique({ where: { id: accountId } });
        if (!franchiseAcc || franchiseAcc.franchiseId !== order.franchiseId) {
          throw new Error('Selected payment account was not found or does not belong to your franchise.');
        }
      } else {
        // Fallback to the first active account configured for this franchise
        franchiseAcc = await tx.account.findFirst({
          where: {
            franchiseId: order.franchiseId,
            status: 'ACTIVE'
          },
          orderBy: [{ type: 'asc' }, { createdAt: 'asc' }]
        });
      }

      if (!franchiseAcc) {
        throw new Error(
          `No active Bank or Cash Account found for ${order.franchise?.name || 'this franchise'}. Please configure a Bank Account in the Franchise section first.`
        );
      }

      if (franchiseAcc.status !== 'ACTIVE') {
        throw new Error(`The selected account "${franchiseAcc.name}" is inactive. Please select an active account.`);
      }

      // 2. Validate Franchise Account Balance
      if (franchiseAcc.balance < payAmount) {
        throw new Error(
          `Insufficient Franchise Account Balance in "${franchiseAcc.name}". Available: ₹${franchiseAcc.balance.toLocaleString('en-IN')}, Required: ₹${payAmount.toLocaleString('en-IN')}.`
        );
      }

      // 3. Debit Franchise Account (OUTFLOW)
      await AccountService.adjustBalance(tx, franchiseAcc.id, payAmount, 'OUTFLOW');

      // 4. Record Franchise OUTFLOW Payment
      await tx.payment.create({
        data: {
          paidAmount: payAmount,
          status: 'SUCCESS',
          accountId: franchiseAcc.id,
          paymentMode: (franchiseAcc.type === 'BANK' ? 'BANK_TRANSFER' : (franchiseAcc.type === 'UPI' ? 'UPI' : 'CASH')) as any,
          sourceModule: 'FRANCHISE',
          linkedDocType: 'INVOICE',
          linkedDocId: order.orderNumber,
          entityType: 'FRANCHISE',
          entityId: order.franchiseId,
          transactionRef: `Payment to HQ for order ${order.orderNumber} via ${franchiseAcc.name}`,
          createdBy: paidBy || 'FRANCHISE_SYSTEM'
        }
      });

      // 5. Update Franchise Ledger (CREDIT reducing outstanding balance to HQ)
      const currentFranchise = await tx.franchise.findUnique({ where: { id: order.franchiseId } });
      const newOutstanding = (currentFranchise?.outstandingAmount || 0) - payAmount;

      await tx.franchiseLedger.create({
        data: {
          franchiseId: order.franchiseId,
          type: LedgerType.CREDIT,
          amount: payAmount,
          balanceAfter: newOutstanding,
          referenceType: FranchiseLedgerRefType.PAYMENT,
          referenceId: order.orderNumber,
          note: `Payment to HQ for order ${order.orderNumber} via ${franchiseAcc.name}`,
        }
      });

      // 6. Update Franchise Outstanding Amount
      await tx.franchise.update({
        where: { id: order.franchiseId },
        data: { outstandingAmount: newOutstanding }
      });

      // 7. Credit HQ Collections & Receiving Account (HQ Side INFLOW)
      const hq = await FranchiseService.getHqFranchiseOrNull(tx);
      if (hq) {
        const hqAccount = await tx.account.findFirst({
          where: {
            OR: [{ franchiseId: hq.id }, { franchiseId: null }],
            status: 'ACTIVE'
          },
          orderBy: { createdAt: 'asc' }
        });

        if (hqAccount) {
          await AccountService.adjustBalance(tx, hqAccount.id, payAmount, 'INFLOW');
        }

        await tx.payment.create({
          data: {
            paidAmount: payAmount,
            status: 'SUCCESS',
            accountId: hqAccount?.id || null,
            paymentMode: (franchiseAcc.type === 'BANK' ? 'BANK_TRANSFER' : (franchiseAcc.type === 'UPI' ? 'UPI' : 'CASH')) as any,
            sourceModule: 'FRANCHISE',
            linkedDocType: 'INVOICE',
            linkedDocId: order.orderNumber,
            entityType: 'FRANCHISE',
            entityId: order.franchiseId,
            transactionRef: `Franchise payment received from ${currentFranchise?.name || 'Franchise'} for order ${order.orderNumber}`,
            createdBy: paidBy || 'FRANCHISE_SYSTEM'
          }
        });
      }

      // 8. Mark Franchise Order as PAID
      const updatedOrder = await tx.franchiseOrder.update({
        where: { id },
        data: { paymentStatus: 'PAID' },
        include: { items: { include: { product: true } }, franchise: true },
      });

      return updatedOrder;
    });
  }}

// FIFO batch deduction
async function deductBatchStock(tx: any, productId: string, quantityNeeded: number, hqId?: string, orderId?: string, orderNumber?: string) {
  const batches = await tx.productBatch.findMany({
    where: {
      productId,
      ...(hqId ? { OR: [{ franchiseId: hqId }, { franchiseId: null }] } : {}),
      quantity: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gte: new Date() } }],
      // A batch under an active or completed recall must never be selected
      // as a FIFO source for a franchise dispatch, even though ProductBatch.
      // quantity itself is never decremented by recall (only InventoryBatch
      // status is). Batches with no recall row, or only a CANCELLED one,
      // remain eligible.
      AND: [{
        OR: [
          { recall: { is: null } },
          { recall: { status: { notIn: ['IN_PROGRESS', 'COMPLETED'] } } },
        ],
      }],
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
    const invItem = await findHqStockItem(tx, hq?.id || null, product);

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

  // We allow dispatch even if batch stock is 0 (over-dispatch) as per earlier discussion
  // but we log it. If you want to block it, uncomment below:
  // if (remaining > 0) throw new Error(`Insufficient batch stock...`);
}
