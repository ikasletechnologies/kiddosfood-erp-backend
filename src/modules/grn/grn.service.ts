import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { ProcurementService } from '../procurement/procurement.service';
import { VendorInvoiceService } from '../vendor-invoices/vendor-invoices.service';
import { resolveSellerState } from '../../utils/gst-tax.util';

export class GRNService {
  /**
   * Atomic sequence number — a row-level UPDATE...increment inside a
   * transaction serializes concurrent callers at the DB level, unlike
   * deriving a number from Date.now()/row counts (the previous batch number
   * used `Date.now().toString().slice(-4)`, which repeats every 10 seconds
   * and two GRNs approved in the same window collided).
   */
  private static async nextSequence(tx: any, key: string): Promise<number> {
    const seq = await tx.numberSequence.upsert({
      where: { key },
      create: { key, value: 1 },
      update: { value: { increment: 1 } }
    });
    return seq.value;
  }

  /**
   * On-demand unique lot/batch number for the "Auto Batch" control on the
   * New GRN form — called before the GRN itself is even saved, so the user
   * sees the generated value immediately instead of a blank field.
   */
  static async generateLotNumber(): Promise<string> {
    return prisma.$transaction(async (tx) => {
      const seq = await this.nextSequence(tx, 'GRN_LOT');
      const now = new Date();
      const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      return `LOT-${ymd}-${String(seq).padStart(5, '0')}`;
    });
  }

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
      performedBy?: string;
      items: Array<{
        materialId: string;
        orderedQty: number;
        receivedQty: number;
        acceptedQty: number;
        rejectedQty: number;
        price: number;
        priceOverrideReason?: string;
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
            if (!poItem) throw new Error(`Item ${item.materialId} does not belong to Purchase Order ${po.poNumber || poId}`);

            const qty = Number(item.orderedQty ?? poItem.quantity ?? 0);
            const poPrice = Number(poItem.price ?? 0);
            const price = Number(item.price ?? poPrice);
            const received = Number(item.receivedQty ?? 0);
            const rejected = Number(item.rejectedQty ?? 0);
            const accepted = Number(item.acceptedQty ?? Math.max(0, received - rejected));

            if (price < 0) throw new Error(`Actual unit price for ${poItem.inventoryItemId} cannot be negative`);
            if (received < 0) throw new Error(`Received quantity for ${poItem.inventoryItemId} cannot be negative`);
            if (rejected < 0 || rejected > received) throw new Error(`Rejected quantity for ${poItem.inventoryItemId} must be between 0 and received quantity`);

            // Actual price is the received-value source of truth (feeds
            // computeCommercialsFromPO → VendorInvoice → VendorLedger). The
            // PO's own price/totalAmount is never touched — poPrice here is
            // kept purely as the audit-trail reference point.
            const priceOverridden = Math.abs(price - poPrice) > 0.001;
            if (priceOverridden && !(item.priceOverrideReason || '').trim()) {
              throw new Error(`Actual unit price for ${poItem.inventoryItemId} differs from PO price (₹${poPrice}) — an override reason is required`);
            }

            const mfgDate = item.mfgDate ? new Date(item.mfgDate) : null;
            const expDate = item.expDate ? new Date(item.expDate) : null;

            if (mfgDate && isNaN(mfgDate.getTime())) {
              throw new Error(`Invalid Manufacturing (MFG) date for ${poItem.inventoryItemId}`);
            }
            if (expDate && isNaN(expDate.getTime())) {
              throw new Error(`Invalid Expiry (EXP) date for ${poItem.inventoryItemId}`);
            }
            if (mfgDate && expDate && expDate.getTime() < mfgDate.getTime()) {
              throw new Error(`Expiry (EXP) date cannot be earlier than Manufacturing (MFG) date for ${poItem.inventoryItemId}`);
            }

            return {
              materialId: item.materialId,
              quantity: qty,
              receivedQty: received,
              acceptedQty: accepted,
              rejectedQty: rejected,
              price: price,
              poPrice: poPrice,
              priceOverridden,
              priceOverrideReason: priceOverridden ? item.priceOverrideReason!.trim() : null,
              priceOverrideBy: priceOverridden ? (data.performedBy || null) : null,
              priceOverrideAt: priceOverridden ? new Date() : null,
              unit: poItem?.unit || 'UNIT',
              qcStatus: (item.qcStatus as any) || 'PENDING',
              vendorBatchNo: item.vendorBatchNo ? item.vendorBatchNo.trim() : null,
              mfgDate,
              expDate,
              lotNumber: item.lotNumber ? item.lotNumber.trim() : null,
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
        include: { items: true, procurementOrder: { include: { poItems: true, vendor: { select: { state: true } } } } }
      });
      if (!grn) throw new Error('GRN not found');
      if (grn.status === 'COMPLETED') throw new Error('GRN already approved');
      if (grn.status === 'CANCELLED') throw new Error('Cannot approve a cancelled GRN');

      // Defense in depth: createFromPO already enforces this at entry, but
      // approval is the actual financial trigger (posts VendorLedger via
      // the auto-generated bill below), so re-validate against whatever is
      // actually persisted rather than trusting it was never bypassed.
            for (const item of grn.items) {
        if (item.price < 0) throw new Error(`Item ${item.materialId} has an invalid negative price`);
        if (item.priceOverridden && !(item.priceOverrideReason || '').trim()) {
          throw new Error(`Item ${item.materialId} has a price override with no reason recorded - cannot approve`);
        }
        if (item.acceptedQty > 0) {
          const batchNo = (item.lotNumber || item.vendorBatchNo || '').trim();
          if (!batchNo) {
            throw new Error(`Batch/Lot number is required for material item "${item.materialId}" before approval.`);
          }
          if (!item.mfgDate || isNaN(new Date(item.mfgDate).getTime())) {
            throw new Error(`Valid Manufacturing (MFG) date is required for material item "${item.materialId}" before approval.`);
          }
          if (!item.expDate || isNaN(new Date(item.expDate).getTime())) {
            throw new Error(`Valid Expiry (EXP) date is required for material item "${item.materialId}" before approval.`);
          }
          if (new Date(item.expDate).getTime() < new Date(item.mfgDate).getTime()) {
            throw new Error(`Expiry (EXP) date cannot be earlier than Manufacturing (MFG) date for material item "${item.materialId}".`);
          }
        }
      }

      let allReceived = true;
      let someReceived = false;

      // Computed once up front so every batch created below AND the vendor
      // invoice generated later carry the exact same reference — FIFO
      // consumption should trace back to "which bill this stock came from,
      // at what price," not an arbitrary internal lot code. Uses the atomic
      // sequence (see nextSequence) instead of Date.now(), which two GRNs
      // approved within the same 10-second window could collide on.
      const billSeq = await this.nextSequence(tx, 'GRN_BILL');
      const billNumber = `BILL-${grn.procurementOrder.poNumber || grn.poId.slice(0, 8)}-${String(billSeq).padStart(6, '0')}`;

      for (const item of grn.items) {
        if (item.acceptedQty <= 0) continue;

        const batchRef = (item.lotNumber || item.vendorBatchNo || '').trim() || billNumber;

        // 2. Mark GRN Item as APPROVED
        await tx.goodsReceiptItem.update({
          where: { id: item.id },
          data: { qcStatus: 'APPROVED' }
        });

        // Convert accepted quantity to inventory base unit for stock updates
        const invItemBefore = await tx.inventoryItem.findUnique({ where: { id: item.materialId! } });
        if (!invItemBefore) throw new Error(`Inventory item ${item.materialId} not found`);

        let canonicalQty = item.acceptedQty;
        console.log(`[GRN DBG] item.unit: ${item.unit}, inv.unit: ${invItemBefore.unit}, qty: ${canonicalQty}`);
        if (item.unit && invItemBefore.unit && item.unit !== 'UNIT') {
          try {
            const { convertMeasurement } = require('@businessgroupikasle/erp-units');
            canonicalQty = convertMeasurement(item.acceptedQty, item.unit.toUpperCase(), invItemBefore.unit.toUpperCase()).toNumber();
            console.log(`[GRN DBG] canonicalQty after calc: ${canonicalQty}`);
          } catch (err: any) {
             throw new Error(`Unit conversion failed for "${invItemBefore.name}": ${err.message}`);
          }
        }

        // 1. Create Inventory Batch (APPROVED status directly to update stock) using canonicalQty
        await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.materialId!,
            batchNumber: batchRef,
            lotNumber: item.lotNumber,
            // Always the real Purchase Bill reference, independent of
            // whichever value batchNumber ended up prioritizing above — the
            // business-facing consumption screens read this, not batchNumber.
            billNumber,
            mfgDate: item.mfgDate,
            expDate: item.expDate,
            initialQty: canonicalQty,
            currentQty: canonicalQty,
            unitCost: item.price,
            warehouseId: item.warehouseId || null,
            status: 'APPROVED'
          }
        });

        // 3. Record stock movement and cost price update immediately
        const preReceiptStock = await InventoryService.computeStock(item.materialId!, tx);
        const priorQty = Math.max(0, preReceiptStock);
        const priorCost = invItemBefore?.costPrice || 0;
        const newCostPrice = priorQty + canonicalQty > 0
          ? ((priorQty * priorCost) + (item.acceptedQty * item.price)) / (priorQty + canonicalQty)
          : item.price; // Note: PO value remains (acceptedQty * price), but per-canonical-unit cost applies

        await tx.inventoryItem.update({
          where: { id: item.materialId! },
          data: { 
            vendorId: grn.procurementOrder.vendorId, 
            costPrice: newCostPrice 
          }
        });

        await InventoryService.recordMovement(tx, {
          itemId: item.materialId!,
          type: 'PURCHASE_IN',
          quantity: canonicalQty,
          referenceType: 'GOODS_RECEIPT',
          referenceId: grnId,
          warehouseId: item.warehouseId || undefined,
          note: `GRN Approved & Synced: ${item.acceptedQty} ${item.unit} -> ${canonicalQty} ${invItemBefore.unit}`
        });
      }

      // 4. Update Financial Ledger (Liability) & Generate Purchase Bill (Vendor Invoice).
      // Commercials (subtotal/CGST/SGST/gross) are derived per-line from the
      // PO's own GST rates against ACCEPTED quantities — the same shared
      // helper the manual "Generate Bill" screen now uses too, so the two
      // paths can no longer disagree the way they used to (this path had
      // tax right via a flat taxFactor; the manual path hardcoded 0% and
      // could overwrite this correct bill with a tax-free one).
      const sellerState = await resolveSellerState(grn.procurementOrder.franchiseId);
      const commercials = VendorInvoiceService.computeCommercialsFromPO(grn.procurementOrder, grn.items, grn.procurementOrder.vendor?.state, sellerState);

      if (commercials.amount > 0) {
        // Automatically generate a Purchase Bill (Vendor Invoice) only if one doesn't exist yet.
        const existingInvoice = await tx.vendorInvoice.findFirst({
          where: { grnId: grnId }
        });
        if (!existingInvoice) {
          const newInvoice = await tx.vendorInvoice.create({
            data: {
              vendorId: grn.procurementOrder.vendorId,
              poId: grn.poId,
              grnId: grnId,
              invoiceNumber: billNumber,
              amount: commercials.amount,
              subtotal: commercials.subtotal,
              taxAmount: commercials.taxAmount,
              cgst: commercials.cgst,
              sgst: commercials.sgst,
              igst: commercials.igst,
              discountAmount: commercials.discountAmount || 0,
              freightCost: commercials.freightCost || 0,
              warehouseId: commercials.warehouseId,
              status: 'PENDING',
              billDate: new Date()
            }
          });

          // Recognize the liability (Vendor Ledger CREDIT + advance
          // attribution) immediately — the Purchase Bills UI has no
          // "Approve" action, only "Make Payment" on PENDING bills, so
          // waiting for a manual approve() call left Total Purchases at ₹0
          // and Make Payment/outstanding using the full gross amount
          // instead of net-of-advance. See VendorInvoiceService.recognizeLiability.
          await VendorInvoiceService.recognizeLiability(tx, newInvoice.id);
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
