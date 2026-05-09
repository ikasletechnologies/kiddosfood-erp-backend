import prisma from
  '../../lib/prisma';
import { ItemCategory, StockMovementType } from '@prisma/client';

export class InventoryService {
  // Compute current stock from movement ledger — single source of truth
  static async computeStock(itemId: string, tx: any = prisma): Promise<number> {
    const result = await tx.stockMovement.aggregate({
      where: { itemId },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
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
    const allMovements = await prisma.stockMovement.groupBy({
      by: ['itemId'],
      where: { item: { franchiseId } },
      _sum: { quantity: true },
    });
    const stockMap = new Map(allMovements.map(m => [m.itemId, m._sum.quantity ?? 0]));

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
        procurementOrder: { status: { in: ['PENDING', 'APPROVED'] } },
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
      const inbound = todayMoves.filter(m => m.quantity > 0).reduce((s, m) => s + m.quantity, 0);
      const outbound = Math.abs(todayMoves.filter(m => m.quantity < 0).reduce((s, m) => s + m.quantity, 0));

      const status = computedStock <= item.minimumStock ? 'LOW' : 'SAFE';
      
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
      const item = await tx.inventoryItem.create({
        data: {
          name: data.name,
          sku,
          category: data.category || ItemCategory.RAW_MATERIAL,
          currentStock: 0,
          unit: data.unit || 'kg',
          minimumStock: data.minimumStock || 10,
          hsnCode: data.hsnCode,
          gstRate: data.gstRate || 5,
          franchiseId: data.franchiseId,
          vendorId: data.vendorId,
        },
      });

      if (data.initialStock > 0) {
        await this.recordMovement(tx, {
          itemId: item.id,
          type: StockMovementType.ADJUSTMENT,
          quantity: data.initialStock,
          referenceType: 'ADJUSTMENT',
          note: 'Opening Stock Balance',
          userId: data.userId,
        });
      }

      return item;
    });
  }

  // Only update metadata — never update currentStock directly
  static async updateItem(id: string, data: any) {
    const { currentStock: _currentStock, ...safeData } = data; // strip any stock field
    return prisma.inventoryItem.update({ where: { id }, data: safeData });
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

    return prisma.inventoryItem.delete({ where: { id } });
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
      referenceType?: string;
      referenceId?: string;
      note?: string;
      userId?: string;
    }
  ) {
    const updatedItem = await tx.inventoryItem.update({
      where: { id: data.itemId },
      data: { currentStock: { increment: data.quantity } },
    });

    await tx.stockMovement.create({
      data: {
        itemId: data.itemId,
        movementType: data.type as any,
        quantity: data.quantity,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        note: data.note,
        createdBy: data.userId,
      },
    });

    return updatedItem;
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
    return items.filter(item => item.currentStock <= item.minimumStock);
  }
}
