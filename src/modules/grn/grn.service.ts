import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';

export class GRNService {
  static async getAll(params: { poId?: string; status?: string } = {}) {
    return prisma.goodsReceipt.findMany({
      where: {
        ...(params.poId ? { poId: params.poId } : {}),
        ...(params.status ? { status: params.status as any } : {})
      },
      include: {
        procurementOrder: { include: { vendor: true } },
        items: { include: { inventoryItem: true, warehouse: true, warehouseBin: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        procurementOrder: { include: { vendor: true, poItems: { include: { inventoryItem: true } } } },
        items: { include: { inventoryItem: true, warehouse: true, warehouseBin: true } }
      }
    });
  }

  static async createFromPO(
    poId: string,
    data: {
      receivedBy?: string;
      freightCost?: number;
      unloadingCost?: number;
      items: Array<{
        materialId: string;
        orderedQty: number;
        receivedQty: number;
        acceptedQty: number;
        rejectedQty: number;
        price: number;
        qcStatus?: string;
        vendorBatchNo?: string;
        mfgDate?: string;
        expDate?: string;
        lotNumber?: string;
        warehouseId?: string;
        binId?: string;
      }>;
    }
  ) {
    const po = await prisma.procurementOrder.findUnique({
      where: { id: poId },
      include: { poItems: true }
    });
    if (!po) throw new Error('Purchase Order not found');
    if (po.status === 'CANCELLED') throw new Error('Cannot create GRN for a cancelled PO');
    if (po.status === 'CLOSED') throw new Error('PO is already closed');

    return prisma.goodsReceipt.create({
      data: {
        poId,
        receivedBy: data.receivedBy,
        freightCost: data.freightCost || 0,
        unloadingCost: data.unloadingCost || 0,
        status: 'PENDING',
        items: {
          create: data.items.map((item) => {
            const poItem = po.poItems.find(p => p.inventoryItemId === item.materialId);
            const qty = Number(item.orderedQty ?? poItem?.quantity ?? 0);
            const price = Number(item.price ?? poItem?.price ?? 0);
            const received = Number(item.receivedQty ?? 0);
            const accepted = Number(item.acceptedQty ?? received); 
            
            return {
              materialId: item.materialId,
              quantity: qty,
              receivedQty: received,
              acceptedQty: accepted,
              rejectedQty: Number(item.rejectedQty ?? 0),
              price: price,
              qcStatus: (item.qcStatus as any) || 'PENDING',
              vendorBatchNo: item.vendorBatchNo,
              mfgDate: item.mfgDate ? new Date(item.mfgDate) : null,
              expDate: item.expDate ? new Date(item.expDate) : null,
              lotNumber: item.lotNumber,
              warehouseId: item.warehouseId,
              binId: item.binId
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

  static async approve(grnId: string) {
    return prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.findUnique({
        where: { id: grnId },
        include: { items: true, procurementOrder: { include: { poItems: true } } }
      });
      if (!grn) throw new Error('GRN not found');
      if (grn.status === 'COMPLETED') throw new Error('GRN already approved');
      if (grn.status === 'CANCELLED') throw new Error('Cannot approve a cancelled GRN');

      let allReceived = true;
      let someReceived = false;

      for (const item of grn.items) {
        if (item.receivedQty <= 0) continue;

        // Add InventoryBatch in QC_HOLD state for traceability
        // Usable stock is NOT increased yet.
        await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.materialId!,
            batchNumber: item.vendorBatchNo || `B-${Date.now()}`,
            lotNumber: item.lotNumber,
            mfgDate: item.mfgDate,
            expDate: item.expDate,
            initialQty: item.receivedQty,
            currentQty: 0, // Not usable yet
            status: 'QC_HOLD'
          }
        });

        await tx.inventoryItem.update({
          where: { id: item.materialId! },
          data: { vendorId: grn.procurementOrder.vendorId }
        });
      }

      // Check PO fulfillment status
      const allGRNsForPO = await tx.goodsReceiptItem.findMany({
         where: { grn: { poId: grn.poId, status: 'COMPLETED' } }
      });
      
      const receivedMap = new Map();
      allGRNsForPO.forEach(i => receivedMap.set(i.materialId, (receivedMap.get(i.materialId) || 0) + i.receivedQty));
      grn.items.forEach(i => receivedMap.set(i.materialId, (receivedMap.get(i.materialId) || 0) + i.receivedQty));

      for (const poItem of grn.procurementOrder.poItems) {
         const totalRcvd = receivedMap.get(poItem.inventoryItemId) || 0;
         if (totalRcvd > 0) someReceived = true;
         if (totalRcvd < poItem.quantity) allReceived = false;
      }

      const newPOStatus = allReceived ? 'RECEIVED' : (someReceived ? 'PARTIALLY_RECEIVED' : grn.procurementOrder.status);

      await tx.procurementOrder.update({
        where: { id: grn.poId },
        data: { status: newPOStatus, received: allReceived }
      });

      const updatedGRN = await tx.goodsReceipt.update({
        where: { id: grnId },
        data: { status: 'COMPLETED' },
        include: {
          procurementOrder: { include: { vendor: true } },
          items: { include: { inventoryItem: true } }
        }
      });

      // Add Audit log
      await tx.auditLog.create({
         data: {
            module: 'GRN',
            action: 'APPROVE',
            recordId: grnId,
            newValue: { status: 'COMPLETED', inventoryState: 'QC_HOLD' },
            performedBy: 'SYSTEM'
         }
      });

      return updatedGRN;
    });
  }

  static async cancel(grnId: string) {
    const grn = await prisma.goodsReceipt.findUnique({ where: { id: grnId } });
    if (!grn) throw new Error('GRN not found');
    if (grn.status === 'COMPLETED') throw new Error('Cannot cancel an approved GRN');

    return prisma.goodsReceipt.update({
      where: { id: grnId },
      data: { status: 'CANCELLED' },
      include: {
        procurementOrder: { include: { vendor: true } },
        items: { include: { inventoryItem: true } }
      }
    });
  }

  static async updateQCStatus(grnItemId: string, qcStatus: 'PENDING' | 'APPROVED' | 'HOLD' | 'REJECTED') {
     return prisma.goodsReceiptItem.update({
        where: { id: grnItemId },
        data: { qcStatus }
     });
  }
}
