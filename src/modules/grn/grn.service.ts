import prisma from '../../lib/prisma';

export class GRNService {
  static async getAll(params: { poId?: string; status?: string } = {}) {
    return prisma.goodsReceipt.findMany({
      where: {
        ...(params.poId ? { poId: params.poId } : {}),
        ...(params.status ? { status: params.status as any } : {})
      },
      include: {
        procurementOrder: { include: { vendor: true } },
        items: { include: { inventoryItem: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        procurementOrder: { include: { vendor: true, poItems: { include: { inventoryItem: true } } } },
        items: { include: { inventoryItem: true } }
      }
    });
  }

  /**
   * Create a GRN from an existing PO.
   * Items contain accepted/rejected quantities per PO line item.
   * Stock is NOT updated here — only on approve.
   */
  static async createFromPO(
    poId: string,
    data: {
      receivedBy?: string;
      items: Array<{
        materialId: string;
        orderedQty: number;
        receivedQty: number;
        acceptedQty: number;
        rejectedQty: number;
        price: number;
      }>;
    }
  ) {
    const po = await prisma.procurementOrder.findUnique({
      where: { id: poId },
      include: { poItems: true }
    });
    if (!po) throw new Error('Purchase Order not found');
    if (po.status === 'CANCELLED') throw new Error('Cannot create GRN for a cancelled PO');
    if (po.status === 'RECEIVED') throw new Error('Goods already received for this PO');

    return prisma.goodsReceipt.create({
      data: {
        poId,
        receivedBy: data.receivedBy,
        status: 'PENDING',
        items: {
          create: data.items.map((item) => {
            const poItem = po.poItems.find(p => p.inventoryItemId === item.materialId);
            const qty = Number(item.orderedQty ?? item.quantity ?? poItem?.quantity ?? 0);
            const price = Number(item.price ?? poItem?.price ?? 0);
            
            console.log(`[GRN Debug] Mapping item ${item.materialId}: qty=${qty}, price=${price}`);
            
            return {
              materialId: item.materialId,
              quantity: qty,
              receivedQty: Number(item.receivedQty ?? 0),
              acceptedQty: Number(item.acceptedQty ?? 0),
              rejectedQty: Number(item.rejectedQty ?? 0),
              price: price
            };
          })
        }
      },
      include: {
        procurementOrder: { include: { vendor: true } },
        items: { include: { inventoryItem: true } }
      }
    });
  }

  /**
   * Approve GRN: updates inventory stock by acceptedQty and marks PO as RECEIVED.
   * This is the ONLY place where stock is updated from procurement.
   */
  static async approve(grnId: string) {
    return prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.findUnique({
        where: { id: grnId },
        include: { items: true, procurementOrder: true }
      });
      if (!grn) throw new Error('GRN not found');
      if (grn.status === 'COMPLETED') throw new Error('GRN already approved');
      if (grn.status === 'CANCELLED') throw new Error('Cannot approve a cancelled GRN');

      // Update stock for each accepted item
      for (const item of grn.items) {
        if (item.acceptedQty <= 0) continue;

        await tx.stockMovement.create({
          data: {
            itemId: item.materialId,
            movementType: 'PURCHASE_IN',
            quantity: item.acceptedQty,
            referenceType: 'GRN',
            referenceId: grnId,
            note: `GRN approved — accepted ${item.acceptedQty} units`
          }
        });

        await tx.inventoryItem.update({
          where: { id: item.materialId },
          data: { currentStock: { increment: item.acceptedQty } }
        });
      }

      // Mark GRN as completed
      const updatedGRN = await tx.goodsReceipt.update({
        where: { id: grnId },
        data: { status: 'COMPLETED' },
        include: {
          procurementOrder: { include: { vendor: true } },
          items: { include: { inventoryItem: true } }
        }
      });

      // Mark PO as RECEIVED
      await tx.procurementOrder.update({
        where: { id: grn.poId },
        data: { status: 'RECEIVED', received: true }
      });

      return updatedGRN;
    });
  }

  static async cancel(grnId: string) {
    const grn = await prisma.goodsReceipt.findUnique({ where: { id: grnId } });
    if (!grn) throw new Error('GRN not found');
    if (grn.status === 'COMPLETED') throw new Error('Cannot cancel an approved GRN — stock has already been updated');

    return prisma.goodsReceipt.update({
      where: { id: grnId },
      data: { status: 'CANCELLED' },
      include: {
        procurementOrder: { include: { vendor: true } },
        items: { include: { inventoryItem: true } }
      }
    });
  }
}
