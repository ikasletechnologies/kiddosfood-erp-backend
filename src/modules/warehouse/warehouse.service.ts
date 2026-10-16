import prisma from '../../lib/prisma';
import { FranchiseService } from '../franchise/franchise.service';
import { FinanceService } from '../finance/finance.service';

const CENTRAL_FUND_ACCOUNT_CODE = 'CW-FUND';
const CENTRAL_FUND_ENTITY_TYPE = 'CENTRAL_WAREHOUSE';

// Warehouse selection elsewhere in the app is name-driven (dropdowns, stock
// lookups) — a near-duplicate name like "Home (Hopes)" next to "Home"
// silently splits stock across two records with no way to tell them apart.
// nameKey carries a DB-level unique constraint (see schema) so this is
// enforced even under concurrent requests, not just by the pre-check below.
function normalizeWarehouseName(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class WarehouseService {
  private static positiveQuantity(value: unknown, label = 'Quantity') {
    const quantity = Number(value);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`${label} must be greater than zero.`);
    return quantity;
  }

  private static async centralWarehouse(tx: any = prisma) {
    const hq = await FranchiseService.getHqFranchise();
    if (!hq.primaryWarehouseId) throw new Error('Central Warehouse has not been configured.');
    const warehouse = await tx.warehouse.findUnique({ where: { id: hq.primaryWarehouseId } });
    if (!warehouse) throw new Error('Central Warehouse record was not found.');
    return warehouse;
  }

  private static async binBalance(tx: any, binId: string) {
    const movements = await tx.stockMovement.findMany({ where: { binId }, select: { quantity: true, baseQty: true } });
    return movements.reduce((sum: number, movement: any) => sum + (movement.baseQty ?? movement.quantity), 0);
  }

  private static async allocationBalance(tx: any, warehouseId: string, itemId: string, batchId: string | null, binId: string | null) {
    const movements = await tx.stockMovement.findMany({
      where: { warehouseId, itemId, batchId, binId },
      select: { quantity: true, baseQty: true },
    });
    return movements.reduce((sum: number, movement: any) => sum + (movement.baseQty ?? movement.quantity), 0);
  }

  private static async assertCentralBin(tx: any, warehouseId: string, binId: string) {
    const bin = await tx.warehouseBin.findUnique({ where: { id: binId } });
    if (!bin || bin.warehouseId !== warehouseId) throw new Error('The selected bin does not belong to the Central Warehouse.');
    return bin;
  }

  private static async assertCentralItem(tx: any, warehouseId: string, itemId: string) {
    const [hq, item] = await Promise.all([
      tx.franchise.findFirst({ where: { isHQ: true, primaryWarehouseId: warehouseId }, select: { id: true } }),
      tx.inventoryItem.findUnique({ where: { id: itemId } }),
    ]);
    if (!hq) throw new Error('Central Warehouse is not linked to HQ.');
    if (!item || (item.franchiseId !== null && item.franchiseId !== hq.id)) {
      throw new Error('The selected item is not part of Central Warehouse inventory.');
    }
    return item;
  }

  private static async assertBinCapacity(tx: any, bin: any, incomingQuantity: number) {
    if (bin.capacity === null || bin.capacity === undefined) return;
    const occupied = await this.binBalance(tx, bin.id);
    if (occupied + incomingQuantity > bin.capacity + 0.001) {
      throw new Error(`Bin ${bin.code} capacity exceeded. Available capacity: ${Math.max(0, bin.capacity - occupied)}.`);
    }
  }

  static async getCentralWarehouse() {
    const warehouse = await this.centralWarehouse();
    const hq = await prisma.franchise.findFirst({ where: { isHQ: true, primaryWarehouseId: warehouse.id }, select: { id: true } });
    const [details, stock, items] = await Promise.all([
      prisma.warehouse.findUnique({ where: { id: warehouse.id }, include: { bins: { orderBy: { code: 'asc' } } } }),
      this.getWarehouseStock(warehouse.id),
      prisma.inventoryItem.findMany({ where: { isActive: true, OR: [{ franchiseId: null }, ...(hq ? [{ franchiseId: hq.id }] : [])] }, select: { id: true, name: true, sku: true, unit: true }, orderBy: { name: 'asc' } }),
    ]);
    const bins = (details?.bins || []).map((bin: any) => {
      const rows = (stock as any[]).filter((row) => row.binId === bin.id);
      const occupiedQuantity = rows.reduce((sum, row) => sum + row.balance, 0);
      return { ...bin, occupiedQuantity, availableCapacity: bin.capacity == null ? null : Math.max(0, bin.capacity - occupiedQuantity), occupied: occupiedQuantity > 0.001 };
    });
    return {
      warehouse: { ...details, bins },
      stock,
      items,
      summary: {
        totalItems: new Set((stock as any[]).map((row) => row.itemId)).size,
        totalBins: bins.length,
        occupiedBins: bins.filter((bin: any) => bin.occupied).length,
        availableBins: bins.filter((bin: any) => !bin.occupied).length,
      },
    };
  }

  static async updateCentralWarehouse(data: { name?: string; location?: string; status?: string; type?: string }) {
    const warehouse = await this.centralWarehouse();
    const update: any = {};
    if (data.name !== undefined) {
      if (!data.name.trim()) throw new Error('Warehouse name is required.');
      update.name = data.name.trim();
      update.nameKey = normalizeWarehouseName(data.name);
    }
    if (data.location !== undefined) update.location = data.location.trim() || null;
    if (data.status !== undefined) update.status = data.status;
    if (data.type !== undefined) update.type = data.type;
    return prisma.warehouse.update({ where: { id: warehouse.id }, data: update });
  }

  private static fundAmount(value: unknown) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Fund amount must be greater than zero.');
    if (amount > 1_000_000_000_000) throw new Error('Fund amount is out of range.');
    return amount;
  }

  private static cleanFundNote(value: unknown) {
    const note = typeof value === 'string' ? value.trim() : '';
    if (note.length > 500) throw new Error('Fund note cannot exceed 500 characters.');
    return note;
  }

  static async getCentralFunds() {
    const warehouse = await this.centralWarehouse();
    const account = await prisma.account.findUnique({ where: { accountCode: CENTRAL_FUND_ACCOUNT_CODE } });
    const history = await prisma.payment.findMany({
      where: {
        entityType: CENTRAL_FUND_ENTITY_TYPE,
        entityId: warehouse.id,
        sourceModule: 'MANUAL',
        status: 'PAID',
        isCancelled: false,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        paymentNumber: true,
        paidAmount: true,
        transactionRef: true,
        createdAt: true,
        createdBy: true,
      } as any,
    });
    return {
      warehouse: { id: warehouse.id, name: warehouse.name, code: warehouse.code },
      balance: account?.balance || 0,
      history,
    };
  }

  static async addCentralFund(data: { amount?: number; note?: string; createdBy?: string }) {
    const amount = this.fundAmount(data.amount);
    const note = this.cleanFundNote(data.note);
    return prisma.$transaction(async (tx) => {
      const warehouse = await this.centralWarehouse(tx);
      const hq = await tx.franchise.findFirst({ where: { isHQ: true }, select: { id: true } });
      if (!hq) throw new Error('HQ franchise is not configured.');
      const account = await tx.account.upsert({
        where: { accountCode: CENTRAL_FUND_ACCOUNT_CODE },
        update: {},
        create: {
          name: 'Central Warehouse Fund',
          type: 'CASH',
          balance: 0,
          accountCode: CENTRAL_FUND_ACCOUNT_CODE,
          status: 'ACTIVE',
          franchiseId: hq.id,
        },
      });
      if (account.franchiseId !== hq.id) throw new Error('Central Warehouse fund account is not linked to HQ.');
      return FinanceService.createPayment({
        amount,
        flow: 'IN',
        method: 'CASH',
        sourceAccount: account.id,
        franchiseId: hq.id,
        entityType: CENTRAL_FUND_ENTITY_TYPE,
        entityId: warehouse.id,
        sourceModule: 'MANUAL',
        linkedDocType: 'DIRECT',
        type: 'DIRECT',
        status: 'PAID',
        note: note || 'Central Warehouse fund added',
        createdBy: data.createdBy,
        tx,
      });
    });
  }

  static async updateCentralFund(paymentId: string, data: { amount?: number; note?: string; updatedBy?: string }) {
    const amount = this.fundAmount(data.amount);
    const note = this.cleanFundNote(data.note);
    return prisma.$transaction(async (tx) => {
      const warehouse = await this.centralWarehouse(tx);
      const payment = await tx.payment.findFirst({
        where: {
          id: paymentId,
          entityType: CENTRAL_FUND_ENTITY_TYPE,
          entityId: warehouse.id,
          sourceModule: 'MANUAL',
          status: 'PAID',
          isCancelled: false,
        },
      });
      if (!payment || !payment.accountId) throw new Error('Central Warehouse fund entry was not found.');
      const account = await tx.account.findUnique({ where: { id: payment.accountId }, select: { balance: true } });
      if (!account) throw new Error('Central Warehouse fund account was not found.');
      if (account.balance + amount - payment.paidAmount < -0.001) {
        throw new Error('Fund amount cannot be reduced below the amount already used.');
      }
      const changed = await tx.payment.updateMany({
        where: { id: payment.id, paidAmount: payment.paidAmount },
        data: {
          paidAmount: amount,
          transactionRef: note || 'Central Warehouse fund added',
        },
      });
      if (changed.count !== 1) throw new Error('Fund entry changed while editing. Please refresh and try again.');
      await tx.account.update({
        where: { id: payment.accountId },
        data: { balance: { increment: amount - payment.paidAmount } },
      });
      return tx.payment.findUnique({ where: { id: payment.id } });
    });
  }

  static async createCentralBin(data: { code?: string; description?: string; capacity?: number | null }) {
    const warehouse = await this.centralWarehouse();
    if (!data.code?.trim()) throw new Error('Bin code is required.');
    const capacity = data.capacity == null ? null : this.positiveQuantity(data.capacity, 'Capacity');
    const existing = await prisma.warehouseBin.findFirst({ where: { warehouseId: warehouse.id, code: data.code.trim().toUpperCase() } });
    if (existing) throw new Error(`Bin code "${existing.code}" already exists in the Central Warehouse.`);
    return prisma.warehouseBin.create({ data: { warehouseId: warehouse.id, code: data.code.trim().toUpperCase(), description: data.description?.trim() || null, capacity } });
  }

  static async updateCentralBin(binId: string, data: { code?: string; description?: string; capacity?: number | null }) {
    const warehouse = await this.centralWarehouse();
    const bin = await this.assertCentralBin(prisma, warehouse.id, binId);
    const update: any = {};
    if (data.code !== undefined) {
      if (!data.code.trim()) throw new Error('Bin code is required.');
      update.code = data.code.trim().toUpperCase();
      const existing = await prisma.warehouseBin.findFirst({ where: { warehouseId: warehouse.id, code: update.code, NOT: { id: bin.id } } });
      if (existing) throw new Error(`Bin code "${existing.code}" already exists in the Central Warehouse.`);
    }
    if (data.description !== undefined) update.description = data.description.trim() || null;
    if (data.capacity !== undefined) {
      const capacity = data.capacity == null ? null : this.positiveQuantity(data.capacity, 'Capacity');
      const occupied = await this.binBalance(prisma, bin.id);
      if (capacity !== null && capacity + 0.001 < occupied) throw new Error(`Capacity cannot be less than the current quantity (${occupied}).`);
      update.capacity = capacity;
    }
    return prisma.warehouseBin.update({ where: { id: bin.id }, data: update });
  }

  static async deleteCentralBin(binId: string) {
    const warehouse = await this.centralWarehouse();
    await this.assertCentralBin(prisma, warehouse.id, binId);
    return this.deleteBin(binId);
  }

  static async centralStockIn(data: { itemId?: string; quantity?: number; binId?: string; batchCode?: string; status?: string; note?: string; userId?: string }) {
    if (!data.itemId || !data.binId) throw new Error('Item and bin are required.');
    const quantity = this.positiveQuantity(data.quantity);
    return prisma.$transaction(async (tx) => {
      const warehouse = await this.centralWarehouse(tx);
      const bin = await this.assertCentralBin(tx, warehouse.id, data.binId!);
      await this.assertBinCapacity(tx, bin, quantity);
      const item = await this.assertCentralItem(tx, warehouse.id, data.itemId!);
      const status = data.status || 'APPROVED';
      if (!['QC_HOLD', 'APPROVED', 'REJECTED', 'BLOCKED'].includes(status)) throw new Error('Invalid stock status.');
      const batch = await tx.inventoryBatch.create({ data: { inventoryItemId: item.id, batchNumber: data.batchCode?.trim() || `CW-${Date.now()}`, initialQty: quantity, currentQty: quantity, warehouseId: warehouse.id, status: status as any } });
      await tx.stockMovement.create({ data: { itemId: item.id, movementType: 'ADJUSTMENT' as any, quantity, baseQty: quantity, referenceType: 'CENTRAL_WAREHOUSE_STOCK_IN', note: data.note?.trim() || 'Central Warehouse stock in', createdBy: data.userId, warehouseId: warehouse.id, batchId: batch.id, binId: bin.id } });
      await tx.inventoryItem.update({ where: { id: item.id }, data: { currentStock: { increment: quantity } } });
      return { success: true, batchId: batch.id };
    });
  }

  static async centralStockOut(data: { itemId?: string; batchId?: string | null; binId?: string; quantity?: number; note?: string; userId?: string }) {
    if (!data.itemId || !data.binId) throw new Error('Item and source bin are required.');
    const quantity = this.positiveQuantity(data.quantity);
    return prisma.$transaction(async (tx) => {
      const warehouse = await this.centralWarehouse(tx);
      await this.assertCentralItem(tx, warehouse.id, data.itemId!);
      await this.assertCentralBin(tx, warehouse.id, data.binId!);
      const batchId = data.batchId || null;
      const available = await this.allocationBalance(tx, warehouse.id, data.itemId!, batchId, data.binId!);
      if (quantity > available + 0.001) throw new Error(`Insufficient stock. Available quantity: ${available}.`);
      if (batchId) {
        const batch = await tx.inventoryBatch.findUnique({ where: { id: batchId } });
        if (!batch || batch.warehouseId !== warehouse.id || batch.inventoryItemId !== data.itemId) throw new Error('Invalid Central Warehouse batch.');
        if (batch.currentQty + 0.001 < quantity) throw new Error(`Insufficient batch stock. Available quantity: ${batch.currentQty}.`);
        await tx.inventoryBatch.update({ where: { id: batch.id }, data: { currentQty: { decrement: quantity } } });
      }
      await tx.stockMovement.create({ data: { itemId: data.itemId!, movementType: 'ADJUSTMENT' as any, quantity: -quantity, baseQty: -quantity, referenceType: 'CENTRAL_WAREHOUSE_STOCK_OUT', note: data.note?.trim() || 'Central Warehouse stock out', createdBy: data.userId, warehouseId: warehouse.id, batchId, binId: data.binId! } });
      await tx.inventoryItem.update({ where: { id: data.itemId! }, data: { currentStock: { decrement: quantity } } });
      return { success: true };
    });
  }

  static async moveCentralStock(data: { itemId?: string; batchId?: string | null; fromBinId?: string; toBinId?: string; quantity?: number; note?: string; userId?: string }) {
    if (!data.itemId || !data.fromBinId || !data.toBinId) throw new Error('Item, source bin, and destination bin are required.');
    if (data.fromBinId === data.toBinId) throw new Error('Source and destination bins must be different.');
    const quantity = this.positiveQuantity(data.quantity);
    return prisma.$transaction(async (tx) => {
      const warehouse = await this.centralWarehouse(tx);
      await this.assertCentralItem(tx, warehouse.id, data.itemId!);
      const [fromBin, toBin] = await Promise.all([this.assertCentralBin(tx, warehouse.id, data.fromBinId!), this.assertCentralBin(tx, warehouse.id, data.toBinId!)]);
      const batchId = data.batchId || null;
      const available = await this.allocationBalance(tx, warehouse.id, data.itemId!, batchId, fromBin.id);
      if (quantity > available + 0.001) throw new Error(`Insufficient stock in ${fromBin.code}. Available quantity: ${available}.`);
      await this.assertBinCapacity(tx, toBin, quantity);
      const common = { itemId: data.itemId!, movementType: 'ADJUSTMENT' as any, referenceType: 'CENTRAL_WAREHOUSE_BIN_MOVE', note: data.note?.trim() || `Moved from ${fromBin.code} to ${toBin.code}`, createdBy: data.userId, warehouseId: warehouse.id, batchId };
      await tx.stockMovement.createMany({ data: [{ ...common, quantity: -quantity, baseQty: -quantity, binId: fromBin.id }, { ...common, quantity, baseQty: quantity, binId: toBin.id }] });
      return { success: true };
    });
  }

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
