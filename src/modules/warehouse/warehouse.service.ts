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
  /**
   * Generates the next sequential, guaranteed-unique Warehouse Code (e.g. WH-001, WH-002).
   * Atomically increments the number sequence within a transaction and verifies no collision.
   */
  static async nextWarehouseCode(tx?: any): Promise<string> {
    const run = async (t: any) => {
      const existingSeq = await t.numberSequence.findUnique({ where: { key: 'WAREHOUSE_CODE' } });
      if (!existingSeq) {
        const warehouses = await t.warehouse.findMany({ select: { code: true } });
        let maxNum = 0;
        for (const w of warehouses) {
          if (w.code) {
            const match = w.code.match(/^WH-(\d+)$/i);
            if (match) {
              const n = parseInt(match[1], 10);
              if (!isNaN(n) && n > maxNum) maxNum = n;
            }
          }
        }
        await t.numberSequence.upsert({
          where: { key: 'WAREHOUSE_CODE' },
          create: { key: 'WAREHOUSE_CODE', value: maxNum },
          update: {}
        });
      }

      for (let attempt = 0; attempt < 100; attempt++) {
        const seq = await t.numberSequence.upsert({
          where: { key: 'WAREHOUSE_CODE' },
          create: { key: 'WAREHOUSE_CODE', value: 1 },
          update: { value: { increment: 1 } }
        });
        const candidate = `WH-${String(seq.value).padStart(3, '0')}`;
        const collision = await t.warehouse.findFirst({ where: { code: candidate } });
        if (!collision) {
          return candidate;
        }
      }
      return `WH-${Date.now().toString().slice(-4)}`;
    };

    return tx ? run(tx) : prisma.$transaction(run);
  }

  /**
   * Previews the next available Warehouse Code for display without consuming the sequence.
   */
  static async previewNextWarehouseCode(): Promise<string> {
    const existingSeq = await prisma.numberSequence.findUnique({ where: { key: 'WAREHOUSE_CODE' } });
    let nextVal = 1;
    if (existingSeq) {
      nextVal = existingSeq.value + 1;
    } else {
      const warehouses = await prisma.warehouse.findMany({ select: { code: true } });
      let maxNum = 0;
      for (const w of warehouses) {
        if (w.code) {
          const match = w.code.match(/^WH-(\d+)$/i);
          if (match) {
            const n = parseInt(match[1], 10);
            if (!isNaN(n) && n > maxNum) maxNum = n;
          }
        }
      }
      nextVal = maxNum + 1;
    }

    let candidateVal = nextVal;
    for (let i = 0; i < 50; i++) {
      const candidate = `WH-${String(candidateVal).padStart(3, '0')}`;
      const exists = await prisma.warehouse.findFirst({ where: { code: candidate } });
      if (!exists) {
        return candidate;
      }
      candidateVal++;
    }

    return `WH-${String(candidateVal).padStart(3, '0')}`;
  }

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

      // Unique code assignment
      let finalCode: string;
      const requestedCode = data.code?.trim();
      if (requestedCode) {
        const codeClash = await tx.warehouse.findFirst({ where: { code: requestedCode } });
        if (!codeClash) {
          finalCode = requestedCode;
          const match = requestedCode.match(/^WH-(\d+)$/i);
          if (match) {
            const n = parseInt(match[1], 10);
            if (!isNaN(n)) {
              const cur = await tx.numberSequence.findUnique({ where: { key: 'WAREHOUSE_CODE' } });
              if (!cur || cur.value < n) {
                await tx.numberSequence.upsert({
                  where: { key: 'WAREHOUSE_CODE' },
                  create: { key: 'WAREHOUSE_CODE', value: n },
                  update: { value: n }
                });
              }
            }
          }
        } else {
          finalCode = await WarehouseService.nextWarehouseCode(tx);
        }
      } else {
        finalCode = await WarehouseService.nextWarehouseCode(tx);
      }

      const warehouse = await tx.warehouse.create({
        data: {
          name: data.name.trim(),
          nameKey,
          location: data.location?.trim() || null,
          type: data.type || null,
          code: finalCode,
          status: data.status || 'ACTIVE',
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
    const movements = await prisma.stockMovement.findMany({
      where: { warehouseId },
      include: {
        item: { select: { name: true, sku: true, unit: true } },
        batch: { select: { batchNumber: true, status: true } },
        bin: { select: { code: true } },
      },
    });

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
          status: m.batch?.status || 'READY',
          binId: m.binId,
          binCode: m.bin?.code || 'Not Assigned',
          balance: 0,
        };
      }

      balanceMap[key].balance += (m.baseQty !== null ? m.baseQty : m.quantity);
    }

    return Object.values(balanceMap).filter((b: any) => Math.abs(b.balance) > 0.001);
  }

  /**
   * Bin Management
   */
  static async getAllBins(filters?: { warehouseId?: string }) {
    const where: any = {};
    if (filters?.warehouseId && filters.warehouseId !== 'ALL') {
      where.warehouseId = filters.warehouseId;
    }

    const bins = await prisma.warehouseBin.findMany({
      where,
      include: {
        warehouse: {
          select: {
            id: true,
            name: true,
            code: true,
            location: true,
            status: true,
            type: true,
          },
        },
        movements: {
          select: {
            itemId: true,
            quantity: true,
            baseQty: true,
          },
        },
      },
      orderBy: [
        { warehouse: { name: 'asc' } },
        { code: 'asc' },
      ],
    });

    return bins.map((b) => {
      const itemIds = new Set(b.movements.map((m) => m.itemId));
      const totalQty = b.movements.reduce((sum, m) => sum + (m.baseQty !== null ? m.baseQty : m.quantity), 0);
      return {
        id: b.id,
        warehouseId: b.warehouseId,
        code: b.code,
        description: b.description,
        warehouse: b.warehouse,
        itemCount: itemIds.size,
        totalQuantity: totalQty,
        hasStock: Math.abs(totalQty) > 0.001,
        status: b.warehouse?.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      };
    });
  }

  static async createBin(warehouseId: string, code: string, description?: string) {
    const cleanCode = code.trim().toUpperCase();
    const existing = await prisma.warehouseBin.findFirst({
      where: { warehouseId, code: cleanCode },
    });
    if (existing) {
      throw new Error(`Bin code "${cleanCode}" already exists in this warehouse.`);
    }

    return prisma.warehouseBin.create({
      data: { warehouseId, code: cleanCode, description: description?.trim() || null },
      include: {
        warehouse: {
          select: { id: true, name: true, code: true, location: true, status: true, type: true },
        },
      },
    });
  }

  static async updateBin(binId: string, code: string, description?: string) {
    const current = await prisma.warehouseBin.findUnique({ where: { id: binId } });
    if (!current) throw new Error('Bin not found');

    const cleanCode = code.trim().toUpperCase();
    const existing = await prisma.warehouseBin.findFirst({
      where: {
        warehouseId: current.warehouseId,
        code: cleanCode,
        NOT: { id: binId },
      },
    });
    if (existing) {
      throw new Error(`Bin code "${cleanCode}" already exists in this warehouse.`);
    }

    return prisma.warehouseBin.update({
      where: { id: binId },
      data: {
        code: cleanCode,
        description: description !== undefined ? (description?.trim() || null) : undefined,
      },
      include: {
        warehouse: {
          select: { id: true, name: true, code: true, location: true, status: true, type: true },
        },
      },
    });
  }

  static async deleteBin(binId: string) {
    const hasMovements = await prisma.stockMovement.findFirst({ where: { binId } });
    if (hasMovements) {
      throw new Error('Cannot delete bin that has recorded stock movements.');
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
      const bin = await tx.warehouseBin.findUnique({ where: { id: data.newBinId } });
      if (!bin || bin.warehouseId !== data.warehouseId) {
        throw new Error('Invalid bin or warehouse');
      }

      const basePayload = {
        itemId: data.itemId,
        movementType: 'ADJUSTMENT' as any,
        referenceType: 'BIN_ASSIGNMENT',
        note: `Assigned to bin ${bin.code}`,
        createdBy: data.userId,
        warehouseId: data.warehouseId,
        batchId: data.batchId || null,
      };

      await tx.stockMovement.create({
        data: {
          ...basePayload,
          quantity: -data.quantity,
          binId: null,
        },
      });

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
