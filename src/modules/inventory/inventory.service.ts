import { FranchiseService } from '../franchise/franchise.service';
import prisma from
  '../../lib/prisma';
import { ItemCategory, StockMovementType } from '@prisma/client';

export interface FifoConsumption {
  batchId: string;
  // The purchase bill this batch was received under (see grn.service.ts) —
  // what the business actually identifies a lot by, not an internal id.
  billNumber: string;
  productBatchId: string | null;
  qty: number;
  unitCost: number;
  totalCost: number;
}

export interface FifoConsumptionResult {
  consumptions: FifoConsumption[];
  consumedFromBatches: number;
  totalCost: number;
  unitCost: number;
}

function mapCategoryToDb(category?: string): ItemCategory {
  if (!category) return ItemCategory.RAW_MATERIAL;
  if (category.startsWith('RAW_')) return ItemCategory.RAW_MATERIAL;
  if (category.startsWith('PACKAGING_')) return ItemCategory.PACKAGING;
  if (category === 'SEMI_FINISHED') return ItemCategory.SEMI_FINISHED;
  if (category === 'FINISHED_GOOD') return ItemCategory.FINISHED_GOOD;
  if (category === 'PACKAGING') return ItemCategory.PACKAGING;
  return ItemCategory.RAW_MATERIAL;
}

// Keeps the Product catalog in sync with an HQ FINISHED_GOOD/SEMI_FINISHED
// InventoryItem — shared by createItem and updateItem so there's exactly
// one matching rule instead of two copies that can drift.
//
// Matches by SKU first: once a product has a SKU, it's the reliable unique
// key (mirrors matchesProduct() on the frontend). The name-only fallback
// is scoped to `sku: null` — a legacy product that never got a real SKU —
// so it can never grab a DIFFERENT, already-SKU'd product just because it
// happens to share a display name (e.g. the 500G/250G weight variants of
// the same product name, which the bulk-import flow explicitly creates as
// two distinct SKUs). Without that scope, a name match could try to
// overwrite an unrelated product's SKU and hit its unique constraint.
async function syncProductFromInventoryItem(tx: any, item: { name: string; sku: string; basePrice?: number | null; category: ItemCategory; hsnCode?: string | null; sacCode?: string | null; gstRate?: number | null }) {
  const existingProduct = await tx.product.findFirst({ where: { sku: item.sku } })
    ?? await tx.product.findFirst({ where: { name: { equals: item.name, mode: 'insensitive' }, sku: null } });

  const taxPercent = item.gstRate !== undefined && item.gstRate !== null ? item.gstRate : 5;

  if (!existingProduct) {
    await tx.product.create({
      data: {
        name: item.name,
        sku: item.sku,
        basePrice: item.basePrice || 0,
        taxPercent,
        hsnCode: item.hsnCode || null,
        sacCode: item.sacCode || null,
        isActive: true,
        productType: item.category === ItemCategory.FINISHED_GOOD ? 'FINISHED_GOOD' : 'MADE_TO_ORDER',
        category: 'Automated Sync'
      }
    });
    console.log(`✅ [Sync] Created new product for HQ Inventory Item: ${item.name}`);
  } else {
    await tx.product.update({
      where: { id: existingProduct.id },
      data: {
        name: item.name,
        sku: item.sku,
        basePrice: item.basePrice || 0,
        taxPercent: item.gstRate !== undefined && item.gstRate !== null ? item.gstRate : existingProduct.taxPercent,
        hsnCode: item.hsnCode !== undefined ? item.hsnCode : existingProduct.hsnCode,
        sacCode: item.sacCode !== undefined ? item.sacCode : existingProduct.sacCode
      }
    });
    console.log(`🔄 [Sync] Updated existing product for HQ Inventory Item: ${item.name}`);
  }
}

export class InventoryService {
  // Compute current stock from movement ledger — single source of truth
  static async computeStock(itemId: string, tx: any = prisma): Promise<number> {
    const movements = await tx.stockMovement.findMany({
      where: { itemId },
      select: { quantity: true, baseQty: true }
    });
    return movements.reduce((acc: number, m: any) => acc + (m.baseQty !== null ? m.baseQty : m.quantity), 0);
  }

  /**
   * Per-warehouse balance for one item. `Warehouse`/`WarehouseBin` previously
   * existed only as tags on StockMovement with no real per-warehouse balance
   * anywhere. Movements that don't carry a warehouseId (POS/Production
   * currently don't tag one) are attributed to the item's franchise's
   * `primaryWarehouseId` for this aggregate, rather than retrofitting every
   * movement-creation call site to always pass a warehouse.
   */
  static async computeWarehouseStock(itemId: string, warehouseId: string, tx: any = prisma): Promise<number> {
    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      include: { franchise: { select: { primaryWarehouseId: true } } }
    });
    const primaryWarehouseId = item?.franchise?.primaryWarehouseId;

    const movements = await tx.stockMovement.findMany({
      where: { itemId },
      select: { quantity: true, baseQty: true, warehouseId: true }
    });

    return movements.reduce((acc: number, m: any) => {
      const effectiveWarehouseId = m.warehouseId || primaryWarehouseId;
      if (effectiveWarehouseId !== warehouseId) return acc;
      return acc + (m.baseQty !== null ? m.baseQty : m.quantity);
    }, 0);
  }

  /**
   * Balances for every item that has ever moved through this warehouse
   * (directly or via the franchise's primary-warehouse default).
   */
  static async getWarehouseStockReport(warehouseId: string) {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new Error('Warehouse not found');

    const franchisesUsingAsPrimary = await prisma.franchise.findMany({
      where: { primaryWarehouseId: warehouseId },
      select: { id: true }
    });
    const primaryFranchiseIds = franchisesUsingAsPrimary.map((f) => f.id);

    // Candidate items: anything tagged directly on a movement to this
    // warehouse, plus everything belonging to a franchise whose primary
    // warehouse is this one (movements there might not tag a warehouse at all).
    const [directItemIds, franchiseItems] = await Promise.all([
      prisma.stockMovement.findMany({
        where: { warehouseId },
        select: { itemId: true },
        distinct: ['itemId']
      }),
      primaryFranchiseIds.length > 0
        ? prisma.inventoryItem.findMany({
            where: { franchiseId: { in: primaryFranchiseIds } },
            select: { id: true, name: true, sku: true, unit: true }
          })
        : Promise.resolve([])
    ]);

    const itemIds = new Set<string>(directItemIds.map((m) => m.itemId));
    franchiseItems.forEach((i) => itemIds.add(i.id));

    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: Array.from(itemIds) } },
      select: { id: true, name: true, sku: true, unit: true }
    });

    const balances = await Promise.all(
      items.map(async (item) => ({
        itemId: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        balance: await this.computeWarehouseStock(item.id, warehouseId)
      }))
    );

    return {
      warehouse: { id: warehouse.id, name: warehouse.name },
      balances: balances.filter((b) => Math.abs(b.balance) > 0.001)
    };
  }

  // franchiseId is optional: Prisma drops an `undefined` where-key entirely,
  // so omitting it here correctly means "every franchise" (SUPER_ADMIN's
  // global view), not "no results" — do not substitute a default franchise.
  static async getInventory(franchiseId: string | undefined, includeInactive = false, excludeCategories?: ItemCategory[], category?: ItemCategory, asOfDate?: string) {
    let scopeFilter: any = {};
    if (franchiseId) {
      const hq = await FranchiseService.getHqFranchiseOrNull();
      const isHQ = !hq || hq.id === franchiseId;
      scopeFilter = isHQ ? { OR: [{ franchiseId }, { franchiseId: null }] } : { franchiseId };
    }

    const items = await prisma.inventoryItem.findMany({
      where: {
        ...scopeFilter,
        ...(includeInactive ? {} : { isActive: true }),
        ...(excludeCategories && excludeCategories.length > 0 ? { category: { notIn: excludeCategories } } : {}),
        ...(category ? { category } : {})
      },
      include: {
        movements: { orderBy: { createdAt: 'desc' }, take: 5 },
        vendor: true,
      },
      orderBy: { name: 'asc' },
    });

    const asOfBoundary = asOfDate
      ? (/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)
          ? new Date(`${asOfDate}T23:59:59.999+05:30`)
          : (() => {
              const d = new Date(asOfDate);
              d.setHours(23, 59, 59, 999);
              return d;
            })())
      : undefined;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const itemWhere = franchiseId ? { item: scopeFilter } : {};

    const movementsToday = await prisma.stockMovement.findMany({
      where: { ...itemWhere, createdAt: { gte: today } },
    });

    // Recompute stock from movements for accuracy (scoped to asOfBoundary when provided)
    const allMovements = await prisma.stockMovement.findMany({
      where: {
        ...itemWhere,
        ...(asOfBoundary ? { createdAt: { lte: asOfBoundary } } : {})
      },
      select: { itemId: true, quantity: true, baseQty: true },
    });
    const stockMap = new Map<string, number>();
    allMovements.forEach(m => {
      const val = m.baseQty !== null ? m.baseQty : m.quantity;
      stockMap.set(m.itemId, (stockMap.get(m.itemId) || 0) + val);
    });

    // Identify which items have EVER been purchased (from movements or linked vendor)
    const itemsWithPurchaseMovements = await prisma.stockMovement.findMany({
      where: {
        ...itemWhere,
        movementType: StockMovementType.PURCHASE_IN
      },
      select: { itemId: true },
      distinct: ['itemId']
    });
    const purchasedItemIds = new Set(itemsWithPurchaseMovements.map(m => m.itemId));

    // Calculate "Incoming" stock from Pending/Approved but not yet Received POs
    const pendingOrders = await prisma.procurementOrderItem.findMany({
      where: {
        procurementOrder: { status: { in: ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] } },
        ...(franchiseId ? { inventoryItem: scopeFilter } : {})
      },
      select: { inventoryItemId: true, quantity: true }
    });
    const pendingMap = new Map();
    pendingOrders.forEach(po => {
      pendingMap.set(po.inventoryItemId, (pendingMap.get(po.inventoryItemId) || 0) + po.quantity);
    });

    return items.map(item => {
      // Use recomputed stock from ledger (movements) as source of truth
      // When asOfDate is provided, any item with no movements prior to boundary has 0 stock
      const hasMovements = stockMap.has(item.id);
      const computedStock = hasMovements
        ? (stockMap.get(item.id) ?? 0)
        : asOfBoundary
        ? 0
        : item.currentStock;

      const todayMoves = movementsToday.filter(m => m.itemId === item.id);
      const inbound = todayMoves.filter(m => (m.baseQty !== null ? m.baseQty : m.quantity) > 0).reduce((s, m) => s + (m.baseQty !== null ? m.baseQty : m.quantity), 0);
      const outbound = Math.abs(todayMoves.filter(m => (m.baseQty !== null ? m.baseQty : m.quantity) < 0).reduce((s, m) => s + (m.baseQty !== null ? m.baseQty : m.quantity), 0));

      const status = computedStock <= item.minimumStock ? 'LOW' : 'SAFE';

      const incomingStock = pendingMap.get(item.id) || 0;

      // An item is considered "Purchased" if it has a linked vendor OR has been purchased in the past OR has a pending order
      const hasPurchaseMovement = item.movements?.some(m => m.movementType === 'PURCHASE_IN');
      const isPurchased = !!item.vendorId || purchasedItemIds.has(item.id) || hasPurchaseMovement || incomingStock > 0;

      return {
        ...item,
        currentStock: computedStock,
        inbound,
        outbound,
        status,
        isPurchased,
        incomingStock
      };
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
          name: { equals: data.name, mode: 'insensitive' },
          vendorId: data.vendorId // Only block if the same name AND same vendor (or both manual)
        }
      });
      if (existing) {
        const sourceLabel = data.vendorId ? "the same vendor" : "manual entry";
        throw new Error(`A material with the name "${data.name}" already exists for ${sourceLabel}. Please update the existing record or use a distinct name.`);
      }
    }

    const targetFranchiseId = (data.franchiseId && typeof data.franchiseId === 'string' && data.franchiseId.trim().length > 0)
      ? data.franchiseId.trim()
      : null;

    const sku = (data.sku && typeof data.sku === 'string' && data.sku.trim().length > 0)
      ? data.sku.trim().toUpperCase()
      : `RM-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    // Validate SKU uniqueness for this target scope before creation
    const existingSkuItem = await prisma.inventoryItem.findFirst({
      where: {
        sku: { equals: sku, mode: 'insensitive' },
        franchiseId: targetFranchiseId,
      }
    });
    if (existingSkuItem) {
      throw new Error(`An item with SKU "${sku}" already exists in the catalog.`);
    }

    return prisma.$transaction(async tx => {

      // No franchiseId given at all — historically treated as an HQ-scoped
      // item (falls through to the isHQ pricing branch below).
      let isHQ = true;

      if (targetFranchiseId) {
        let franchise = await tx.franchise.findUnique({ where: { id: targetFranchiseId } });
        if (!franchise) {
          console.log(`⚠️ Franchise '${targetFranchiseId}' not found in DB. Auto-creating default franchise record...`);
          // Never auto-created as HQ (schema default isHQ=false) — HQ status
          // is only ever granted by explicitly setting Franchise.isHQ, never
          // inferred here just because the caller happened to pass 'hq-001'.
          franchise = await tx.franchise.create({
            data: {
              id: targetFranchiseId,
              name: targetFranchiseId === 'hq-001' ? 'Main Headquarters' : `Franchise ${targetFranchiseId}`,
              location: 'Default Location',
              ownerName: 'Super Admin',
              contactNum: '0000000000',
              status: 'ACTIVE'
            }
          });
        }
        // Franchise.isHQ identifies WHICH franchise is headquarters;
        // InventoryItem.franchiseId = null is the separate convention for
        // "this stock belongs to HQ" — storing the HQ franchise's own id
        // here instead of null is what split HQ inventory between null and
        // a literal id (see syncInventoryItemForProduct's identical fix).
        data.franchiseId = franchise.isHQ ? null : franchise.id;
        isHQ = franchise.isHQ;
      } else {
        data.franchiseId = null;
      }

      const createData: any = {
        name: data.name,
        sku,
        category: mapCategoryToDb(data.category),
        currentStock: 0,
        unit: data.unit || (data.category === 'FINISHED_GOOD' ? 'PC' : 'kg'),
        minimumStock: data.minimumStock || 10,
        hsnCode: data.hsnCode,
        gstRate: data.gstRate !== undefined ? Number(data.gstRate) : 5,
        franchiseId: data.franchiseId,
        vendorId: data.vendorId,
      };

      // Financial fields (Safe injection)
      if (data.costPrice !== undefined) createData.costPrice = Number(data.costPrice) || 0;
      if (data.franchisePrice !== undefined) createData.franchisePrice = Number(data.franchisePrice) || 0;
      if (data.dealerPrice !== undefined) createData.dealerPrice = Number(data.dealerPrice) || 0;
      if (data.customerPrice !== undefined) createData.customerPrice = Number(data.customerPrice) || 0;

      // Inherit an existing Product's price when the caller didn't supply
      // one — without this, creating the (missing) InventoryItem for an
      // already-priced Finished Good product (e.g. the Stock Hub "Edit"
      // auto-create-on-first-click flow) defaults to ₹0 here, and then this
      // same function's own Product-sync below pushes that ₹0 back onto
      // the product, silently erasing a real price the moment someone
      // first opens the Item Master for it.
      let inheritedBasePrice: number | undefined;
      if (data.basePrice === undefined && data.franchisePrice === undefined) {
        const matchingProduct = await tx.product.findFirst({ where: { sku } });
        if (matchingProduct && matchingProduct.basePrice) inheritedBasePrice = matchingProduct.basePrice;
      }

      if (isHQ) {
        createData.basePrice = Number(data.franchisePrice) || Number(data.basePrice) || inheritedBasePrice || 0;
      } else {
        if (data.basePrice !== undefined || inheritedBasePrice !== undefined) {
          createData.basePrice = Number(data.basePrice) || inheritedBasePrice || 0;
        }
      }
      if (inheritedBasePrice !== undefined && data.customerPrice === undefined) createData.customerPrice = inheritedBasePrice;

      const item = await tx.inventoryItem.create({
        data: createData,
      });

      if (data.initialStock > 0) {
        await this.recordMovement(tx, {
          itemId: item.id,
          type: StockMovementType.ADJUSTMENT,
          quantity: data.initialStock,
          referenceType: 'ADJUSTMENT',
          note: 'Opening Stock Balance',
          userId: data.userId,
          warehouseId: (data.warehouseId || '').trim() || null,
        });
      }

      // ─── AUTOMATION: Sync with Product Master if category is FINISHED_GOOD or SEMI_FINISHED at HQ ───
      const orderableCategories: ItemCategory[] = [ItemCategory.FINISHED_GOOD, ItemCategory.SEMI_FINISHED];
      
      if (orderableCategories.includes(item.category)) {
        if (isHQ) {
          // This whole sync is best-effort background consistency, not
          // something the user's actual Save action should ever hard-fail
          // on — a sync collision used to bubble up as a raw 500 (P2002)
          // and abort the entire create, even though the InventoryItem
          // itself (and its stock movement) had already succeeded.
          try {
            await syncProductFromInventoryItem(tx, item);
          } catch (syncErr: any) {
            console.warn(`[Sync] Skipped Product sync for "${item.name}" (${item.sku}):`, syncErr.message);
          }
        }
      }

      return item;
    });
  }

  // Only update metadata — never update currentStock directly
  static async updateItem(id: string, data: any) {
    const currentItem = await prisma.inventoryItem.findUnique({ where: { id } });
    const finalCategory = data.category ? mapCategoryToDb(data.category) : currentItem?.category;
    
    const { currentStock: _currentStock, ...safeData } = data; // strip any stock field
    if (safeData.category) {
      safeData.category = mapCategoryToDb(safeData.category);
    }

    const franchiseId = safeData.franchiseId || (await prisma.inventoryItem.findUnique({ where: { id }, select: { franchiseId: true } }))?.franchiseId;
    // No franchiseId at all -> HQ-scoped, same convention createItem uses
    // (see its comment). This used to default to `isHQ = false` instead,
    // so an HQ item created with no franchiseId (the normal case — see
    // createItem) never had its Product-sync run on subsequent edits, only
    // on its initial create.
    let isHQ = true;
    if (franchiseId) {
      const franchise = await prisma.franchise.findUnique({ where: { id: franchiseId } });
      isHQ = franchise?.isHQ || false;
    }

    if (isHQ && (data.franchisePrice !== undefined || data.basePrice !== undefined)) {
      safeData.basePrice = data.franchisePrice !== undefined ? (Number(data.franchisePrice) || 0) : (Number(data.basePrice) || 0);
    }

    // Filter to only include fields defined in Prisma schema to avoid unknown argument errors
    const validFields = [
      'name', 'sku', 'category', 'unit', 'minimumStock', 'batchNo', 
      'expiryDate', 'franchiseId', 'vendorId', 'gstRate', 'hsnCode', 
      'isActive', 'basePrice', 'costPrice', 'franchisePrice', 'dealerPrice', 'customerPrice'
    ];

    const updatePayload: any = {};
    for (const key of validFields) {
      if (safeData[key] !== undefined) {
        if (key === 'gstRate' || key === 'minimumStock') {
          updatePayload[key] = Number(safeData[key]) || 0;
        } else if (key === 'basePrice' || key === 'costPrice' || key === 'franchisePrice' || key === 'dealerPrice' || key === 'customerPrice') {
          updatePayload[key] = safeData[key] === null ? null : (Number(safeData[key]) || 0);
        } else {
          updatePayload[key] = safeData[key];
        }
      }
    }

    const updated = await prisma.inventoryItem.update({ where: { id }, data: updatePayload });

    // Handle opening/initial stock updates safely through stock movement ledger
    if (data.initialStock !== undefined) {
      const newInitialStock = Number(data.initialStock) || 0;
      
      const openingMovement = await prisma.stockMovement.findFirst({
        where: {
          itemId: id,
          note: 'Opening Stock Balance'
        }
      });

      if (openingMovement) {
        const diff = newInitialStock - openingMovement.quantity;
        if (diff !== 0) {
          await prisma.$transaction(async tx => {
            await tx.stockMovement.update({
              where: { id: openingMovement.id },
              data: { quantity: newInitialStock }
            });
            // Update cache currentStock
            await tx.inventoryItem.update({
              where: { id },
              data: { currentStock: { increment: diff } }
            });
          });
        }
      } else if (newInitialStock > 0) {
        await prisma.$transaction(async tx => {
          await tx.stockMovement.create({
            data: {
              itemId: id,
              movementType: StockMovementType.ADJUSTMENT,
              quantity: newInitialStock,
              referenceType: 'ADJUSTMENT',
              note: 'Opening Stock Balance',
              createdBy: data.userId,
              warehouseId: (data.binLocation || data.warehouseId || '').trim() || null
            }
          });
          // Update cache currentStock
          await tx.inventoryItem.update({
            where: { id },
            data: { currentStock: { increment: newInitialStock } }
          });
        });
      }
    }

    // Sync on update as well if category is orderable — same best-effort
    // resilience as createItem: this must never fail the user's actual
    // Save (see syncProductFromInventoryItem for the matching rule).
    const orderableCategories: ItemCategory[] = [ItemCategory.FINISHED_GOOD, ItemCategory.SEMI_FINISHED];
    if (orderableCategories.includes(updated.category)) {
      if (isHQ) {
        try {
          await syncProductFromInventoryItem(prisma, updated);
        } catch (syncErr: any) {
          console.warn(`[Sync] Skipped Product sync for "${updated.name}" (${updated.sku}):`, syncErr.message);
        }
      }
    }
    return updated;
  }

  static async deleteItem(id: string) {
    // Check for critical dependencies to provide helpful error messages
    const [
      recipeLinks,
      productionLinks,
      poLinks,
      movementLinks,
      requestLinks,
      transferLinks
    ] = await Promise.all([
      prisma.recipeItem.count({ where: { inventoryItemId: id } }),
      prisma.productionItem.count({ where: { inventoryItemId: id } }),
      prisma.procurementOrderItem.count({ where: { inventoryItemId: id } }),
      prisma.stockMovement.count({ where: { itemId: id } }),
      prisma.stockRequestItem.count({ where: { inventoryItemId: id } }),
      prisma.stockTransferItem.count({ where: { inventoryItemId: id } })
    ]);

    if (recipeLinks > 0) {
      throw new Error(`Deletion Blocked: This material is part of ${recipeLinks} recipe(s). Please remove it from your recipes first.`);
    }

    if (productionLinks > 0 || movementLinks > 0) {
      const totalHistory = productionLinks + movementLinks;
      throw new Error(`Deletion Blocked: This item has ${totalHistory} recorded history entries (Production/Stock Movements). Deleting it would break audit logs. Please mark it as 'Inactive' instead.`);
    }

    if (poLinks > 0) {
      throw new Error(`Deletion Blocked: This material is referenced in ${poLinks} purchase order(s) or GRNs.`);
    }

    if (requestLinks > 0 || transferLinks > 0) {
      throw new Error(`Deletion Blocked: This material is linked to pending branch requests or transfers.`);
    }

    return prisma.$transaction(async tx => {
      const item = await tx.inventoryItem.findUnique({ where: { id } });

      if (item && (item.category === 'FINISHED_GOOD' || item.category === 'SEMI_FINISHED')) {
        const franchise = item.franchiseId ? await tx.franchise.findUnique({ where: { id: item.franchiseId } }) : null;
        const isHQ = franchise?.isHQ || false;

        if (isHQ) {
          const syncedProduct = await tx.product.findUnique({ where: { sku: item.sku || "" } });
          if (syncedProduct) {
            // Only delete product if it has no sales history
            const usageCount = await tx.orderItem.count({ where: { productId: syncedProduct.id } });
            if (usageCount === 0) {
              await tx.product.delete({ where: { id: syncedProduct.id } });
              console.log(`🗑️ [Sync] Deleted synced product master: ${item.name}`);
            }
          }
        }
      }

      return tx.inventoryItem.delete({ where: { id } });
    });
  }

  static async deactivateItem(id: string) {
    return (prisma.inventoryItem as any).update({
      where: { id },
      data: { isActive: false },
    });
  }

  static async activateItem(id: string) {
    return (prisma.inventoryItem as any).update({
      where: { id },
      data: { isActive: true },
    });
  }

  // Internal: stock-in via GRN / procurement — not exposed as free-form UI edit
  static async stockIn(data: { itemId: string; quantity: number; unit?: string; type?: any; note?: string; userId?: string; referenceType?: string; referenceId?: string }, externalTx?: any) {
    const run = (tx: any) =>
      this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type ?? 'PURCHASE_IN',
        quantity: data.quantity,
        transactionUnit: data.unit,
        note: data.note,
        userId: data.userId,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
      });
    return externalTx ? run(externalTx) : prisma.$transaction(run);
  }

  // Internal: stock-out via production / waste — not exposed as free-form UI edit
  static async stockOut(data: { itemId: string; quantity: number; unit?: string; type?: any; note?: string; userId?: string; referenceType?: string; referenceId?: string; strictFIFO?: boolean }, externalTx?: any) {
    const run = (tx: any) =>
      this.recordMovement(tx, {
        itemId: data.itemId,
        type: data.type ?? 'PRODUCTION_OUT',
        quantity: -data.quantity,
        transactionUnit: data.unit,
        note: data.note,
        userId: data.userId,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        strictFIFO: data.strictFIFO,
      });
    return externalTx ? run(externalTx) : prisma.$transaction(run);
  }

  // SUPER_ADMIN only: physical count adjustment
  static async adjustStock(data: { itemId: string; newQuantity: number; unit?: string; note?: string; userId?: string }) {
    return prisma.$transaction(async tx => {
      const computedStock = await this.computeStock(data.itemId, tx);
      const difference = data.newQuantity - computedStock;
      if (difference === 0) return { message: 'No change needed' };

      return this.recordMovement(tx, {
        itemId: data.itemId,
        type: StockMovementType.ADJUSTMENT,
        quantity: difference,
        transactionUnit: data.unit,
        referenceType: 'ADJUSTMENT',
        note: data.note || 'Physical count adjustment',
        userId: data.userId,
      });
    });
  }

  /**
   * Physical count sheet: system-computed stock per item, next to a blank
   * column the reviewer fills in during a stock count. Previously the only
   * reconciliation tool was adjusting one item at a time with no structured
   * "what should I even be counting" worksheet.
   */
  static async getReconciliationSheet(franchiseId: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId, isActive: true },
      orderBy: { name: 'asc' }
    });

    return Promise.all(
      items.map(async (item) => ({
        itemId: item.id,
        name: item.name,
        sku: item.sku,
        category: item.category,
        unit: item.unit,
        systemStock: await this.computeStock(item.id)
      }))
    );
  }

  /**
   * Apply a batch of physical counts from a filled-in reconciliation sheet.
   * Each line goes through the same ledger-safe adjustStock() used for a
   * single-item adjustment — this just lets a reviewer submit a whole sheet
   * at once instead of one item at a time.
   */
  static async submitReconciliation(
    entries: { itemId: string; physicalCount: number; note?: string }[],
    userId?: string
  ) {
    const results: { itemId: string; systemStockBefore: number; physicalCount: number; variance: number; result: any }[] = [];
    for (const entry of entries) {
      const before = await this.computeStock(entry.itemId);
      const result = await this.adjustStock({
        itemId: entry.itemId,
        newQuantity: entry.physicalCount,
        note: entry.note || 'Stock reconciliation count',
        userId
      });
      results.push({ itemId: entry.itemId, systemStockBefore: before, physicalCount: entry.physicalCount, variance: entry.physicalCount - before, result });
    }
    return results;
  }

  // Core engine: record movement and keep currentStock in sync as cache
  static async recordMovement(
    tx: any,
    data: {
      itemId: string;
      type: string;
      quantity: number;
      baseQty?: number;
      transactionUnit?: string;
      referenceType?: string;
      referenceId?: string;
      note?: string;
      userId?: string;
      warehouseId?: string;
      // Inbound-only: when set on a positive movement, a new InventoryBatch is
      // created at this cost (mirrors what GRN does for raw materials) instead
      // of just bumping currentStock, and the item's costPrice moving average
      // is updated the same way. Lets non-GRN inflows (e.g. finished goods
      // coming out of Production/QC) carry a real lot cost for FIFO to consume
      // later, instead of silently going untracked.
      receiveAtCost?: {
        unitCost: number;
        batchNumber?: string;
        lotNumber?: string;
        mfgDate?: Date | null;
        expDate?: Date | null;
        productBatchId?: string;
      };
      // Explicit passthrough for callers that already know the batch/cost
      // (e.g. an adjustment against a specific lot). Ignored when the FIFO
      // depletion or receiveAtCost branches below derive their own values.
      batchId?: string;
      unitCost?: number;
      strictFIFO?: boolean;
    }
  ): Promise<{ item: any; fifo?: FifoConsumptionResult }> {
    const itemBefore = await tx.inventoryItem.findUnique({ where: { id: data.itemId } });
    if (!itemBefore) throw new Error(`Inventory item ${data.itemId} not found`);

    let finalBaseQty = data.baseQty !== undefined && data.baseQty !== null ? data.baseQty : data.quantity;
    
    // Normalize transaction quantity to canonical stock units if units differ
    if (data.transactionUnit && itemBefore.unit && data.transactionUnit.toUpperCase() !== itemBefore.unit.toUpperCase() && data.transactionUnit !== 'UNIT') {
      try {
        const { convertMeasurement } = require('@businessgroupikasle/erp-units');
        finalBaseQty = convertMeasurement(data.quantity, data.transactionUnit.toUpperCase(), itemBefore.unit.toUpperCase()).toNumber();
      } catch (err: any) {
        throw new Error(`Unit conversion failed for "${itemBefore.name}": ${err.message}`);
      }
    }
    
    // Ensure baseQty is correctly saved in the DB so computeStock works accurately
    const stockChange = finalBaseQty;
    data.baseQty = finalBaseQty;

    const updatedItem = await tx.inventoryItem.update({
      where: { id: data.itemId },
      data: { currentStock: { increment: stockChange } },
    });

    // Every outbound movement (Production/POS/Packaging/etc.) deducts from the
    // oldest non-expired batch first. This used to not exist at all — batches
    // were only ever written at GRN time and never depleted by consumption, so
    // InventoryBatch.currentQty was disconnected from real stock movement. This
    // is best-effort: not all stock is batch-tracked (e.g. opening balances),
    // so it depletes whatever tracked batches exist and silently stops there.
    //
    // The batch/cost this movement resolves to is computed BEFORE the ledger
    // row is written so the row can carry a real Batch ID and unit cost
    // instead of the ledger having to re-derive history on every read.
    let fifo: FifoConsumptionResult | undefined;
    let movementBatchId: string | undefined = data.batchId;
    let movementUnitCost: number | undefined = data.unitCost;

    if (stockChange < 0) {
      fifo = await this.depleteBatchesFIFO(tx, data.itemId, Math.abs(stockChange), data.warehouseId);
      
      if (data.strictFIFO && fifo.consumedFromBatches < Math.abs(stockChange)) {
        throw new Error('Insufficient approved stock available for dispatch. Stock may be blocked or recalled.');
      }

      // Only unambiguous when everything came from a single lot — a
      // movement that spans multiple batches has no single Batch ID to
      // report, so it's left null rather than picking one arbitrarily.
      if (fifo.consumptions.length === 1) movementBatchId = fifo.consumptions[0].batchId;
      movementUnitCost = fifo.consumedFromBatches > 0 ? fifo.unitCost : (updatedItem.costPrice || 0);
    } else if (stockChange > 0 && data.receiveAtCost) {
      const priorStock = updatedItem.currentStock - stockChange;
      const priorQty = Math.max(0, priorStock);
      const priorCost = updatedItem.costPrice || 0;
      const newCostPrice = priorQty + stockChange > 0
        ? ((priorQty * priorCost) + (stockChange * data.receiveAtCost.unitCost)) / (priorQty + stockChange)
        : data.receiveAtCost.unitCost;

      const newBatch = await tx.inventoryBatch.create({
        data: {
          inventoryItemId: data.itemId,
          batchNumber: data.receiveAtCost.batchNumber || `B-${Date.now()}`,
          lotNumber: data.receiveAtCost.lotNumber,
          mfgDate: data.receiveAtCost.mfgDate,
          expDate: data.receiveAtCost.expDate,
          initialQty: stockChange,
          currentQty: stockChange,
          unitCost: data.receiveAtCost.unitCost,
          productBatchId: data.receiveAtCost.productBatchId,
          warehouseId: data.warehouseId || null,
          status: 'APPROVED',
        },
      });
      movementBatchId = newBatch.id;
      movementUnitCost = data.receiveAtCost.unitCost;

      await tx.inventoryItem.update({
        where: { id: data.itemId },
        data: { costPrice: newCostPrice },
      });
    } else if (movementUnitCost === undefined) {
      // No FIFO consumption and no fresh receipt (e.g. a plain ADJUSTMENT or
      // an opening balance) — fall back to the item's own moving-average
      // cost so the ledger still has a usable valuation figure.
      movementUnitCost = updatedItem.costPrice || 0;
    }

    await tx.stockMovement.create({
      data: {
        itemId: data.itemId,
        movementType: data.type as any,
        quantity: data.quantity,
        baseQty: data.baseQty,
        transactionUnit: data.transactionUnit,
        referenceType: data.referenceType,
        referenceId: data.referenceId,
        note: data.note,
        createdBy: data.userId,
        warehouseId: data.warehouseId ? (data.warehouseId.trim() || null) : null,
        batchId: movementBatchId || null,
        unitCost: movementUnitCost,
      },
    });

    return { item: updatedItem, fifo };
  }

  // Consumes the oldest non-expired batches first and reports exactly which
  // batches (and at what cost) covered the requested quantity, so callers can
  // persist the real lot cost instead of losing it once currentQty is decremented.
  // When warehouseId is given, only batches received into that warehouse (or
  // legacy batches with no warehouse on record, kept available everywhere so
  // pre-existing stock doesn't just disappear) are eligible — production in
  // warehouse A can't silently draw from stock that's physically in warehouse B.
  static async depleteBatchesFIFO(tx: any, itemId: string, quantity: number, warehouseId?: string): Promise<FifoConsumptionResult> {
    let remaining = quantity;
    const batches = await tx.inventoryBatch.findMany({
      where: {
        inventoryItemId: itemId,
        currentQty: { gt: 0 },
        status: 'APPROVED',
        AND: [
          { OR: [{ expDate: null }, { expDate: { gte: new Date() } }] },
          ...(warehouseId ? [{ OR: [{ warehouseId }, { warehouseId: null }] }] : [])
        ]
      },
      orderBy: [{ mfgDate: 'asc' }, { createdAt: 'asc' }]
    });

    let totalCost = 0;
    const consumptions: FifoConsumption[] = [];
    for (const batch of batches) {
      if (remaining <= 0) break;
      const consumeQty = Math.min(batch.currentQty, remaining);
      await tx.inventoryBatch.update({
        where: { id: batch.id },
        data: { currentQty: batch.currentQty - consumeQty }
      });
      const unitCost = batch.unitCost || 0;
      const lineCost = consumeQty * unitCost;
      totalCost += lineCost;
      remaining -= consumeQty;
      consumptions.push({
        batchId: batch.id,
        billNumber: batch.batchNumber,
        productBatchId: batch.productBatchId,
        qty: consumeQty,
        unitCost,
        totalCost: lineCost,
      });
    }

    const consumedFromBatches = quantity - remaining;
    return {
      consumptions,
      consumedFromBatches,
      totalCost,
      // Blended cost per unit across whatever batches were actually drawn from.
      // Untracked remainder (no batch left to draw from) is excluded — callers
      // that need a full-quantity cost should fall back to costPrice for it.
      unitCost: consumedFromBatches > 0 ? totalCost / consumedFromBatches : 0,
    };
  }

  // New helper for unit conversion engine
  static async convertUnitToBase(itemId: string, unitIdOrName: string, enteredQty: number, tx: any = prisma): Promise<{ requiredBaseQty: number; unitId?: string }> {
    const item = await tx.inventoryItem.findUnique({
      where: { id: itemId },
      include: { baseUnit: true, conversions: { include: { unit: true } } }
    });
    
    if (!item) throw new Error("Item not found");
    
    // If no unit requested, assume base quantity
    if (!unitIdOrName || unitIdOrName === "NONE" || unitIdOrName === item.unit) {
      return { requiredBaseQty: enteredQty };
    }
    
    // Look for conversion
    const conversion = item.conversions.find((c: any) => c.unitId === unitIdOrName || c.unit.name.toLowerCase() === unitIdOrName.toLowerCase() || c.unit.shortName.toLowerCase() === unitIdOrName.toLowerCase());
    
    if (conversion) {
      return { requiredBaseQty: enteredQty * conversion.multiplier, unitId: conversion.unit.id };
    }
    
    // If requested unit is explicitly the base unit
    if (item.baseUnit && (item.baseUnit.id === unitIdOrName || item.baseUnit.name.toLowerCase() === unitIdOrName.toLowerCase() || item.baseUnit.shortName.toLowerCase() === unitIdOrName.toLowerCase())) {
      return { requiredBaseQty: enteredQty, unitId: item.baseUnit.id };
    }
    
    // If no conversion found, fallback to 1:1 if unit strings match, else Error
    if (item.unit && item.unit.toLowerCase() === unitIdOrName.toLowerCase()) {
      return { requiredBaseQty: enteredQty };
    }
    
    throw new Error(`No unit conversion found for item ${item.name} to unit ${unitIdOrName}`);
  }

  static async getMovements(filters: any) {
    return prisma.stockMovement.findMany({
      where: filters,
      include: { item: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getAlerts(franchiseId?: string) {
    const items = await this.getInventory(franchiseId);
    return items.filter(item => {
      const threshold = item.minimumStock ?? 0;
      return item.currentStock <= threshold;
    });
  }

  // Storage lives at the warehouse level, not the franchise level — franchiseId
  // is only an optional extra filter (multi-tenant safety), never required.
  // When warehouseId is given, stock is scoped to that warehouse (matching
  // what a GRN actually tagged its received quantity with); otherwise it's
  // the item's total across every warehouse, same number Item Master shows.
  // category defaults to RAW_MATERIAL to preserve this endpoint's original
  // behavior for existing callers; pass 'ALL' to see every category instead.
  static async getRawMaterialStockSummary(warehouseId?: string, franchiseId?: string, category?: ItemCategory | 'ALL') {
    const items = await prisma.inventoryItem.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        isActive: true,
        ...(category === 'ALL' ? {} : { category: category || ItemCategory.RAW_MATERIAL })
      },
      orderBy: { name: 'asc' }
    });
    const itemIds = items.map(i => i.id);

    // Pulled once for every item instead of one computeWarehouseStock() call
    // per item per warehouse — same "which warehouse actually has this
    // stock" logic, just batched so the page stays fast with a real catalog.
    const [allMovements, allWarehouses, allFranchises] = await Promise.all([
      prisma.stockMovement.findMany({
        where: { itemId: { in: itemIds } },
        select: { itemId: true, quantity: true, baseQty: true, warehouseId: true }
      }),
      warehouseId ? Promise.resolve([]) : prisma.warehouse.findMany({ select: { id: true, name: true } }),
      prisma.franchise.findMany({ select: { id: true, primaryWarehouseId: true } })
    ]);
    const primaryWarehouseByFranchise = new Map(allFranchises.map(f => [f.id, f.primaryWarehouseId]));
    const movementsByItem = new Map<string, typeof allMovements>();
    for (const m of allMovements) {
      if (!movementsByItem.has(m.itemId)) movementsByItem.set(m.itemId, []);
      movementsByItem.get(m.itemId)!.push(m);
    }

    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const summary = await Promise.all(items.map(async item => {
      const itemMovements = movementsByItem.get(item.id) || [];
      const primaryWarehouseId = item.franchiseId ? primaryWarehouseByFranchise.get(item.franchiseId) : undefined;
      const sumFor = (targetWarehouseId?: string) => itemMovements.reduce((acc, m) => {
        if (targetWarehouseId) {
          const effectiveWarehouseId = m.warehouseId || primaryWarehouseId;
          if (effectiveWarehouseId !== targetWarehouseId) return acc;
        }
        return acc + (m.baseQty !== null ? m.baseQty : m.quantity);
      }, 0);

      const availableStock = sumFor(warehouseId);

      // Only computed for the "all warehouses" view — tells you exactly
      // which warehouse(s) this item's stock is actually sitting in, instead
      // of having to flip through every warehouse filter to find it.
      const warehouseBreakdown = warehouseId
        ? undefined
        : allWarehouses
            .map(w => ({ warehouseId: w.id, warehouseName: w.name, qty: sumFor(w.id) }))
            .filter(b => Math.abs(b.qty) > 0.001);

      const reserved = await prisma.productionItem.aggregate({
        where: {
          inventoryItemId: item.id,
          production: {
            status: { in: ['PENDING', 'IN_PROGRESS'] }
          }
        },
        _sum: { usedQuantity: true }
      });
      const reservedStock = reserved._sum.usedQuantity || 0;

      const nearExpiry = await prisma.inventoryBatch.aggregate({
        where: {
          inventoryItemId: item.id,
          expDate: {
            gte: new Date(),
            lte: thirtyDaysFromNow
          },
          currentQty: { gt: 0 }
        },
        _sum: { currentQty: true }
      });
      const nearExpiryStock = nearExpiry._sum.currentQty || 0;

      const damaged = await prisma.stockMovement.aggregate({
        where: {
          itemId: item.id,
          movementType: 'WASTE_OUT',
          OR: [
            { note: { contains: 'damage', mode: 'insensitive' } },
            { note: 'WASTE_DAMAGED' }
          ]
        },
        _sum: { quantity: true }
      });
      const damagedStock = Math.abs(damaged._sum.quantity || 0);

      return {
        id: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        minimumStock: item.minimumStock,
        costPrice: item.costPrice || 0,
        availableStock,
        reservedStock,
        nearExpiryStock,
        damagedStock,
        warehouseBreakdown
      };
    }));

    return summary;
  }

  // Scoped by warehouse (where the material actually left from), not
  // franchise. franchiseId is kept as an optional secondary filter only.
  // Same 'ALL' opt-out convention as getRawMaterialStockSummary above.
  static async getRawMaterialConsumption(
    warehouseId?: string,
    franchiseId?: string,
    category?: ItemCategory | 'ALL',
    startDate?: string,
    endDate?: string
  ) {
    const createdAtFilter: any = {};
    if (startDate) createdAtFilter.gte = new Date(startDate.includes('T') ? startDate : `${startDate}T00:00:00.000`);
    if (endDate) createdAtFilter.lte = new Date(endDate.includes('T') ? endDate : `${endDate}T23:59:59.999`);

    const movements = await prisma.stockMovement.findMany({
      where: {
        item: {
          ...(franchiseId ? { franchiseId } : {}),
          ...(category === 'ALL' ? {} : { category: category || ItemCategory.RAW_MATERIAL })
        },
        quantity: { lt: 0 },
        ...(warehouseId ? { OR: [{ warehouseId }, { warehouseId: null }] } : {}),
        ...(startDate || endDate ? { createdAt: createdAtFilter } : {})
      },
      include: {
        item: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return movements.map(m => {
      let consumptionType = 'Production Consumption';
      if (m.movementType === 'WASTE_OUT' && m.note?.toLowerCase().includes('expire')) {
        consumptionType = 'Expiry';
      } else if (m.movementType === 'WASTE_OUT' && (m.note?.toLowerCase().includes('damage') || m.note === 'WASTE_DAMAGED')) {
        consumptionType = 'Damage';
      }

      const qty = Math.abs(m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity);
      const value = qty * (m.item.costPrice || 0);

      return {
        id: m.id,
        date: m.createdAt,
        itemName: m.item.name,
        sku: m.item.sku,
        unit: m.item.unit,
        quantity: qty,
        consumptionType,
        value,
        notes: m.note || ''
      };
    });
  }

  // Chronological stock ledger across every item category (Raw Material,
  // Packaging, Semi-Finished, Finished Good) — previously hardcoded to
  // RAW_MATERIAL only, which meant finished-goods stock movements (e.g. QC
  // acceptance into inventory) never showed up here. `category` is now an
  // optional narrowing filter, not a fixed scope.
  static async getInventoryLedger(franchiseId: string | undefined, itemId?: string, category?: ItemCategory) {
    const movements = await prisma.stockMovement.findMany({
      where: {
        item: {
          franchiseId,
          ...(category ? { category } : {}),
          ...(itemId ? { id: itemId } : {})
        }
      },
      include: {
        item: true,
        warehouse: { select: { id: true, name: true } },
        batch: { select: { id: true, batchNumber: true, lotNumber: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Resolve createdBy (a raw User.id) to a display name, and referenceId to
    // a human document number, in a handful of batched lookups instead of
    // showing the stored UUIDs directly — this is purely a read-time
    // presentation step and doesn't touch what recordMovement() writes.
    const userIds = Array.from(new Set(
      movements.map(m => m.createdBy).filter((id): id is string => !!id && id.toLowerCase() !== 'system')
    ));
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } })
      : [];
    const userNameById = new Map(users.map(u => [u.id, u.fullName]));

    const grnIds = Array.from(new Set(
      movements.filter(m => m.referenceType === 'GRN').map(m => m.referenceId).filter((id): id is string => !!id)
    ));
    const grns = grnIds.length
      ? await prisma.goodsReceipt.findMany({ where: { id: { in: grnIds } }, select: { id: true, procurementOrder: { select: { poNumber: true } } } })
      : [];
    const poNumberByGrnId = new Map(grns.map(g => [g.id, g.procurementOrder?.poNumber]));

    const franchiseOrderIds = Array.from(new Set(
      movements.filter(m => m.referenceType === 'FRANCHISE_ORDER').map(m => m.referenceId).filter((id): id is string => !!id)
    ));
    const franchiseOrders = franchiseOrderIds.length
      ? await prisma.franchiseOrder.findMany({ where: { id: { in: franchiseOrderIds } }, select: { id: true, orderNumber: true } })
      : [];
    const orderNumberById = new Map(franchiseOrders.map(o => [o.id, o.orderNumber]));

    const returnIds = Array.from(new Set(
      movements.filter(m => m.referenceType === 'PURCHASE_RETURN' || m.referenceType === 'RETURN').map(m => m.referenceId).filter((id): id is string => !!id)
    ));
    const returns = returnIds.length
      ? await prisma.purchaseReturn.findMany({ where: { id: { in: returnIds } }, select: { id: true, returnNumber: true } })
      : [];
    const returnNumberById = new Map(returns.map(r => [r.id, r.returnNumber]));

    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const runningBalances = new Map<string, number>();
    const ledger = movements.map(m => {
      const qty = m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity;
      const currentBal = runningBalances.get(m.itemId) || 0;
      const newBal = currentBal + qty;
      runningBalances.set(m.itemId, newBal);

      let transactionType = 'Other';
      if (m.movementType === 'PURCHASE_IN') transactionType = 'GRN Inward';
      else if (m.movementType === 'PRODUCTION_OUT') transactionType = 'Production Outward';
      else if (m.movementType === 'PRODUCTION_IN') transactionType = 'Production Inward (QC Approved)';
      else if (m.movementType === 'WASTE_OUT') {
        if (m.note?.toLowerCase().includes('expire')) transactionType = 'Expiry Outward';
        else if (m.note?.toLowerCase().includes('damage')) transactionType = 'Damage Outward';
        else transactionType = 'Waste Disposal';
      }
      else if (m.movementType === 'ADJUSTMENT') transactionType = 'Stock Adjustment';
      else if (m.movementType === 'TRANSFER_IN') transactionType = 'Stock Transfer In';
      else if (m.movementType === 'TRANSFER_OUT') transactionType = 'Stock Transfer Out';
      else if (m.movementType === 'SALES_OUT') transactionType = 'Sales Outward';
      else if (m.movementType === 'RETURN_OUT') transactionType = 'Purchase Return Outward';

      // Operator: resolve createdBy to a name; a bare "system" sentinel or a
      // missing value both mean an automatic transaction, never "unknown".
      const actor = !m.createdBy || m.createdBy.toLowerCase() === 'system'
        ? 'System'
        : (userNameById.get(m.createdBy) || 'Unknown User');

      // Reference: a short human document number instead of the raw
      // referenceId UUID. GRN/franchise-order/return resolve to their real
      // business number; PRODUCTION and PACKAGING don't have one on the
      // Production record itself, so a deterministic PRD-/PKG- short code is
      // derived the same way ProductionService already derives ProductBatch
      // codes (`BATCH-${id.slice(0,8)}`) — display-only, never stored.
      let reference = '';
      if (m.referenceType === 'GRN' && m.referenceId) {
        reference = poNumberByGrnId.get(m.referenceId) || '';
      } else if (m.referenceType === 'FRANCHISE_ORDER' && m.referenceId) {
        reference = orderNumberById.get(m.referenceId) || '';
      } else if ((m.referenceType === 'PURCHASE_RETURN' || m.referenceType === 'RETURN') && m.referenceId) {
        reference = returnNumberById.get(m.referenceId) || '';
      } else if (m.referenceType === 'PRODUCTION' && m.referenceId) {
        reference = `PRD-${m.referenceId.substring(0, 8).toUpperCase()}`;
      } else if (m.referenceType === 'PACKAGING' && m.referenceId) {
        reference = `PKG-${m.referenceId.substring(0, 8).toUpperCase()}`;
      }
      if (!reference && m.batch?.batchNumber) reference = m.batch.batchNumber;
      if (!reference && m.referenceType) reference = m.referenceType.replace(/_/g, ' ');

      // Description: the stored note, but with any raw UUID it happens to
      // embed (older GRN notes wrote "via GRN <uuid>" directly) swapped for
      // the same resolved reference — the note text itself is never rewritten.
      const description = m.note && uuidPattern.test(m.note) && reference
        ? m.note.replace(uuidPattern, reference)
        : (m.note || '');

      return {
        id: m.id,
        date: m.createdAt,
        itemId: m.itemId,
        itemName: m.item.name,
        sku: m.item.sku,
        category: m.item.category,
        unit: m.item.unit,
        transactionType,
        inwardQty: qty > 0 ? qty : 0,
        outwardQty: qty < 0 ? Math.abs(qty) : 0,
        runningBalance: newBal,
        batchId: m.batchId || null,
        batchNumber: m.batch?.batchNumber || null,
        warehouseId: m.warehouseId || null,
        warehouseName: m.warehouse?.name || null,
        unitCost: m.unitCost ?? 0,
        totalValue: Math.abs(qty) * (m.unitCost ?? 0),
        referenceId: m.referenceId || '',
        referenceType: m.referenceType || '',
        reference,
        notes: description,
        actor
      };
    });

    return ledger.reverse();
  }

  // Kept as a thin, backward-compatible alias — existing callers that only
  // ever wanted Raw Material rows still get exactly that.
  static async getRawMaterialLedger(franchiseId: string, itemId?: string) {
    return this.getInventoryLedger(franchiseId, itemId, ItemCategory.RAW_MATERIAL);
  }
}

