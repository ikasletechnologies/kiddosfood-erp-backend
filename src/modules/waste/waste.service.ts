import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';

export class WasteService {
  static async getAll(dateFrom?: string, dateTo?: string, franchiseId?: string) {
    return prisma.wasteEntry.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...(dateFrom || dateTo ? {
          createdAt: {
            ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
            ...(dateTo ? { lte: new Date(dateTo) } : {})
          }
        } : {})
      },
      include: { inventoryItem: { select: { name: true, sku: true, unit: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.wasteEntry.findUnique({
      where: { id },
      include: { inventoryItem: { select: { name: true, sku: true, unit: true } } }
    });
  }

  static async create(data: { itemId: string; quantity: number; reason: string; note?: string; franchiseId?: string }) {
    const quantity = Math.abs(Number(data.quantity));
    if (!quantity) throw new Error('Quantity must be greater than zero');

    return prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: data.itemId } });
      if (!item) throw new Error('Inventory item not found');

      // Same recordMovement choke-point every other module uses for stock changes —
      // logging waste actually deducts stock now, instead of being a no-op.
      await InventoryService.recordMovement(tx, {
        itemId: data.itemId,
        type: 'WASTE_OUT',
        quantity: -quantity,
        referenceType: 'WASTE',
        note: data.note || `Wastage: ${data.reason}`
      });

      return tx.wasteEntry.create({
        data: {
          inventoryItemId: data.itemId,
          franchiseId: data.franchiseId,
          quantity,
          reason: data.reason,
          note: data.note,
          costAtTime: quantity * (item.costPrice || 0)
        },
        include: { inventoryItem: { select: { name: true, sku: true, unit: true } } }
      });
    });
  }

  static async getSummary(franchiseId?: string) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [todayEntries, weekEntries] = await Promise.all([
      prisma.wasteEntry.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), createdAt: { gte: todayStart } }
      }),
      prisma.wasteEntry.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), createdAt: { gte: weekStart } },
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
