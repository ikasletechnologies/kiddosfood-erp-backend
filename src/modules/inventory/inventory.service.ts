import prisma from
  '../../lib/prisma';
import { ItemCategory, StockMovementType } from '@prisma/client';

function mapCategoryToDb(category?: string): ItemCategory {
  if (!category) return ItemCategory.RAW_MATERIAL;
  if (category.startsWith('RAW_')) return ItemCategory.RAW_MATERIAL;
  if (category.startsWith('PACKAGING_')) return ItemCategory.PACKAGING;
  if (category === 'SEMI_FINISHED') return ItemCategory.SEMI_FINISHED;
  if (category === 'FINISHED_GOOD') return ItemCategory.FINISHED_GOOD;
  if (category === 'PACKAGING') return ItemCategory.PACKAGING;
  return ItemCategory.RAW_MATERIAL;
}

export function getStockInPhysicalUnit(stock: number, sku: string, category?: string): number {
  if (!sku || category !== 'FINISHED_GOOD') return stock;
  const parts = sku.split('-');
  const sizePart = parts.length >= 2 ? parts[parts.length - 1] : "";
  const match = sizePart.match(/^(\d+(?:\.\d+)?)\s*([A-Z]+)$/i);
  if (!match) return stock;

  const weightVal = parseFloat(match[1]);
  const weightUnit = match[2].toUpperCase();

  const totalVal = stock * weightVal;
  if (weightUnit === "G" || weightUnit === "ML") {
    return totalVal / 1000;
  }
  return totalVal;
}


export class InventoryService {
  // Compute current stock from movement ledger — single source of truth
  static async computeStock(itemId: string, tx: any = prisma): Promise<number> {
    const movements = await tx.stockMovement.findMany({
      where: { itemId },
      select: { quantity: true, baseQty: true }
    });
    return movements.reduce((acc: number, m: any) => acc + (m.baseQty !== null ? m.baseQty : m.quantity), 0);
  }

  static async getInventory(franchiseId: string, includeInactive = false) {
    const items = await prisma.inventoryItem.findMany({
      where: {
        franchiseId,
        ...(includeInactive ? {} : { isActive: true })
      },
      include: {
        movements: { orderBy: { createdAt: 'desc' }, take: 5 },
        vendor: true,
      },
      orderBy: { name: 'asc' },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const movementsToday = await prisma.stockMovement.findMany({
      where: { item: { franchiseId }, createdAt: { gte: today } },
    });

    // Recompute stock from all movements for accuracy
    const allMovements = await prisma.stockMovement.findMany({
      where: { item: { franchiseId } },
      select: { itemId: true, quantity: true, baseQty: true },
    });
    const stockMap = new Map<string, number>();
    allMovements.forEach(m => {
      const val = m.baseQty !== null ? m.baseQty : m.quantity;
      stockMap.set(m.itemId, (stockMap.get(m.itemId) || 0) + val);
    });

    // Identify which items have EVER been purchased (from movements or linked vendor)
    const itemsWithPurchaseMovements = await prisma.stockMovement.findMany({
      where: {
        item: { franchiseId },
        movementType: StockMovementType.PURCHASE_IN
      },
      select: { itemId: true },
      distinct: ['itemId']
    });
    const purchasedItemIds = new Set(itemsWithPurchaseMovements.map(m => m.itemId));

    // Calculate "Incoming" stock from Pending/Approved but not yet Received POs
    const pendingOrders = await prisma.procurementOrderItem.findMany({
      where: {
        procurementOrder: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] } },
        inventoryItem: { franchiseId }
      },
      select: { inventoryItemId: true, quantity: true }
    });
    const pendingMap = new Map();
    pendingOrders.forEach(po => {
      pendingMap.set(po.inventoryItemId, (pendingMap.get(po.inventoryItemId) || 0) + po.quantity);
    });

    return items.map(item => {
      // Use recomputed stock from ledger (movements) as source of truth
      // Fallback to item.currentStock ONLY if no movements exist for this item
      const hasMovements = stockMap.has(item.id);
      const computedStock = hasMovements ? (stockMap.get(item.id) ?? 0) : item.currentStock;

      const todayMoves = movementsToday.filter(m => m.itemId === item.id);
      const inbound = todayMoves.filter(m => (m.baseQty !== null ? m.baseQty : m.quantity) > 0).reduce((s, m) => s + (m.baseQty !== null ? m.baseQty : m.quantity), 0);
      const outbound = Math.abs(todayMoves.filter(m => (m.baseQty !== null ? m.baseQty : m.quantity) < 0).reduce((s, m) => s + (m.baseQty !== null ? m.baseQty : m.quantity), 0));

      const physicalStock = getStockInPhysicalUnit(computedStock, item.sku, item.category);
      const status = physicalStock <= item.minimumStock ? 'LOW' : 'SAFE';

      const incomingStock = pendingMap.get(item.id) || 0;

      // An item is considered "Purchased" if it has a linked vendor OR has been purchased in the past OR has a pending order
      const hasPurchaseMovement = item.movements?.some(m => m.movementType === 'PURCHASE_IN');
      const isPurchased = !!item.vendorId || purchasedItemIds.has(item.id) || hasPurchaseMovement || incomingStock > 0;

      return {
        ...item,
        currentStock: computedStock,
        inbound,
        outbound,
        status,
        isPurchased,
        incomingStock
      };
    });
  }

  static async getItemById(id: string) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      include: {
        movements: { orderBy: { createdAt: 'desc' }, take: 50 },
        vendor: true,
      },
    });
    if (!item) return null;

    const computedStock = await this.computeStock(id);
    return { ...item, currentStock: computedStock };
  }

  static async createItem(data: any) {
    const mappedCategory = mapCategoryToDb(data.category);
    if (mappedCategory === ItemCategory.FINISHED_GOOD) {
      const sPrice = Number(data.customerPrice) || Number(data.basePrice) || 0;
      if (sPrice <= 0) {
        throw new Error("A valid selling price (Customer Retail) must be provided to launch a finished good item master.");
      }
    }

    if (data.name && data.franchiseId) {
      const existing = await prisma.inventoryItem.findFirst({
        where: {
          franchiseId: data.franchiseId,
          name: { equals: data.name, mode: 'insensitive' },
          vendorId: data.vendorId // Only block if the same name AND same vendor (or both manual)
        }
      });
      if (existing) {
        const sourceLabel = data.vendorId ? "the same vendor" : "manual entry";
        throw new Error(`A material with the name "${data.name}" already exists for ${sourceLabel}. Please update the existing record or use a distinct name.`);
      }
    }

    const sku = (data.sku && typeof data.sku === 'string')
      ? data.sku.toUpperCase()
      : `RM-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    return prisma.$transaction(async tx => {
      const franchise = await tx.franchise.findUnique({ where: { id: data.franchiseId } });
      const nameUpper = franchise?.name.toUpperCase() || "";
      const isHQ = nameUpper.includes('HQ') || 
                   nameUpper.includes('HEAD') ||
                   nameUpper.includes('MAIN') ||
                   nameUpper.includes('CORPORATE') ||
                   nameUpper.includes('CENTRAL');

      const createData: any = {
        name: data.name,
        sku,
        category: mapCategoryToDb(data.category),
        currentStock: 0,
        unit: data.unit || (data.category === 'FINISHED_GOOD' ? 'PC' : 'kg'),
        minimumStock: data.minimumStock || 10,
        hsnCode: data.hsnCode,
        gstRate: data.gstRate !== undefined ? Number(data.gstRate) : 5,
        franchiseId: data.franchiseId,
        vendorId: data.vendorId,
      };

      // Financial fields (Safe injection)
      if (data.costPrice !== undefined) createData.costPrice = Number(data.costPrice) || 0;
      if (data.franchisePrice !== undefined) createData.franchisePrice = Number(data.franchisePrice) || 0;
      if (data.dealerPrice !== undefined) createData.dealerPrice = Number(data.dealerPrice) || 0;
      if (data.customerPrice !== undefined) createData.customerPrice = Number(data.customerPrice) || 0;
      if (isHQ) {
        createData.basePrice = Number(data.franchisePrice) || Number(data.basePrice) || 0;
      } else {
        if (data.basePrice !== undefined) createData.basePrice = Number(data.basePrice) || 0;
      }

      const item = await tx.inventoryItem.create({
        data: createData,
      });

      if (data.initialStock > 0) {
        await this.recordMovement(tx, {
          itemId: item.id,
          type: StockMovementType.ADJUSTMENT,
          quantity: data.initialStock,
          referenceType: 'ADJUSTMENT',
          note: 'Opening Stock Balance',
          userId: data.userId,
          warehouseId: (data.warehouseId || '').trim() || null,
        });
      }

      // ─── AUTOMATION: Sync with Product Master if category is FINISHED_GOOD or SEMI_FINISHED at HQ ───
      const orderableCategories: ItemCategory[] = [ItemCategory.FINISHED_GOOD, ItemCategory.SEMI_FINISHED];
      
      if (orderableCategories.includes(item.category)) {
        if (isHQ) {
          const existingProduct = await tx.product.findFirst({
            where: { 
              OR: [
                { sku: item.sku },
                { name: { equals: item.name, mode: 'insensitive' } }
              ]
            }
          });

          if (!existingProduct) {
            await tx.product.create({
              data: {
                name: item.name,
                sku: item.sku,
                basePrice: item.basePrice || 0,
                isActive: true,
                productType: item.category === ItemCategory.FINISHED_GOOD ? 'FINISHED_GOOD' : 'MADE_TO_ORDER',
                category: 'Automated Sync'
              }
            });
            console.log(`✅ [Sync] Created new product for HQ Inventory Item: ${item.name}`);
          } else {
            // Update existing product to match inventory (Name/SKU)
            await tx.product.update({
              where: { id: existingProduct.id },
              data: { 
                name: item.name, 
                sku: item.sku,
                basePrice: item.basePrice || 0
              }
            });
            console.log(`🔄 [Sync] Updated existing product for HQ Inventory Item: ${item.name}`);
          }
        }
      }

      return item;
    });
  }

  // Only update metadata — never update currentStock directly
  static async updateItem(id: string, data: any) {
    const currentItem = await prisma.inventoryItem.findUnique({ where: { id } });
    const finalCategory = data.category ? mapCategoryToDb(data.category) : currentItem?.category;
    
    if (finalCategory === ItemCategory.FINISHED_GOOD) {
      const finalPrice = data.customerPrice !== undefined ? Number(data.customerPrice)
        : data.basePrice !== undefined ? Number(data.basePrice)
        : currentItem?.basePrice || 0;
      if (finalPrice <= 0) {
        throw new Error("A valid selling price (Customer Retail) must be provided to launch a finished good item master.");
      }
    }

    const { currentStock: _currentStock, ...safeData } = data; // strip any stock field
    if (safeData.category) {
      safeData.category = mapCategoryToDb(safeData.category);
    }

    const franchiseId = safeData.franchiseId || (await prisma.inventoryItem.findUnique({ where: { id }, select: { franchiseId: true } }))?.franchiseId;
    let isHQ = false;
    if (franchiseId) {
      const franchise = await prisma.franchise.findUnique({ where: { id: franchiseId } });
      const nameUpper = franchise?.name.toUpperCase() || "";
      isHQ = nameUpper.includes('HQ') || 
             nameUpper.includes('HEAD') ||
             nameUpper.includes('MAIN') ||
             nameUpper.includes('CORPORATE') ||
             nameUpper.includes('CENTRAL');
    }

    if (isHQ && (data.franchisePrice !== undefined || data.basePrice !== undefined)) {
      safeData.basePrice = data.franchisePrice !== undefined ? (Number(data.franchisePrice) || 0) : (Number(data.basePrice) || 0);
    }

    // Filter to only include fields defined in Prisma schema to avoid unknown argument errors
    const validFields = [
      'name', 'sku', 'category', 'unit', 'minimumStock', 'batchNo', 
      'expiryDate', 'franchiseId', 'vendorId', 'gstRate', 'hsnCode', 
      'isActive', 'basePrice', 'costPrice', 'franchisePrice', 'dealerPrice', 'customerPrice'
    ];

    const updatePayload: any = {};
    for (const key of validFields) {
      if (safeData[key] !== undefined) {
        if (key === 'gstRate' || key === 'minimumStock') {
          updatePayload[key] = Number(safeData[key]) || 0;
        } else if (key === 'basePrice' || key === 'costPrice' || key === 'franchisePrice' || key === 'dealerPrice' || key === 'customerPrice') {
          updatePayload[key] = safeData[key] === null ? null : (Number(safeData[key]) || 0);
        } else {
          updatePayload[key] = safeData[key];
        }
      }
    }

    const updated = await prisma.inventoryItem.update({ where: { id }, data: updatePayload });

    // Handle opening/initial stock updates safely through stock movement ledger
    if (data.initialStock !== undefined) {
      const newInitialStock = Number(data.initialStock) || 0;
      
      const openingMovement = await prisma.stockMovement.findFirst({
        where: {
          itemId: id,
          note: 'Opening Stock Balance'
        }
      });

      if (openingMovement) {
        const diff = newInitialStock - openingMovement.quantity;
        if (diff !== 0) {
          await prisma.$transaction(async tx => {
            await tx.stockMovement.update({
              where: { id: openingMovement.id },
              data: { quantity: newInitialStock }
            });
            // Update cache currentStock
            await tx.inventoryItem.update({
              where: { id },
              data: { currentStock: { increment: diff } }
            });
          });
        }
      } else if (newInitialStock > 0) {
        await prisma.$transaction(async tx => {
          await tx.stockMovement.create({
            data: {
              itemId: id,
              movementType: StockMovementType.ADJUSTMENT,
              quantity: newInitialStock,
              referenceType: 'ADJUSTMENT',
              note: 'Opening Stock Balance',
              createdBy: data.userId,
              warehouseId: (data.binLocation || data.warehouseId || '').trim() || null
            }
          });
          // Update cache currentStock
          await tx.inventoryItem.update({
            where: { id },
            data: { currentStock: { increment: newInitialStock } }
          });
        });
      }
    }

    // Sync on update as well if category is orderable
    const orderableCategories: ItemCategory[] = [ItemCategory.FINISHED_GOOD, ItemCategory.SEMI_FINISHED];
    if (orderableCategories.includes(updated.category)) {
      if (isHQ) {
        const existing = await prisma.product.findFirst({
          where: { 
            OR: [
              { sku: updated.sku },
              { name: { equals: updated.name, mode: 'insensitive' } }
            ]
          }
        });
        if (!existing) {
          await prisma.product.create({
            data: {
              name: updated.name,
              sku: updated.sku,
              basePrice: updated.basePrice || 0,
              isActive: true,
              productType: updated.category === ItemCategory.FINISHED_GOOD ? 'FINISHED_GOOD' : 'MADE_TO_ORDER',
              category: 'Automated Sync'
            }
          });
        } else {
          await prisma.product.update({
            where: { id: existing.id },
            data: { 
              name: updated.name, 
              sku: updated.sku,
              basePrice: updated.basePrice || 0
            }
          });
        }
      }
    }
    return updated;
  }

  static async deleteItem(id: string) {
    // Check for critical dependencies to provide helpful error messages
    const [
      recipeLinks,
      productionLinks,
      poLinks,
      movementLinks,
      requestLinks,
      transferLinks
    ] = await Promise.all([
      prisma.recipeItem.count({ where: { inventoryItemId: id } }),
      prisma.productionItem.count({ where: { inventoryItemId: id } }),
      prisma.procurementOrderItem.count({ where: { inventoryItemId: id } }),
      prisma.stockMovement.count({ where: { itemId: id } }),
      prisma.stockRequestItem.count({ where: { inventoryItemId: id } }),
      prisma.stockTransferItem.count({ where: { inventoryItemId: id } })
    ]);

    if (recipeLinks > 0) {
      throw new Error(`Deletion Blocked: This material is part of ${recipeLinks} recipe(s). Please remove it from your recipes first.`);
    }

    if (productionLinks > 0 || movementLinks > 0) {
      const totalHistory = productionLinks + movementLinks;
      throw new Error(`Deletion Blocked: This item has ${totalHistory} recorded history entries (Production/Stock Movements). Deleting it would break audit logs. Please mark it as 'Inactive' instead.`);
    }

    if (poLinks > 0) {
      throw new Error(`Deletion Blocked: This material is referenced in ${poLinks} purchase order(s) or GRNs.`);
    }

    if (requestLinks > 0 || transferLinks > 0) {
      throw new Error(`Deletion Blocked: This material is linked to pending branch requests or transfers.`);
    }

    return prisma.$transaction(async tx => {
      const item = await tx.inventoryItem.findUnique({ where: { id } });

      if (item && (item.category === 'FINISHED_GOOD' || item.category === 'SEMI_FINISHED')) {
        const franchise = await tx.franchise.findUnique({ where: { id: item.franchiseId } });
        const nameUpper = franchise?.name.toUpperCase() || "";
        const isHQ = nameUpper.includes('HQ') || nameUpper.includes('HEAD') || nameUpper.includes('CORPORATE');

        if (isHQ) {
          const syncedProduct = await tx.product.findUnique({ where: { sku: item.sku || "" } });
          if (syncedProduct) {
            // Only delete product if it has no sales history
            const usageCount = await tx.orderItem.count({ where: { productId: syncedProduct.id } });
            if (usageCount === 0) {
              await tx.product.delete({ where: { id: syncedProduct.id } });
              console.log(`🗑️ [Sync] Deleted synced product master: ${item.name}`);
            }
          }
        }
      }

      return tx.inventoryItem.delete({ where: { id } });
    });
  }

  static async deactivateItem(id: string) {
    return (prisma.inventoryItem as any).update({
      where: { id },
      data: { isActive: false },
    });
  }

  static async activateItem(id: string) {
    return (prisma.inventoryItem as any).update({
      where: { id },
      data: { isActive: true },
    });
  }

  // Internal: stock-in via GRN / procurement — not exposed as free-form UI edit
  static async stockIn(data: { itemId: string; quantity: number; type?: any; note?: string; userId?: string }, externalTx?: any) {
    const run = (tx: any) =>
      this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type ?? 'PURCHASE_IN',
        quantity: data.quantity,
        note: data.note,
        userId: data.userId,
      });
    return externalTx ? run(externalTx) : prisma.$transaction(run);
  }

  // Internal: stock-out via production / waste — not exposed as free-form UI edit
  static async stockOut(data: { itemId: string; quantity: number; type?: any; note?: string; userId?: string }, externalTx?: any) {
    const run = (tx: any) =>
      this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type ?? 'PRODUCTION_OUT',
        quantity: -data.quantity,
        note: data.note,
        userId: data.userId,
      });
    return externalTx ? run(externalTx) : prisma.$transaction(run);
  }

  // SUPER_ADMIN only: physical count adjustment
  static async adjustStock(data: { itemId: string; newQuantity: number; note?: string; userId?: string }) {
    return prisma.$transaction(async tx => {
      const computedStock = await this.computeStock(data.itemId, tx);
      const difference = data.newQuantity - computedStock;
      if (difference === 0) return { message: 'No change needed' };

      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: StockMovementType.ADJUSTMENT,
        quantity: difference,
        referenceType: 'ADJUSTMENT',
        note: data.note || 'Physical count adjustment',
        userId: data.userId,
      });
    });
  }

  // Core engine: record movement and keep currentStock in sync as cache
  static async recordMovement(
    tx: any,
    data: {
      itemId: string;
      type: string;
      quantity: number;
      baseQty?: number;
      unitId?: string;
      referenceType?: string;
      referenceId?: string;
      note?: string;
      userId?: string;
      warehouseId?: string;
    }
  ) {
    const stockChange = data.baseQty !== undefined && data.baseQty !== null ? data.baseQty : data.quantity;
    
    const updatedItem = await tx.inventoryItem.update({
      where: { id: data.itemId },
      data: { currentStock: { increment: stockChange } },
    });

    await tx.stockMovement.create({
      data: {
        itemId: data.itemId,
        movementType: data.type as any,
        quantity: data.quantity,
        baseQty: data.baseQty,
        unitId: data.unitId,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        note: data.note,
        createdBy: data.userId,
        warehouseId: data.warehouseId ? (data.warehouseId.trim() || null) : null,
      },
    });

    return updatedItem;
  }
  
  // New helper for unit conversion engine
  static async convertUnitToBase(itemId: string, unitIdOrName: string, enteredQty: number, tx: any = prisma): Promise<{ requiredBaseQty: number; unitId?: string }> {
    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      include: { baseUnit: true, conversions: { include: { unit: true } } }
    });
    
    if (!item) throw new Error("Item not found");
    
    // If no unit requested, assume base quantity
    if (!unitIdOrName || unitIdOrName === "NONE" || unitIdOrName === item.unit) {
      return { requiredBaseQty: enteredQty };
    }
    
    // Look for conversion
    const conversion = item.conversions.find((c: any) => c.unitId === unitIdOrName || c.unit.name.toLowerCase() === unitIdOrName.toLowerCase() || c.unit.shortName.toLowerCase() === unitIdOrName.toLowerCase());
    
    if (conversion) {
      return { requiredBaseQty: enteredQty * conversion.multiplier, unitId: conversion.unit.id };
    }
    
    // If requested unit is explicitly the base unit
    if (item.baseUnit && (item.baseUnit.id === unitIdOrName || item.baseUnit.name.toLowerCase() === unitIdOrName.toLowerCase() || item.baseUnit.shortName.toLowerCase() === unitIdOrName.toLowerCase())) {
      return { requiredBaseQty: enteredQty, unitId: item.baseUnit.id };
    }
    
    // If no conversion found, fallback to 1:1 if unit strings match, else Error
    if (item.unit && item.unit.toLowerCase() === unitIdOrName.toLowerCase()) {
      return { requiredBaseQty: enteredQty };
    }
    
    throw new Error(`No unit conversion found for item ${item.name} to unit ${unitIdOrName}`);
  }

  static async getMovements(filters: any) {
    return prisma.stockMovement.findMany({
      where: filters,
      include: { item: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getAlerts(franchiseId: string) {
    const items = await this.getInventory(franchiseId);
    return items.filter(item => {
      const physicalStock = getStockInPhysicalUnit(item.currentStock, item.sku, item.category);
      return physicalStock <= item.minimumStock;
    });
  }
}
