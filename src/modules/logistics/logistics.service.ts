import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';

export class LogisticsService {
  /**
   * --- FRANCHISE STOCK REQUESTS ---
   */
  static async createRequest(data: {
    franchiseId: string,
    items: { inventoryItemId: string, requestedQty: number }[],
    userId?: string
  }) {
    return prisma.stockRequest.create({
      data: {
        franchiseId: data.franchiseId,
        requestedBy: data.userId,
        items: {
          create: data.items.map(item => ({
            inventoryItemId: item.inventoryItemId,
            requestedQty: item.requestedQty
          }))
        }
      },
      include: { items: { include: { inventoryItem: true } } }
    });
  }

  static async approveRequest(id: string, approvedItems: { itemId: string, approvedQty: number }[], userId: string) {
    return prisma.$transaction(async (tx) => {
      // 1. Update request status
      const request = await tx.stockRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedBy: userId,
          approvedAt: new Date()
        },
        include: { franchise: true, items: true }
      });

      // 2. Update approved quantities for each item
      for (const item of approvedItems) {
        await tx.stockRequestItem.updateMany({
          where: { stockRequestId: id, inventoryItemId: item.itemId },
          data: { approvedQty: item.approvedQty }
        });
      }

      // 3. Optional: Automatically initiate a Stock Transfer from HQ (root-franchise)
      // For this workflow, we'll keep it manual or auto-initiate a transfer
      return request;
    });
  }

  /**
   * --- INTER-FRANCHISE STOCK TRANSFERS ---
   */
  static async initiateTransfer(data: {
    fromBranchId: string,
    toBranchId: string,
    items: { inventoryItemId: string, quantity: number }[],
    userId?: string
  }) {
    return prisma.$transaction(async (tx) => {
      // 1. Create Transfer Record
      const transfer = await tx.stockTransfer.create({
        data: {
          fromBranchId: data.fromBranchId,
          toBranchId: data.toBranchId,
          initiatedBy: data.userId,
          status: 'PENDING',
          items: {
            create: data.items.map(item => ({
              inventoryItemId: item.inventoryItemId,
              quantity: item.quantity
            }))
          }
        },
        include: { items: true }
      });

      // 2. Deduct from Source Branch (TRANSFER_OUT)
      for (const item of data.items) {
        // Validate source stock
        const sourceInv = await tx.inventoryItem.findFirst({
          where: { id: item.inventoryItemId, franchiseId: data.fromBranchId }
        });

        if (!sourceInv || sourceInv.currentStock < item.quantity) {
          throw new Error(`Insufficient stock in source branch for ${sourceInv?.name}. Available: ${sourceInv?.currentStock || 0}`);
        }

        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'TRANSFER_OUT',
          quantity: -item.quantity,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          note: `Transfer to branch ${data.toBranchId}`,
          userId: data.userId
        });
      }

      return transfer;
    });
  }

  static async completeTransfer(id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      // 1. Get Transfer Details
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: { items: { include: { inventoryItem: true } } }
      });

      if (!transfer || transfer.status === 'COMPLETED') throw new Error('Invalid transfer or already completed');

      // 2. Add to Destination Branch (TRANSFER_IN)
      for (const item of transfer.items) {
        // Find existing item in destination branch, or create it if not present
        let destInv = await tx.inventoryItem.findFirst({
          where: { sku: item.inventoryItem.sku, franchiseId: transfer.toBranchId }
        });

        if (!destInv) {
          // If destination doesn't have this item, create it
          destInv = await tx.inventoryItem.create({
            data: {
              name: item.inventoryItem.name,
              sku: item.inventoryItem.sku,
              category: item.inventoryItem.category,
              unit: item.inventoryItem.unit,
              currentStock: 0,
              franchiseId: transfer.toBranchId
            }
          });
        }

        await InventoryService.recordMovement(tx, {
          itemId: destInv.id,
          type: 'TRANSFER_IN',
          quantity: item.quantity,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          note: `Received from branch ${transfer.fromBranchId}`,
          userId: userId
        });
      }

      // 3. Update Status
      return tx.stockTransfer.update({
        where: { id },
        data: { status: 'COMPLETED', approvedBy: userId }
      });
    });
  }

  static async getRequests(franchiseId?: string) {
    return prisma.stockRequest.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: { franchise: true, items: { include: { inventoryItem: true } } },
      orderBy: { requestedAt: 'desc' }
    });
  }

  static async getTransfers(franchiseId?: string) {
    return prisma.stockTransfer.findMany({
      where: franchiseId ? {
        OR: [
          { fromBranchId: franchiseId },
          { toBranchId: franchiseId }
        ]
      } : {},
      include: { fromBranch: true, toBranch: true, items: { include: { inventoryItem: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }
}
