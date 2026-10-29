import { InventoryService, FifoConsumptionResult } from './inventory.service';
import { expiryCutoff, isLotExpired } from './lot-eligibility';

/** Packaging consumes only the selected ProductBatch's physical lots, never another batch's FIFO pool. */
export async function consumeBulkSource(tx: any, batch: any, itemId: string, quantity: number, lotId?: string): Promise<FifoConsumptionResult> {
  if (isLotExpired(batch.expiryDate)) throw new Error('This bulk batch has expired and cannot be packaged.');
  const warehouseId = batch.warehouseId || batch.production?.warehouseId;
  const lots = await tx.inventoryBatch.findMany({
    where: { inventoryItemId: itemId, productBatchId: batch.id, productPackagingId: null,
      ...(lotId ? { id: lotId } : {}), currentQty: { gt: 0 }, status: 'APPROVED',
      AND: [{ OR: [{ expDate: null }, { expDate: { gte: expiryCutoff() } }] },
        ...(warehouseId ? [{ OR: [{ warehouseId }, { warehouseId: null }] }] : [])] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const reserved = await InventoryService.reservedQtyByLot(tx, lots.map((l: any) => l.id));
  const available = lots.reduce((sum: number, l: any) => sum + Math.max(0, l.currentQty - (reserved.get(l.id) || 0)), 0);
  if (!(quantity > 0) || available + 0.0001 < quantity) throw new Error('Selected bulk lot has insufficient available stock. Refresh Packaging and check the source lot.');
  let remaining = quantity;
  const result: FifoConsumptionResult = { consumptions: [], consumedFromBatches: 0, totalCost: 0, unitCost: 0, blockedQtyAvailable: 0 };
  for (const lot of lots) {
    const take = Math.min(remaining, Math.max(0, lot.currentQty - (reserved.get(lot.id) || 0)));
    if (take <= 0.0000001) continue;
    const issued = await InventoryService.depleteLot(tx, itemId, lot.id, take);
    result.consumptions.push(...issued.consumptions);
    result.totalCost += issued.totalCost;
    result.consumedFromBatches += issued.consumedFromBatches;
    remaining -= take;
    if (remaining <= 0.0000001) break;
  }
  result.unitCost = result.totalCost / quantity;
  return result;
}
