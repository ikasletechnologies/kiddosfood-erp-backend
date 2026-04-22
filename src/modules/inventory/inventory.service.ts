import prisma from '../../lib/prisma';
import { StockMovementType } from '@prisma/client';
import { AuditService } from '../audit/audit.service';

export class InventoryService {
  /**
   * Fetch inventory items for a specific franchise/branch
   */
  static async getInventory(franchiseId: string) {
    return prisma.inventoryItem.findMany({
      where: { franchiseId },
      include: { vendor: true, movements: { take: 5, orderBy: { createdAt: 'desc' } } },
      orderBy: { name: 'asc' }
    });
  }

  static async getItemById(id: string) {
    return prisma.inventoryItem.findUnique({
      where: { id },
      include: { vendor: true, movements: { take: 20, orderBy: { createdAt: 'desc' } } }
    });
  }

  /**
   * Create a new inventory item
   */
  static async createItem(data: any) {
    let franchiseId = data.franchiseId;

    // Defensive check: ensure franchiseId is valid
    if (!franchiseId || franchiseId === 'root-franchise' || franchiseId === 'undefined') {
      const first = await prisma.franchise.findFirst();
      if (first) {
        franchiseId = first.id;
      } else {
        // Absolute fallback: Create the HQ franchise if it's missing
        const hq = await prisma.franchise.create({
          data: {
            id: 'hq-001',
            name: 'Kiddos Food HQ',
            location: 'Corporate',
            ownerName: 'Admin',
            contactNum: '0000000000'
          }
        });
        franchiseId = hq.id;
      }
    }

    return prisma.inventoryItem.create({
      data: {
        name: data.name,
        sku: data.sku,
        category: data.category,
        currentStock: data.currentStock || 0,
        unit: data.unit,
        minimumStock: data.minimumStock || 10,
        batchNo: data.batchNo,
        expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
        franchiseId: franchiseId,
        vendorId: data.vendorId
      }
    });
  }

  /**
   * Unified Method to Record Stock Movements
   */
  static async recordMovement(tx: any, data: {
    itemId: string,
    type: StockMovementType,
    quantity: number,
    referenceType?: string,
    referenceId?: string,
    note?: string,
    userId?: string
  }) {
    // 1. Update the current stock level
    // quantity > 0 for additions (PURCHASE_IN), < 0 for deductions (SALES_OUT)
    const result = await tx.inventoryItem.update({
      where: { id: data.itemId },
      data: {
        currentStock: { increment: data.quantity }
      }
    });

    if (data.userId) {
      await AuditService.log({
        userId: data.userId,
        action: data.quantity > 0 ? 'STOCK_IN' : 'STOCK_OUT',
        entityType: 'INVENTORY',
        entityId: data.itemId,
        targetFranchiseId: result.franchiseId,
        details: { quantity: data.quantity, type: data.type, note: data.note }
      });
    }

    // 2. Create the movement record
    await tx.stockMovement.create({
      data: {
        itemId: data.itemId,
        movementType: data.type,
        quantity: data.quantity,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        note: data.note,
        createdBy: data.userId
      }
    });

    return result;
  }

  /**
   * Stock In (Purchase/Transfer/Adjustment)
   */
  static async stockIn(data: { itemId: string, quantity: number, type: StockMovementType, note?: string, userId?: string }, txClient?: any) {
    if (txClient) {
      return this.recordMovement(txClient, {
        itemId: data.itemId,
        type: data.type,
        quantity: data.quantity,
        note: data.note,
        userId: data.userId
      });
    }
    return prisma.$transaction(async (tx) => {
      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type,
        quantity: data.quantity,
        note: data.note,
        userId: data.userId
      });
    });
  }

  /**
   * Stock Out (Waste/Adjustment/Sales)
   */
  static async stockOut(data: { itemId: string, quantity: number, type: StockMovementType, note?: string, userId?: string }, txClient?: any) {
    if (txClient) {
      return this.recordMovement(txClient, {
        itemId: data.itemId,
        type: data.type,
        quantity: -data.quantity,
        note: data.note,
        userId: data.userId
      });
    }
    return prisma.$transaction(async (tx) => {
      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type,
        quantity: -data.quantity, // Negative for deduction
        note: data.note,
        userId: data.userId
      });
    });
  }

  /**
   * Stock Adjustment (Physical Count Correction)
   */
  static async adjustStock(data: { itemId: string, newQuantity: number, note?: string, userId?: string }) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.inventoryItem.findUnique({ where: { id: data.itemId } });
      if (!current) throw new Error('Item not found');

      const difference = data.newQuantity - current.currentStock;
      
      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: 'ADJUSTMENT',
        quantity: difference,
        note: data.note || 'Manual physical adjustment',
        userId: data.userId
      });
    });
  }

  static async updateItem(id: string, data: { name?: string; sku?: string; category?: any; unit?: string; minimumStock?: number }) {
    return prisma.inventoryItem.update({ where: { id }, data });
  }

  static async deleteItem(id: string) {
    return prisma.inventoryItem.delete({ where: { id } });
  }

  static async getMovements(filters: any) {
    return prisma.stockMovement.findMany({
      where: filters,
      include: { item: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getAlerts(franchiseId?: string) {
    const items = await prisma.inventoryItem.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
      }
    });

    return items
      .filter((item) => item.currentStock <= item.minimumStock)
      .map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        currentStock: item.currentStock,
        minimumStock: item.minimumStock,
        unit: item.unit,
        franchiseId: item.franchiseId,
        severity: item.currentStock === 0 ? 'CRITICAL' : 'LOW',
        expiryDate: item.expiryDate
      }));
  }
}
