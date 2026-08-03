import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProcurementService } from '../procurement/procurement.service';

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
            const rejected = Number(item.rejectedQty ?? 0);
            const accepted = Number(item.acceptedQty ?? Math.max(0, received - rejected)); 
            
            return {
              materialId: item.materialId,
              quantity: qty,
              receivedQty: received,
              acceptedQty: accepted,
              rejectedQty: rejected,
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
        if (item.acceptedQty <= 0) continue;

        // Snapshot stock/cost BEFORE this receipt so the weighted-average
        // below reflects "what we had" vs "what just arrived", not the
        // post-receipt total.
        const preReceiptStock = await InventoryService.computeStock(item.materialId!, tx);
        const invItemBefore = await tx.inventoryItem.findUnique({ where: { id: item.materialId! } });

        // 1. Create Inventory Batch (Directly APPROVED for streamlined flow)
        const batch = await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.materialId!,
            batchNumber: item.vendorBatchNo || `B-${Date.now()}`,
            lotNumber: item.lotNumber,
            mfgDate: item.mfgDate,
            expDate: item.expDate,
            initialQty: item.acceptedQty,
            currentQty: item.acceptedQty, // Usable immediately
            unitCost: item.price,
            status: 'APPROVED'
          }
        });

        // 2. Record Stock Movement (Impacts InventoryItem.currentStock)
        await InventoryService.recordMovement(tx, {
          itemId: item.materialId!,
          type: 'PURCHASE_IN',
          quantity: item.acceptedQty,
          referenceType: 'GRN',
          referenceId: grnId,
          note: `Auto-approved via GRN ${grnId}`,
          warehouseId: item.warehouseId || undefined
        });

        // 3. Recompute costPrice as a moving weighted average, instead of it
        // being a single static number that's only ever set/edited by hand.
        const priorQty = Math.max(0, preReceiptStock);
        const priorCost = invItemBefore?.costPrice || 0;
        const newCostPrice = priorQty + item.acceptedQty > 0
          ? ((priorQty * priorCost) + (item.acceptedQty * item.price)) / (priorQty + item.acceptedQty)
          : item.price;

        await tx.inventoryItem.update({
          where: { id: item.materialId! },
          data: { vendorId: grn.procurementOrder.vendorId, costPrice: newCostPrice }
        });

        // 3. Mark GRN Item as APPROVED
        await tx.goodsReceiptItem.update({
          where: { id: item.id },
          data: { qcStatus: 'APPROVED' }
        });
      }

      // 4. Update Financial Ledger (Liability) & Generate Purchase Bill (Vendor Invoice)
      // Calculate total value of goods received in this GRN
      const grnSubtotal = grn.items.reduce((acc, it) => acc + (it.acceptedQty * it.price), 0);
      
      // Approximate tax based on PO's overall tax rate if possible, 
      // or just use subtotal if the user prefers simple accounting.
      // Manufacturing ERPs usually record the exact liability from the GRN.
      const poTotal = grn.procurementOrder.totalAmount;
      const poSubtotal = grn.procurementOrder.subtotal;
      const taxFactor = poSubtotal > 0 ? poTotal / poSubtotal : 1;
      const grnTotalWithTax = grnSubtotal * taxFactor;

      if (grnTotalWithTax > 0) {
        // Automatically generate a Purchase Bill (Vendor Invoice) only if one doesn't exist yet.
        const existingInvoice = await tx.vendorInvoice.findFirst({
          where: { grnId: grnId }
        });
        if (!existingInvoice) {
          const invoiceNumber = `BILL-${grn.procurementOrder.poNumber || grn.poId.slice(0, 8)}-${Date.now().toString().slice(-4)}`;
          await tx.vendorInvoice.create({
            data: {
              vendorId: grn.procurementOrder.vendorId,
              poId: grn.poId,
              grnId: grnId,
              invoiceNumber: invoiceNumber,
              amount: grnTotalWithTax,
              status: 'PENDING'
            }
          });
        }
      }

      // Check PO fulfillment status
      const allGRNsForPO = await tx.goodsReceiptItem.findMany({
         where: { 
           grn: { 
             poId: grn.poId, 
             status: 'COMPLETED',
             id: { not: grnId } // Exclude current GRN to avoid double counting
           } 
         }
      });
      
      const receivedMap = new Map();
      // Add previous GRNs
      allGRNsForPO.forEach(i => receivedMap.set(i.materialId, (receivedMap.get(i.materialId) || 0) + i.receivedQty));
      // Add current GRN
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

      // Settle against any available advance
      await ProcurementService.settleVendorOrders(grn.procurementOrder.vendorId, tx);

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
            newValue: { status: 'COMPLETED', inventoryState: 'APPROVED' },
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
