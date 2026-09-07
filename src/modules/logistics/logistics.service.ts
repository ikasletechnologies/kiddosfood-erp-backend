import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { TokenPayload } from '../../lib/jwt.util';
import { IsolationUtil } from '../../utils/isolation.util';

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
   *
   * Lifecycle: PENDING (created, no stock moved) -> SHIPPED (dispatched,
   * source deducted) -> COMPLETED (received, destination credited). Stock
   * only ever moves at dispatch/receipt, never at creation, so a transfer
   * can be raised as a plan/request without committing real stock until
   * someone actually sends it.
   */
  static async initiateTransfer(data: {
    fromBranchId: string,
    toBranchId: string,
    items: { inventoryItemId: string, quantity: number }[],
    userId?: string,
    requestingUser?: TokenPayload
  }) {
    // A FRANCHISE_ADMIN can only raise a transfer sourced from their own
    // branch — they can't drain another branch's stock. HQ (SUPER_ADMIN)
    // may source from anywhere. Destination is left open either way: a
    // branch sending stock elsewhere doesn't expose/alter anyone else's data.
    if (data.requestingUser) {
      const enforcedFromBranchId = await IsolationUtil.enforceFranchiseMatch(data.requestingUser, data.fromBranchId);
      if (!enforcedFromBranchId) {
        throw new Error('Your account has no branch assigned — cannot determine a source branch for this transfer.');
      }
      data.fromBranchId = enforcedFromBranchId;
    }

    if (data.fromBranchId === data.toBranchId) {
      throw new Error('Source and destination branch must be different.');
    }
    if (!data.items || data.items.length === 0) {
      throw new Error('At least one item is required.');
    }
    for (const item of data.items) {
      if (!(item.quantity > 0)) {
        throw new Error('Quantity must be greater than 0 for every item.');
      }
    }

    return prisma.$transaction(async (tx) => {
      // Soft availability check only — no stock is deducted here. Actual
      // stock can still move between now and dispatch, so this is early
      // user feedback, not the authoritative check (that happens at dispatch).
      for (const item of data.items) {
        const sourceInv = await tx.inventoryItem.findFirst({
          where: { id: item.inventoryItemId, franchiseId: data.fromBranchId }
        });
        if (!sourceInv || sourceInv.currentStock < item.quantity) {
          throw new Error(`Insufficient stock in source branch for ${sourceInv?.name ?? item.inventoryItemId}. Available: ${sourceInv?.currentStock || 0}`);
        }
      }

      return tx.stockTransfer.create({
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
        include: { items: { include: { inventoryItem: true } }, fromBranch: true, toBranch: true }
      });
    });
  }

  /**
   * Dispatch: PENDING -> SHIPPED. This is where stock actually leaves the
   * source branch (TRANSFER_OUT). Re-validates availability against live
   * stock since it may have changed since the transfer was created.
   */
  static async dispatchTransfer(id: string, requestingUser: TokenPayload) {
    const userId = requestingUser.userId;
    return prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: { items: { include: { inventoryItem: true } } }
      });
      if (!transfer) throw new Error('Transfer not found');
      // Only the sending branch (or HQ) may dispatch its own outgoing transfer.
      if (requestingUser.role !== 'SUPER_ADMIN' && transfer.fromBranchId !== requestingUser.franchiseId) {
        throw new Error('You are not authorized to dispatch a transfer that does not originate from your branch.');
      }
      if (transfer.status !== 'PENDING') {
        throw new Error(`Only PENDING transfers can be dispatched (current status: ${transfer.status}).`);
      }

      for (const item of transfer.items) {
        const sourceInv = await tx.inventoryItem.findFirst({
          where: { id: item.inventoryItemId, franchiseId: transfer.fromBranchId }
        });
        if (!sourceInv || sourceInv.currentStock < item.quantity) {
          throw new Error(`Insufficient stock in source branch for ${sourceInv?.name ?? item.inventoryItemId}. Available: ${sourceInv?.currentStock || 0}`);
        }

        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'TRANSFER_OUT',
          quantity: -item.quantity,
          referenceType: 'TRANSFER',
          referenceId: transfer.id,
          note: `Dispatched to branch ${transfer.toBranchId}`,
          userId
        });
      }

      return tx.stockTransfer.update({
        where: { id },
        data: { status: 'SHIPPED' },
        include: { items: { include: { inventoryItem: true } }, fromBranch: true, toBranch: true }
      });
    });
  }

  /**
   * Receive: SHIPPED -> COMPLETED. Credits the destination branch
   * (TRANSFER_IN). Guarded to SHIPPED-only so a still-PENDING transfer
   * (nothing dispatched yet) or an already-COMPLETED one can't be
   * received/double-credited.
   */
  static async completeTransfer(id: string, requestingUser: TokenPayload) {
    const userId = requestingUser.userId;
    return prisma.$transaction(async (tx) => {
      const transfer = await tx.stockTransfer.findUnique({
        where: { id },
        include: { items: { include: { inventoryItem: true } } }
      });
      if (!transfer) throw new Error('Transfer not found');
      // Only the receiving branch (or HQ) may mark its own incoming transfer received.
      if (requestingUser.role !== 'SUPER_ADMIN' && transfer.toBranchId !== requestingUser.franchiseId) {
        throw new Error('You are not authorized to receive a transfer that is not destined for your branch.');
      }
      if (transfer.status !== 'SHIPPED') {
        throw new Error(`Only SHIPPED (in-transit) transfers can be received (current status: ${transfer.status}).`);
      }

      for (const item of transfer.items) {
        // Find existing item in destination branch (by SKU, falling back to
        // name — a branch may already stock the same item under a
        // differently-generated SKU), or create it if not present.
        let destInv = item.inventoryItem.sku
          ? await tx.inventoryItem.findFirst({
              where: {
                franchiseId: transfer.toBranchId,
                sku: item.inventoryItem.sku,
              },
            })
          : await tx.inventoryItem.findFirst({
              where: {
                franchiseId: transfer.toBranchId,
                name: { equals: item.inventoryItem.name, mode: 'insensitive' },
              },
            });

        if (!destInv) {
          // InventoryItem.sku is unique per franchise (not globally), so the
          // destination branch's row for this product keeps the exact same
          // SKU as the source — same master item, just a location-level
          // balance for a different branch. Never derive/suffix a new SKU
          // here: that would fork the product identity and make Stock Hub
          // show the same item twice under different SKUs.
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
          userId
        });
      }

      return tx.stockTransfer.update({
        where: { id },
        data: { status: 'COMPLETED', approvedBy: userId },
        include: { items: { include: { inventoryItem: true } }, fromBranch: true, toBranch: true }
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

  /**
   * Goods currently "in transit": stock was already deducted from the source
   * branch at initiation but hasn't been credited to the destination yet
   * (that only happens at completeTransfer). Previously nothing surfaced this
   * in-between state at all. This is a read-only visibility report — it does
   * not change the underlying deduct-at-initiate/credit-at-complete lifecycle.
   */
  static async getInTransit(franchiseId?: string) {
    const transfers = await prisma.stockTransfer.findMany({
      where: {
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
        ...(franchiseId ? { OR: [{ fromBranchId: franchiseId }, { toBranchId: franchiseId }] } : {})
      },
      include: { fromBranch: true, toBranch: true, items: { include: { inventoryItem: true } } },
      orderBy: { createdAt: 'asc' }
    });

    const itemTotals = new Map<string, { name: string; sku: string; unit: string; quantity: number }>();
    for (const transfer of transfers) {
      for (const item of transfer.items) {
        const key = item.inventoryItemId;
        const existing = itemTotals.get(key);
        itemTotals.set(key, {
          name: item.inventoryItem.name,
          sku: item.inventoryItem.sku,
          unit: item.inventoryItem.unit,
          quantity: (existing?.quantity || 0) + item.quantity
        });
      }
    }

    return {
      transfers,
      totalTransfersInTransit: transfers.length,
      itemTotals: Array.from(itemTotals.values())
    };
  }
}
