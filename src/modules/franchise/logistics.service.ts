import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { StockTransferStatus, StockMovementType } from '@prisma/client';

export class LogisticsService {
  /**
   * Create a new stock transfer request between two branches
   */
  static async createTransfer(data: {
    fromBranchId: string;
    toBranchId: string;
    items: { inventoryItemId: string; quantity: number }[];
    initiatedBy: string;
  }) {
    return prisma.stockTransfer.create({
      data: {
        fromBranchId: data.fromBranchId,
        toBranchId: data.toBranchId,
        initiatedBy: data.initiatedBy,
        items: {
          create: data.items.map(item => ({
            inventoryItemId: item.inventoryItemId,
            quantity: item.quantity
          }))
        }
      },
      include: { items: true }
    });
  }

  /**
   * Update transfer status and handle inventory impacts
   */
  static async updateTransferStatus(transferId: string, status: StockTransferStatus, userId: string) {
    const transfer = await prisma.stockTransfer.findUnique({
      where: { id: transferId },
      include: { items: { include: { inventoryItem: true } } }
    });

    if (!transfer) throw new Error('Transfer not found');

    // 1. Logic for SHIPPED: Deduct from Source
    if (status === 'SHIPPED' && transfer.status !== 'SHIPPED') {
      await prisma.$transaction(async (tx) => {
        for (const item of transfer.items) {
          // We need to find the equivalent item in the Source Branch if IDs aren't global
          // Assuming inventoryItemId represents a specific item instance in a branch
          await InventoryService.stockOut({
            itemId: item.inventoryItemId,
            quantity: item.quantity,
            type: StockMovementType.TRANSFER_OUT,
            note: `Transfer to Branch ${transfer.toBranchId}`,
            userId
          }, tx);
        }
        await tx.stockTransfer.update({
          where: { id: transferId },
          data: { status, approvedBy: userId }
        });
      });
    }

    // 2. Logic for COMPLETED: Add to Destination
    if (status === 'COMPLETED' && transfer.status === 'SHIPPED') {
      await prisma.$transaction(async (tx) => {
        for (const item of transfer.items) {
            // Find or Upsert equivalent item in Target Branch
            const sourceItem = item.inventoryItem;
            let targetItem = await tx.inventoryItem.findFirst({
                where: { sku: sourceItem.sku, franchiseId: transfer.toBranchId }
            });

            if (!targetItem) {
                targetItem = await tx.inventoryItem.create({
                    data: {
                        name: sourceItem.name,
                        sku: sourceItem.sku,
                        unit: sourceItem.unit,
                        category: sourceItem.category,
                        franchiseId: transfer.toBranchId,
                        currentStock: 0,
                        minimumStock: sourceItem.minimumStock
                    }
                });
            }

            await InventoryService.stockIn({
                itemId: targetItem.id,
                quantity: item.quantity,
                type: StockMovementType.TRANSFER_IN,
                note: `Received from Branch ${transfer.fromBranchId}`,
                userId
            }, tx);
        }
        await tx.stockTransfer.update({
          where: { id: transferId },
          data: { status }
        });
      });
    }

    // Default status update if no inventory logic needed (e.g., Cancelled)
    if (status === 'CANCELLED' || status === 'REJECTED' as any) {
         return prisma.stockTransfer.update({
            where: { id: transferId },
            data: { status }
          });
    }

    return prisma.stockTransfer.findUnique({ where: { id: transferId }, include: { items: true } });
  }

  /**
   * Convert a Stock Request into a Fulfilling Transfer
   */
  static async fulfillRequest(requestId: string, fromBranchId: string, userId: string) {
    const request = await prisma.stockRequest.findUnique({
      where: { id: requestId },
      include: { items: true }
    });

    if (!request) throw new Error('Stock Request not found');

    const transfer = await this.createTransfer({
      fromBranchId,
      toBranchId: request.franchiseId,
      items: request.items.map(i => ({
        inventoryItemId: i.inventoryItemId,
        quantity: i.requestedQty
      })),
      initiatedBy: userId
    });

    await prisma.stockRequest.update({
      where: { id: requestId },
      data: { status: 'COMPLETED', approvedBy: userId, approvedAt: new Date() }
    });

    return transfer;
  }
}
