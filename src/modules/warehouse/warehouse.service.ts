import prisma from '../../lib/prisma';

export class WarehouseService {
  /**
   * Get the primary warehouse and its bins for a given franchise.
   */
  static async getPrimaryWarehouse(franchiseId: string) {
    const franchise = await prisma.franchise.findUnique({
      where: { id: franchiseId },
      include: {
        primaryWarehouse: {
          include: {
            bins: true,
          },
        },
      },
    });

    if (!franchise) throw new Error('Franchise not found');
    if (!franchise.primaryWarehouse) throw new Error('No primary warehouse assigned to this franchise');

    return franchise.primaryWarehouse;
  }

  /**
   * Get one warehouse and its bins directly by id — for SUPER_ADMIN picking
   * an arbitrary warehouse from the global list (not necessarily anyone's
   * "primary"). getPrimaryWarehouse() can't serve this: it only resolves
   * via a franchise's primaryWarehouseId.
   */
  static async getWarehouseById(warehouseId: string) {
    const warehouse = await prisma.warehouse.findUnique({
      where: { id: warehouseId },
      include: { bins: true },
    });
    if (!warehouse) throw new Error('Warehouse not found');
    return warehouse;
  }

  /**
   * Gets physical stock strictly broken down by Item, Batch, and Bin.
   */
  static async getWarehouseStock(warehouseId: string) {
    // We group stock movements by itemId, batchId, and binId to find the exact physical balance.
    const movements = await prisma.stockMovement.findMany({
      where: { warehouseId },
      include: {
        item: { select: { name: true, sku: true, unit: true } },
        batch: { select: { batchNumber: true, status: true } },
        bin: { select: { code: true } },
      },
    });

    // Grouping structure: { itemId_batchId_binId: { ...details, balance } }
    const balanceMap: Record<string, any> = {};

    for (const m of movements) {
      const bId = m.batchId || 'NO_BATCH';
      const binId = m.binId || 'NO_BIN';
      const key = `${m.itemId}_${bId}_${binId}`;

      if (!balanceMap[key]) {
        balanceMap[key] = {
          itemId: m.itemId,
          itemName: m.item.name,
          itemSku: m.item.sku,
          unit: m.item.unit,
          batchId: m.batchId,
          batchCode: m.batch?.batchNumber || '-',
          status: m.batch?.status || 'READY', // Fallback status
          binId: m.binId,
          binCode: m.bin?.code || 'Not Assigned',
          balance: 0,
        };
      }

      balanceMap[key].balance += (m.baseQty !== null ? m.baseQty : m.quantity);
    }

    // Filter out zero balances
    return Object.values(balanceMap).filter((b: any) => Math.abs(b.balance) > 0.001);
  }

  /**
   * Bin Management
   */
  static async createBin(warehouseId: string, code: string, description?: string) {
    return prisma.warehouseBin.create({
      data: { warehouseId, code, description },
    });
  }

  static async updateBin(binId: string, code: string, description?: string) {
    return prisma.warehouseBin.update({
      where: { id: binId },
      data: { code, description },
    });
  }

  static async deleteBin(binId: string) {
    // In a real ERP, we might just deactivate, but for now we'll allow delete
    // if there are no movements tied to it.
    const hasMovements = await prisma.stockMovement.findFirst({ where: { binId } });
    if (hasMovements) {
      throw new Error('Cannot delete bin that has stock movements.');
    }
    return prisma.warehouseBin.delete({ where: { id: binId } });
  }

  /**
   * Assign stock from 'null' bin to a specific bin without changing overall ledger quantity.
   */
  static async assignBin(data: {
    warehouseId: string;
    itemId: string;
    batchId?: string;
    quantity: number;
    newBinId: string;
    userId?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      // 1. Verify bin exists
      const bin = await tx.warehouseBin.findUnique({ where: { id: data.newBinId } });
      if (!bin || bin.warehouseId !== data.warehouseId) {
        throw new Error('Invalid bin or warehouse');
      }

      // 2. We use an ADJUSTMENT movement to move it out of null bin and into new bin.
      const basePayload = {
        itemId: data.itemId,
        movementType: 'ADJUSTMENT' as any,
        referenceType: 'BIN_ASSIGNMENT',
        note: `Assigned to bin ${bin.code}`,
        createdBy: data.userId,
        warehouseId: data.warehouseId,
        batchId: data.batchId || null,
      };

      // Out of "Not Assigned" (null bin)
      await tx.stockMovement.create({
        data: {
          ...basePayload,
          quantity: -data.quantity,
          binId: null,
        },
      });

      // Into new Bin
      await tx.stockMovement.create({
        data: {
          ...basePayload,
          quantity: data.quantity,
          binId: data.newBinId,
        },
      });

      return { success: true, message: `Assigned ${data.quantity} to ${bin.code}` };
    });
  }
}
