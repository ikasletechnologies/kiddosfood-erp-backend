import prisma from '../../lib/prisma';
import { ItemCategory, StockMovementType } from '@prisma/client';

export class InventoryService {
  /**
   * Get all inventory items for a franchise
   */
  static async getInventory(franchiseId: string) {
    return prisma.inventoryItem.findMany({
      where: { franchiseId },
      include: {
        movements: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      },
      orderBy: { updatedAt: 'desc' }
    });
  }

  /**
   * Get a single item by ID with full movement history
   */
  static async getItemById(id: string) {
    return prisma.inventoryItem.findUnique({
      where: { id },
      include: {
        movements: {
          orderBy: { createdAt: 'desc' },
          take: 50
        },
        vendor: true
      }
    });
  }

  /**
   * Create a new inventory item
   */
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

    return prisma.inventoryItem.create({
      data: {
        name: data.name,
        sku: data.sku,
        category: data.category || ItemCategory.RAW_MATERIAL,
        currentStock: data.currentStock || 0,
        unit: data.unit || 'kg',
        minimumStock: data.minimumStock || 10,
        hsnCode: data.hsnCode,
        gstRate: data.gstRate || 5,
        franchiseId: data.franchiseId,
        vendorId: data.vendorId
      }
    });
  }

  /**
   * Update item details
   */
  static async updateItem(id: string, data: any) {
    return prisma.inventoryItem.update({
      where: { id },
      data
    });
  }

  /**
   * Delete an item (be careful with referential integrity)
   */
  static async deleteItem(id: string) {
    return prisma.inventoryItem.delete({
      where: { id }
    });
  }

  /**
   * Manual Stock In (e.g. from procurement or surplus)
   */
  static async stockIn(data: { itemId: string; quantity: number; type?: StockMovementType; note?: string; userId?: string }) {
    return prisma.$transaction(async (tx) => {
      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type || StockMovementType.PURCHASE_IN,
        quantity: data.quantity,
        note: data.note,
        userId: data.userId
      });
    });
  }

  /**
   * Manual Stock Out (e.g. wastage or external sales)
   */
  static async stockOut(data: { itemId: string; quantity: number; type?: StockMovementType; note?: string; userId?: string }) {
    return prisma.$transaction(async (tx) => {
      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type || StockMovementType.PRODUCTION_OUT,
        quantity: -data.quantity,
        note: data.note,
        userId: data.userId
      });
    });
  }

  /**
   * Physical inventory adjustment (sets absolute stock)
   */
  static async adjustStock(data: { itemId: string; newQuantity: number; note?: string; userId?: string }) {
    return prisma.$transaction(async (tx) => {
      const currentItem = await tx.inventoryItem.findUnique({ where: { id: data.itemId } });
      if (!currentItem) throw new Error('Inventory item not found');

      const difference = data.newQuantity - currentItem.currentStock;

      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: StockMovementType.ADJUSTMENT,
        quantity: difference,
        note: data.note || 'Manual physical adjustment',
        userId: data.userId
      });
    });
  }

  /**
   * Core engine: Records movement AND updates currentStock
   * Used internally and by other services (POS, Production, Logistics)
   */
  static async recordMovement(tx: any, data: { 
    itemId: string; 
    type: string; 
    quantity: number; 
    referenceType?: string; 
    referenceId?: string; 
    note?: string; 
    userId?: string 
  }) {
    // 1. Update the actual stock level
    const updatedItem = await tx.inventoryItem.update({
      where: { id: data.itemId },
      data: {
        currentStock: {
          increment: data.quantity
        }
      }
    });

    // 2. Log the movement
    // Note: We store the absolute quantity and rely on movementType for direction insight,
    // OR we store signed quantity. Based on logic, we use signed quantity (data.quantity).
    await tx.stockMovement.create({
      data: {
        itemId: data.itemId,
        movementType: data.type as any,
        quantity: data.quantity,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        note: data.note,
        createdBy: data.userId
      }
    });

    return updatedItem;
  }

  /**
   * Get movement history with filters
   */
  static async getMovements(filters: any) {
    return prisma.stockMovement.findMany({
      where: filters,
      include: {
        item: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Identify items below threshold
   */
  static async getAlerts(franchiseId: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId }
    });

    return items.filter(item => item.currentStock <= item.minimumStock);
  }
}