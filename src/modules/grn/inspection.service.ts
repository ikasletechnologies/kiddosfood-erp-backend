import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { QCAction, InventoryStockState } from '@prisma/client';

export class InspectionService {
  static async getPendingInspections() {
    return prisma.goodsReceiptItem.findMany({
      where: {
        qcStatus: 'PENDING',
        grn: { status: 'COMPLETED' }
      },
      include: {
        grn: { include: { procurementOrder: { include: { vendor: true } } } },
        inventoryItem: true
      }
    });
  }

  static async recordInspection(data: {
    grnItemId: string;
    inspectorId?: string;
    approvedQty: number;
    rejectedQty: number;
    scrapQty?: number;
    actionTaken: QCAction;
    remarks?: string;
    temperature?: number;
    moistureContent?: number;
    packagingOk?: boolean;
  }) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.goodsReceiptItem.findUnique({
        where: { id: data.grnItemId },
        include: { grn: true }
      });

      if (!item) throw new Error('GRN Item not found');
      if (item.qcStatus !== 'PENDING') throw new Error('Item already inspected');

      // 1. Create Inspection Record
      const record = await tx.inspectionRecord.create({
        data: {
          grnItemId: data.grnItemId,
          inspectorId: data.inspectorId,
          approvedQty: data.approvedQty,
          rejectedQty: data.rejectedQty,
          scrapQty: data.scrapQty || 0,
          actionTaken: data.actionTaken,
          remarks: data.remarks,
          temperature: data.temperature,
          moistureContent: data.moistureContent,
          packagingOk: data.packagingOk ?? true,
          totalQty: item.receivedQty
        }
      });

      // 2. Update GRN Item Status
      let finalStatus: 'APPROVED' | 'REJECTED' | 'HOLD' = 'HOLD';
      if (data.actionTaken === 'APPROVE') finalStatus = 'APPROVED';
      else if (data.actionTaken === 'REJECT_RETURN' || data.actionTaken === 'REJECT_SCRAP') finalStatus = 'REJECTED';

      await tx.goodsReceiptItem.update({
        where: { id: data.grnItemId },
        data: { 
          qcStatus: finalStatus,
          acceptedQty: data.approvedQty,
          rejectedQty: data.rejectedQty
        }
      });

      // 3. Inventory Impact: Move from QC_HOLD to final state
      // Find the batch created during GRN
      const batch = await tx.inventoryBatch.findFirst({
        where: { 
           inventoryItemId: item.materialId!,
           batchNumber: item.vendorBatchNo || undefined
        },
        orderBy: { createdAt: 'desc' }
      });

      if (batch) {
        let newState: InventoryStockState = 'QC_HOLD';
        if (data.actionTaken === 'APPROVE') newState = 'APPROVED';
        else if (data.actionTaken === 'REJECT_RETURN') newState = 'RETURNED';
        else if (data.actionTaken === 'REJECT_SCRAP') newState = 'REJECTED';
        else if (data.actionTaken === 'REWORK') newState = 'QC_HOLD'; // Still in hold for rework

        await tx.inventoryBatch.update({
          where: { id: batch.id },
          data: { 
            status: newState,
            currentQty: data.approvedQty // Only approved qty is usable
          }
        });

        // Update main inventory only if approved
        if (data.actionTaken === 'APPROVE' && data.approvedQty > 0) {
          await InventoryService.recordMovement(tx, {
            itemId: item.materialId!,
            type: 'PURCHASE_IN',
            quantity: data.approvedQty,
            referenceType: 'QC_INSPECTION',
            referenceId: record.id,
            note: `QC Approved: ${data.approvedQty} ${item.materialId}`
          });
        }

        // Scrapped material never entered usable inventory — log it as waste for
        // cost/traceability reporting (previously discarded with no trace at all).
        // REJECT_RETURN is excluded: that's going back to the vendor, not waste.
        const scrapQty = data.scrapQty || (data.actionTaken === 'REJECT_SCRAP' ? data.rejectedQty : 0);
        if (data.actionTaken === 'REJECT_SCRAP' && scrapQty > 0) {
          const material = await tx.inventoryItem.findUnique({ where: { id: item.materialId! } });
          await tx.wasteEntry.create({
            data: {
              inventoryItemId: item.materialId!,
              franchiseId: material?.franchiseId,
              quantity: scrapQty,
              reason: 'QC_FAIL',
              note: `QC scrapped from GRN inspection (item ${item.materialId})`,
              costAtTime: scrapQty * (material?.costPrice || 0),
            }
          });
        }
      }

      return record;
    });
  }
}
