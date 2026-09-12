import { Prisma, PrismaClient } from '@prisma/client';

export class InventoryReservationService {

  /**
   * Creates an inventory reservation for a given FranchiseOrder, locking the specific FIFO layers.
   */
  static async reserveStock(
    tx: any,
    franchiseOrderId: string,
    items: { productId: string, inventoryItemId: string, quantity: number }[],
    warehouseId?: string
  ) {
    // 1. Create the reservation header
    const reservation = await tx.inventoryReservation.create({
      data: {
        franchiseOrderId,
        status: 'ACTIVE',
      }
    });

    // 2. Allocate FIFO layers for each item
    for (const item of items) {
      if (item.quantity <= 0) continue;

      let remaining = item.quantity;
      const warehouseFilter = warehouseId
        ? Prisma.sql`AND ("warehouseId" = ${warehouseId} OR "warehouseId" IS NULL)`
        : Prisma.sql``;

      // Lock eligible batches and calculate available quantity dynamically.
      // We lock the InventoryBatch row so concurrent reservations on the same batch serialize.
      const batches: Array<{
        id: string;
        currentQty: number;
        reservedQty: number;
        unitCost: number;
      }> = await tx.$queryRaw(Prisma.sql`
        SELECT 
          id, 
          "currentQty", 
          "unitCost",
          (
            SELECT COALESCE(SUM("reservedQty" - "consumedQty" - "releasedQty"), 0) 
            FROM "InventoryReservationAllocation" 
            WHERE "inventoryBatchId" = "InventoryBatch".id
          ) AS "reservedQty"
        FROM "InventoryBatch"
        WHERE "inventoryItemId" = ${item.inventoryItemId}
          AND status = 'APPROVED'
          AND NOT EXISTS (
            SELECT 1 FROM "BatchRecall" br
            WHERE br."productBatchId" = "InventoryBatch"."productBatchId"
              AND br.status IN ('IN_PROGRESS', 'COMPLETED')
          )
          AND ("expDate" IS NULL OR "expDate" >= now())
          ${warehouseFilter}
        ORDER BY "mfgDate" ASC, "createdAt" ASC
        FOR UPDATE
      `);

      for (const batch of batches) {
        if (remaining <= 0) break;
        
        // Convert to Number as Postgres SUM may return string
        const reserved = Number(batch.reservedQty) || 0;
        const availableQty = batch.currentQty - reserved;
        if (availableQty <= 0) continue;

        const allocateQty = Math.min(availableQty, remaining);
        
        await tx.inventoryReservationAllocation.create({
          data: {
            reservationId: reservation.id,
            inventoryBatchId: batch.id,
            inventoryItemId: item.inventoryItemId,
            reservedQty: allocateQty,
          }
        });

        remaining -= allocateQty;
      }

      if (remaining > 0.0001) {
        throw new Error(`Insufficient available stock to reserve ${item.quantity} units for item ${item.inventoryItemId}. Shortfall: ${remaining}`);
      }
    }

    return reservation;
  }

  /**
   * Consumes a reservation (e.g. upon dispatch), deducting the exact physical stock 
   * from the allocated InventoryBatch records.
   */
  static async consumeReservation(
    tx: any,
    franchiseOrderId: string
  ) {
    const reservation = await tx.inventoryReservation.findUnique({
      where: { franchiseOrderId },
      include: { allocations: { include: { inventoryBatch: true } } }
    });

    if (!reservation || reservation.status !== 'ACTIVE') {
      throw new Error('No active reservation found for this order.');
    }

    // Group consumed allocations by inventoryItemId
    const resultByItem = new Map<string, {
      consumedFromBatches: number;
      consumptions: any[]; // FifoConsumption[]
      totalCost: number;
    }>();

    // Process each allocation
    for (const alloc of reservation.allocations) {
      const activeQty = alloc.reservedQty - alloc.consumedQty - alloc.releasedQty;
      if (activeQty <= 0) continue;

      if (alloc.inventoryBatch.productBatchId) {
        const recall = await tx.batchRecall.findUnique({
          where: { productBatchId: alloc.inventoryBatch.productBatchId }
        });
        if (recall && ['IN_PROGRESS', 'COMPLETED'].includes(recall.status)) {
          throw new Error(`Cannot dispatch order: Reserved batch ${alloc.inventoryBatch.batchNumber} has been recalled.`);
        }
      }

      // Deduct physical stock from the batch
      // (This must NOT fail since it was already locked during reserveStock)
      await tx.inventoryBatch.update({
        where: { id: alloc.inventoryBatchId },
        data: {
          currentQty: { decrement: activeQty }
        }
      });

      // Mark allocation as consumed
      await tx.inventoryReservationAllocation.update({
        where: { id: alloc.id },
        data: {
          consumedQty: { increment: activeQty }
        }
      });
      
      const batchCost = alloc.inventoryBatch.unitCost || 0;

      if (!resultByItem.has(alloc.inventoryItemId)) {
        resultByItem.set(alloc.inventoryItemId, { consumedFromBatches: 0, consumptions: [], totalCost: 0 });
      }
      
      const itemGroup = resultByItem.get(alloc.inventoryItemId)!;
      itemGroup.consumedFromBatches += activeQty;
      itemGroup.totalCost += activeQty * batchCost;
      itemGroup.consumptions.push({
        batchId: alloc.inventoryBatchId,
        billNumber: alloc.inventoryBatch.billNumber || alloc.inventoryBatch.batchNumber,
        qty: activeQty,
        unitCost: batchCost
      });
    }

    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: 'CONSUMED' }
    });
    
    // Format into FifoConsumptionResult
    const finalResult = new Map<string, any>(); // Map<string, FifoConsumptionResult>
    for (const [itemId, group] of resultByItem.entries()) {
      finalResult.set(itemId, {
        consumedFromBatches: group.consumedFromBatches,
        blockedQtyAvailable: 0, // Not applicable here
        consumptions: group.consumptions,
        unitCost: group.consumedFromBatches > 0 ? group.totalCost / group.consumedFromBatches : 0
      });
    }

    return finalResult;
  }

  /**
   * Releases a reservation (e.g. upon cancellation).
   */
  static async releaseReservation(
    tx: any,
    franchiseOrderId: string
  ) {
    const reservation = await tx.inventoryReservation.findUnique({
      where: { franchiseOrderId },
      include: { allocations: true }
    });

    if (!reservation) return; // Nothing to release
    if (reservation.status !== 'ACTIVE') return; 

    for (const alloc of reservation.allocations) {
      const activeQty = alloc.reservedQty - alloc.consumedQty - alloc.releasedQty;
      if (activeQty <= 0) continue;

      await tx.inventoryReservationAllocation.update({
        where: { id: alloc.id },
        data: {
          releasedQty: { increment: activeQty }
        }
      });
    }

    await tx.inventoryReservation.update({
      where: { id: reservation.id },
      data: { 
        status: 'RELEASED',
        releasedAt: new Date()
      }
    });
  }
}
