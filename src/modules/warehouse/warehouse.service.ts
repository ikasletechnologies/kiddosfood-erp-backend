import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';

// Warehouse selection elsewhere in the app is name-driven (dropdowns, stock
// lookups) — a near-duplicate name like "Home (Hopes)" next to "Home"
// silently splits stock across two records with no way to tell them apart.
// nameKey carries a DB-level unique constraint (see schema) so this is
// enforced even under concurrent requests, not just by the pre-check below.
function normalizeWarehouseName(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class WarehouseService {
  // The single warehouse-creation path — every caller (the generic admin
  // endpoint, the setup wizard) goes through this so there's one place that
  // owns the nameKey/duplicate-name rule and the optional franchise link,
  // instead of each caller re-implementing it slightly differently.
  static async create(data: { name: string; code?: string; location?: string; type?: string; status?: string; franchiseId?: string }) {
    if (!data.name || !data.name.trim()) {
      throw new Error('Warehouse name is required');
    }
    const nameKey = normalizeWarehouseName(data.name);

    return prisma.$transaction(async (tx) => {
      const clash = await tx.warehouse.findUnique({ where: { nameKey } });
      if (clash) {
        throw new Error(`A warehouse named "${clash.name}" already exists. Use that one instead of creating a near-duplicate.`);
      }

      if (data.franchiseId) {
        const franchise = await tx.franchise.findUnique({ where: { id: data.franchiseId } });
        if (!franchise) throw new Error('Franchise not found.');
        if (franchise.primaryWarehouseId) {
          throw new Error('This franchise already has a primary warehouse configured.');
        }
      }

      const warehouse = await tx.warehouse.create({
        data: {
          name: data.name.trim(),
          nameKey,
          location: data.location,
          type: data.type,
          code: data.code,
          status: data.status,
        },
      });

      if (data.franchiseId) {
        await tx.franchise.update({
          where: { id: data.franchiseId },
          data: { primaryWarehouseId: warehouse.id },
        });
      }

      return warehouse;
    });
  }

  // Setup-wizard-specific: resolves HQ server-side (never trusts a
  // browser-supplied franchiseId for something as foundational as "which
  // franchise is HQ"), and is idempotent — a double-click, a page refresh,
  // or revisiting /setup after it already succeeded returns the existing
  // warehouse instead of creating a second one or erroring.
  static async createHqWarehouse(data: { name: string; code?: string; location?: string }) {
    const hq = await FranchiseService.getHqFranchise();
    if (hq.primaryWarehouseId) {
      const existing = await prisma.warehouse.findUnique({ where: { id: hq.primaryWarehouseId } });
      if (existing) return existing;
    }
    return this.create({ ...data, type: 'MAIN', franchiseId: hq.id });
  }
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
