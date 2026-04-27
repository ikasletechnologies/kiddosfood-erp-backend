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

  static async getInventory(franchiseId: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId },
      include: {
        movements: { orderBy: { createdAt: 'desc' }, take: 5 },
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

    return items.map(item => {
      const computedStock = stockMap.get(item.id) ?? item.currentStock;
      const todayMoves = movementsToday.filter(m => m.itemId === item.id);
      const inbound = todayMoves.filter(m => m.quantity > 0).reduce((s, m) => s + m.quantity, 0);
      const outbound = Math.abs(todayMoves.filter(m => m.quantity < 0).reduce((s, m) => s + m.quantity, 0));

      const status = computedStock <= item.minimumStock ? 'LOW' : 'SAFE';
      return { ...item, currentStock: computedStock, inbound, outbound, status };
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
          name: { equals: data.name, mode: 'insensitive' }
        }
      });
      if (existing) {
        throw new Error(`A material with the name "${data.name}" already exists in your inventory. Please use the existing material instead of creating a duplicate.`);
      }
    }

    const sku = data.sku
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
    const { currentStock, ...safeData } = data; // strip any stock field
    return prisma.inventoryItem.update({ where: { id }, data: safeData });
  }

  static async deleteItem(id: string) {
    return prisma.inventoryItem.delete({ where: { id } });
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
