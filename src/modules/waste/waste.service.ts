import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';

export class WasteService {
  static async getAll(dateFrom?: string, dateTo?: string, franchiseId?: string, warehouseId?: string) {
    return prisma.wasteEntry.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(dateFrom || dateTo ? {
          createdAt: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo) } : {})
          }
        } : {})
      },
      include: { 
        inventoryItem: { select: { name: true, sku: true, unit: true } },
        warehouse: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.wasteEntry.findUnique({
      where: { id },
      include: { 
        inventoryItem: { select: { name: true, sku: true, unit: true } },
        warehouse: { select: { name: true } }
      }
    });
  }

  static async create(data: { itemId: string; quantity: number; reason: string; note?: string; franchiseId?: string; warehouseId?: string }) {
    const quantity = Number(data.quantity);
    if (isNaN(quantity) || quantity <= 0) throw new Error('Quantity must be greater than zero');

    return prisma.$transaction(async (tx) => {
      // Row lock the inventory item to prevent concurrency race conditions
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${data.itemId} FOR UPDATE`;

      const item = await tx.inventoryItem.findUnique({ where: { id: data.itemId } });
      if (!item) throw new Error('Inventory item not found');

      // Resolve warehouse
      let warehouseId = data.warehouseId;
      if (!warehouseId) {
        const franchiseId = data.franchiseId || item.franchiseId;
        if (franchiseId) {
          const franchise = await tx.franchise.findUnique({ where: { id: franchiseId } });
          warehouseId = franchise?.primaryWarehouseId || undefined;
        }
      }

      if (!warehouseId) {
        throw new Error('A valid warehouse must be selected');
      }

      // Check available quantity in the selected warehouse
      const available = await InventoryService.computeWarehouseStock(data.itemId, warehouseId, tx);
      if (quantity > available) {
        throw new Error(`Insufficient stock. Available: ${available} ${item.unit}. Requested wastage: ${quantity} ${item.unit}.`);
      }

      // Record outward stock movement
      await InventoryService.recordMovement(tx, {
        itemId: data.itemId,
        type: 'WASTE_OUT',
        quantity: -quantity,
        referenceType: 'WASTE',
        note: data.note || `Wastage: ${data.reason}`,
        warehouseId
      });

      return tx.wasteEntry.create({
        data: {
          inventoryItemId: data.itemId,
          franchiseId: data.franchiseId || item.franchiseId,
          warehouseId,
          quantity,
          reason: data.reason,
          note: data.note,
          costAtTime: quantity * (item.costPrice || 0)
        },
        include: { 
          inventoryItem: { select: { name: true, sku: true, unit: true } },
          warehouse: { select: { name: true } }
        }
      });
    });
  }

  static async getSummary(franchiseId?: string, warehouseId?: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [todayEntries, weekEntries] = await Promise.all([
      prisma.wasteEntry.findMany({
        where: { 
          ...(franchiseId ? { franchiseId } : {}), 
          ...(warehouseId ? { warehouseId } : {}),
          createdAt: { gte: todayStart } 
        }
      }),
      prisma.wasteEntry.findMany({
        where: { 
          ...(franchiseId ? { franchiseId } : {}), 
          ...(warehouseId ? { warehouseId } : {}),
          createdAt: { gte: weekStart } 
        },
        include: { inventoryItem: { select: { name: true } } }
      })
    ]);

    const todayCost = todayEntries.reduce((s, e) => s + (e.costAtTime || 0), 0);
    const todayQty = todayEntries.reduce((s, e) => s + e.quantity, 0);
    const weekCost = weekEntries.reduce((s, e) => s + (e.costAtTime || 0), 0);

    const qtyByItem = new Map<string, { name: string; qty: number }>();
    for (const e of weekEntries) {
      const key = e.inventoryItemId;
      const existing = qtyByItem.get(key);
      qtyByItem.set(key, { name: e.inventoryItem.name, qty: (existing?.qty || 0) + e.quantity });
    }
    let topWastedItem: string | null = null;
    let topQty = 0;
    for (const { name, qty } of qtyByItem.values()) {
      if (qty > topQty) { topQty = qty; topWastedItem = name; }
    }

    return { todayCost, todayQty, weekCost, topWastedItem };
  }
}
