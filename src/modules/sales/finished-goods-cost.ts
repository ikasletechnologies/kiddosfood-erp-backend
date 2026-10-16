import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { expiryCutoff } from '../inventory/lot-eligibility';

/**
 * Estimated cost of issuing finished goods, under the EXISTING issue policy
 * (InventoryService.recordMovement → depleteBatchesFIFO): approved,
 * unexpired lots oldest first (mfgDate, then createdAt), and any quantity
 * beyond tracked lots at the item's moving-average costPrice — exactly what
 * a sale would post. Read-only: nothing is locked, reserved or deducted.
 *
 * It is an estimate: the actual cost is fixed when stock is really issued
 * (POS checkout / invoice), from the lots consumed at that moment.
 */

export interface CostLayer { batchId: string | null; batchNumber: string | null; productBatchId: string | null; qty: number; unitCost: number }

export interface IssueCostEstimate {
  status: 'AVAILABLE' | 'UNAVAILABLE';
  /** Cost per sold unit (in the unit sold), when known. */
  unitCost: number | null;
  totalCost: number | null;
  baseQty: number;
  layers: CostLayer[];
  reason?: string;
}

const unavailable = (baseQty: number, reason: string, layers: CostLayer[] = []): IssueCostEstimate =>
  ({ status: 'UNAVAILABLE', unitCost: null, totalCost: null, baseQty, layers, reason });

export async function estimateIssueCost(
  params: { inventoryItemId: string; quantity: number; unit?: string | null; warehouseId?: string },
  db: any = prisma,
): Promise<IssueCostEstimate> {
  const quantity = Number(params.quantity) || 0;
  if (quantity <= 0) return unavailable(0, 'No quantity');
  const item = await db.inventoryItem.findUnique({ where: { id: params.inventoryItemId }, select: { id: true, costPrice: true } });
  if (!item) return unavailable(0, 'Stock item not found');

  let baseQty = quantity;
  try {
    baseQty = (await InventoryService.convertUnitToBase(item.id, params.unit || 'NONE', quantity, db)).requiredBaseQty;
  } catch {
    return unavailable(0, `Unit ${params.unit} can't be converted to the stock unit`);
  }

  const lots: Array<{ id: string; batchNumber: string | null; productBatchId: string | null; currentQty: number; unitCost: number | null }> =
    await db.inventoryBatch.findMany({
      where: {
        inventoryItemId: item.id,
        currentQty: { gt: 0 },
        status: 'APPROVED',
        OR: [{ expDate: null }, { expDate: { gte: expiryCutoff() } }],
        ...(params.warehouseId ? { AND: [{ OR: [{ warehouseId: params.warehouseId }, { warehouseId: null }] }] } : {}),
      },
      orderBy: [{ mfgDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, batchNumber: true, productBatchId: true, currentQty: true, unitCost: true },
    });

  const layers: CostLayer[] = [];
  let remaining = baseQty;
  let total = 0;
  for (const lot of lots) {
    if (remaining <= 1e-9) break;
    const take = Math.min(lot.currentQty, remaining);
    // A lot with no recorded cost can't be valued — don't treat it as free.
    if (lot.unitCost == null || !(lot.unitCost > 0)) return unavailable(baseQty, `Lot ${lot.batchNumber || lot.id} has no recorded cost`, layers);
    layers.push({ batchId: lot.id, batchNumber: lot.batchNumber, productBatchId: lot.productBatchId, qty: take, unitCost: lot.unitCost });
    total += take * lot.unitCost;
    remaining -= take;
  }
  if (remaining > 1e-9) {
    // Same fallback a real issue uses for stock outside tracked lots.
    if (item.costPrice == null || !(item.costPrice > 0)) {
      return unavailable(baseQty, layers.length ? 'Part of the quantity has no costed lot' : 'No production cost recorded for this item', layers);
    }
    layers.push({ batchId: null, batchNumber: null, productBatchId: null, qty: remaining, unitCost: item.costPrice });
    total += remaining * item.costPrice;
  }
  return { status: 'AVAILABLE', unitCost: total / quantity, totalCost: total, baseQty, layers };
}

/** The stock item a product sells from, resolved the same way POS checkout and sales pricing do. */
export async function stockItemForProduct(productId: string, scopeFranchiseId: string | null, db: any = prisma) {
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true, sku: true, name: true } });
  if (product) {
    return product.sku
      ? db.inventoryItem.findFirst({ where: { sku: product.sku, franchiseId: scopeFranchiseId } })
      : db.inventoryItem.findFirst({ where: { name: { equals: product.name, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });
  }
  // Sales documents may carry an InventoryItem id directly (see resolveItemChannelPricing).
  return db.inventoryItem.findUnique({ where: { id: productId } });
}
