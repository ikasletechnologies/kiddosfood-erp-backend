import prisma from '../../lib/prisma';

export class WasteService {
  static async getAll(dateFrom?: string, dateTo?: string) {
    return prisma.wastage.findMany({
      where: {
        ...(dateFrom || dateTo
          ? {
              date: {
                ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
                ...(dateTo ? { lte: new Date(dateTo) } : {})
              }
            }
          : {})
      },
      include: { inventoryItem: true },
      orderBy: { date: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.wastage.findUnique({
      where: { id },
      include: { inventoryItem: true }
    });
  }

  static async create(data: {
    inventoryItemId: string;
    quantity: number;
    reason: string;
    cost: number;
    date?: string;
  }) {
    const wastage = await prisma.$transaction(async (tx) => {
      // Deduct from inventory
      await tx.inventoryItem.update({
        where: { id: data.inventoryItemId },
        data: { currentStock: { decrement: data.quantity } }
      });

      // Record movement
      await tx.stockMovement.create({
        data: {
          itemId: data.inventoryItemId,
          movementType: 'WASTE_OUT',
          quantity: -data.quantity,
          referenceType: 'WASTE',
          note: `Waste: ${data.reason}`
        }
      });

      // Create wastage record
      return tx.wastage.create({
        data: {
          inventoryItemId: data.inventoryItemId,
          quantity: data.quantity,
          reason: data.reason,
          cost: data.cost,
          date: data.date ? new Date(data.date) : new Date()
        },
        include: { inventoryItem: true }
      });
    });

    return wastage;
  }

  static async getSummary() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayTotal, weekTotal, all] = await Promise.all([
      prisma.wastage.aggregate({
        where: { date: { gte: today } },
        _sum: { cost: true, quantity: true }
      }),
      prisma.wastage.aggregate({
        where: { date: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        _sum: { cost: true }
      }),
      prisma.wastage.findMany({ include: { inventoryItem: true } })
    ]);

    // Top wasted item by cost
    const itemCosts: Record<string, number> = {};
    for (const w of all) {
      const name = w.inventoryItem?.name || 'Unknown';
      itemCosts[name] = (itemCosts[name] || 0) + w.cost;
    }
    const topItem = Object.entries(itemCosts).sort((a, b) => b[1] - a[1])[0];

    return {
      todayCost: todayTotal._sum.cost || 0,
      todayQty: todayTotal._sum.quantity || 0,
      weekCost: weekTotal._sum.cost || 0,
      topWastedItem: topItem ? { name: topItem[0], cost: topItem[1] } : null
    };
  }
}
