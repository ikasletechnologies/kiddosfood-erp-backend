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
   * Preview lot number for the "Auto Batch" control on the New GRN form.
   * Reads the current sequence state without consuming/incrementing it.
   */
  static async generateLotNumber(): Promise<string> {
    const seq = await prisma.numberSequence.findUnique({
      where: { key: 'GRN_LOT' }
    });
    const nextVal = (seq?.value || 0) + 1;
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    return `LOT-${ymd}-${String(nextVal).padStart(5, '0')}`;
  }

  static async getAll(params: { poId?: string; status?: string; startDate?: string; endDate?: string; fromDate?: string; toDate?: string } = {}) {
    const from = params.fromDate || params.startDate;
    const to = params.toDate || params.endDate;
    const dateFilter: any = {};
    if (from || to) {
      dateFilter.receivedAt = {};
      if (from) dateFilter.receivedAt.gte = new Date(from);
      if (to) {
        const toD = new Date(to);
        toD.setHours(23, 59, 59, 999);
        dateFilter.receivedAt.lte = toD;
      }
    }
    return prisma.goodsReceipt.findMany({
      where: {
        ...(params.poId ? { poId: params.poId } : {}),
        ...(params.status ? { status: params.status as any } : {}),
        ...dateFilter
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

  /**
   * Cumulative received quantity per PO line, from COMPLETED GRNs only —
   * the exact same basis `approve()` already uses to decide PO status
   * (PARTIALLY_RECEIVED vs RECEIVED, see the receivedMap logic below). A
   * PENDING GRN hasn't posted inventory yet and a CANCELLED one never will,
   * so neither counts against what's still receivable — matching
   * `approve()`'s own `status: 'COMPLETED'` filter.
   */
  private static async getCumulativeReceived(tx: any, poId: string, excludeGrnId?: string): Promise<Map<string, number>> {
    const completedItems = await tx.goodsReceiptItem.findMany({
      where: {
        grn: {
          poId,
          status: 'COMPLETED',
          ...(excludeGrnId ? { id: { not: excludeGrnId } } : {})
        }
      },
      select: { materialId: true, receivedQty: true }
    });
    const map = new Map<string, number>();
    for (const item of completedItems) {
      if (!item.materialId) continue;
      map.set(item.materialId, (map.get(item.materialId) || 0) + item.receivedQty);
    }
    return map;
  }

  /**
   * Remaining receivable quantity per PO line — ordered minus cumulative
   * received (see getCumulativeReceived) — for the New Receipt screen to
   * display/cap against. Read-only; no lock needed here since this is
   * advisory for the UI, not the authoritative gate (createFromPO
   * re-validates under a row lock at actual submission time).
   */
  static async getRemainingQuantities(poId: string) {
    const po = await prisma.procurementOrder.findUnique({
      where: { id: poId },
      include: { poItems: { include: { inventoryItem: true } } }
    });
    if (!po) throw new Error('Purchase Order not found');

    const receivedMap = await this.getCumulativeReceived(prisma, poId);

    return po.poItems.map((item) => {
      const received = receivedMap.get(item.inventoryItemId || '') || 0;
      const remaining = Math.max(0, item.quantity - received);
      return {
        materialId: item.inventoryItemId,
        itemName: item.itemName || item.inventoryItem?.name || null,
        unit: item.unit,
        ordered: item.quantity,
        previouslyReceived: received,
        remaining
      };
    });
  }

  /**
   * Authoritative backend scope validation for GRN warehouse assignments.
   * Ensures HQ users cannot receive goods into Franchise warehouses, and
   * Franchise users can only receive goods into their own assigned franchise warehouse.
   */
  private static async validateWarehouseScope(tx: any, warehouseId: string, user?: any): Promise<void> {
    if (!warehouseId) return;

    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      include: {
        primaryForFranchises: { select: { id: true, name: true, isHQ: true } }
      }
    });

    if (!warehouse) {
      throw new Error(`Warehouse with ID "${warehouseId}" not found`);
    }

    if (warehouse.status !== 'ACTIVE') {
      throw new Error(`Warehouse "${warehouse.name}" is inactive`);
    }

    if (!user) return; // Defensive fallback if call has no user payload

    const userRole = (user.role?.name || user.role || '').toUpperCase();
    const userFranchiseId = user.franchiseId;

    const nonHqOwners = (warehouse.primaryForFranchises || []).filter((f: any) => !f.isHQ);

    if (userRole === 'SUPER_ADMIN' || !userFranchiseId) {
      // HQ User Scope: Must NOT select a Franchise warehouse
      if (nonHqOwners.length > 0) {
        const ownerName = nonHqOwners[0].name;
        throw new Error(`HQ users cannot receive goods into Franchise warehouse "${warehouse.name}" (belonging to ${ownerName}). Please select an HQ warehouse.`);
      }
    } else {
      // Franchise User Scope: Must select their OWN franchise warehouse
      const isOwner = nonHqOwners.some((f: any) => f.id === userFranchiseId);
      if (!isOwner) {
        throw new Error(`Franchise users cannot receive goods into warehouse "${warehouse.name}". You can only receive goods into your own assigned franchise warehouse.`);
      }
    }
  }

  static async createFromPO(
    poId: string,
    data: {
      receivedBy?: string;
      freightCost?: number;
      unloadingCost?: number;
      performedBy?: string;
      user?: any;
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
    return prisma.$transaction(async (tx) => {
      // Row lock on the parent PO — same pattern as sales.service.ts's
      // _lockDeliveryChallanForReturn — so two concurrent createFromPO calls
      // against the same PO serialize instead of both reading the same
      // "remaining" snapshot and both passing validation (the exact race
      // this feature exists to close: remaining=2, two GRNs both for 2,
      // both "valid" if read concurrently without a lock).
      await tx.$queryRaw`SELECT id FROM "ProcurementOrder" WHERE id = ${poId} FOR UPDATE`;

      const po = await tx.procurementOrder.findUnique({
        where: { id: poId },
        include: { poItems: true }
      });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'CANCELLED') throw new Error('Cannot create GRN for a cancelled PO');
      if (po.status === 'CLOSED') throw new Error('PO is already closed');

      // Authoritative cap: a GRN can never request more than what's still
      // outstanding on the PO line (ordered − cumulative received from
      // COMPLETED GRNs). Computed fresh, under the lock above, from
      // persisted GoodsReceiptItem rows — never trusted from the client.
      const receivedMap = await this.getCumulativeReceived(tx, poId);

      const itemsData: any[] = [];
      for (const item of data.items) {
        const poItem = po.poItems.find(p => p.inventoryItemId === item.materialId);
        if (!poItem) throw new Error(`Item ${item.materialId} does not belong to Purchase Order ${po.poNumber || poId}`);

        if (item.warehouseId) {
          await this.validateWarehouseScope(tx, item.warehouseId, data.user);
        }

        const qty = Number(item.orderedQty ?? poItem.quantity ?? 0);
        const poPrice = Number(poItem.price ?? 0);
        const price = Number(item.price ?? poPrice);
        const received = Number(item.receivedQty ?? 0);
        const rejected = Number(item.rejectedQty ?? 0);
        const accepted = Number(item.acceptedQty ?? Math.max(0, received - rejected));

        if (price < 0) throw new Error(`Actual unit price for ${poItem.inventoryItemId} cannot be negative`);
        if (received < 0) throw new Error(`Received quantity for ${poItem.inventoryItemId} cannot be negative`);
        if (rejected < 0 || rejected > received) throw new Error(`Rejected quantity for ${poItem.inventoryItemId} must be between 0 and received quantity`);

        const alreadyReceived = receivedMap.get(item.materialId) || 0;
        const remaining = Math.max(0, poItem.quantity - alreadyReceived);
        if (received > remaining + 0.0001) {
          const label = poItem.itemName || item.materialId;
          throw new Error(`Cannot receive ${received} ${poItem.unit} of "${label}" — only ${remaining} ${poItem.unit} remains on this Purchase Order (ordered ${poItem.quantity}, already received ${alreadyReceived}).`);
        }

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

        let assignedLotNumber: string | null = null;
        const rawLot = (item.lotNumber || '').trim();
        const isAutoLot = !rawLot || rawLot === '[AUTO]' || rawLot.toUpperCase().endsWith('-[AUTO]') || rawLot.toUpperCase() === 'AUTO' || rawLot === 'Auto-Generated on Save' || /^LOT-\d{8}-\d{5}$/i.test(rawLot);

        if (accepted > 0) {
          if (isAutoLot) {
            const seq = await this.nextSequence(tx, 'GRN_LOT');
            const now = new Date();
            const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
            assignedLotNumber = `LOT-${ymd}-${String(seq).padStart(5, '0')}`;
          } else {
            // Validate manual lot number for duplicates against existing non-cancelled GRN items & Inventory Batches
            const manualLot = rawLot;
            const existingGrnItem = await tx.goodsReceiptItem.findFirst({
              where: {
                lotNumber: manualLot,
                grn: { status: { not: 'CANCELLED' } }
              }
            });
            const existingBatch = await tx.inventoryBatch.findFirst({
              where: { lotNumber: manualLot }
            });

            if (existingGrnItem || existingBatch) {
              const label = poItem.itemName || item.materialId;
              throw new Error(`Batch/Lot Number "${manualLot}" already exists for item "${label}". Manual lot numbers must be unique.`);
            }
            assignedLotNumber = manualLot;
          }
        } else {
          assignedLotNumber = isAutoLot ? null : rawLot;
        }

        itemsData.push({
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
          lotNumber: assignedLotNumber,
          warehouseId: item.warehouseId,
          binId: item.binId
        });
      }

      return tx.goodsReceipt.create({
        data: {
          poId,
          receivedBy: data.receivedBy,
          freightCost: data.freightCost || 0,
          unloadingCost: data.unloadingCost || 0,
          status: 'PENDING',
          items: { create: itemsData }
        },
        include: {
          procurementOrder: { include: { vendor: true } },
          items: { include: { inventoryItem: true } }
        }
      });
    });
  }

  static async approve(grnId: string, user?: any) {
    return prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.findUnique({
        where: { id: grnId },
        include: { items: true, procurementOrder: { include: { poItems: true, vendor: { select: { state: true } } } } }
      });
      if (!grn) throw new Error('GRN not found');
      if (grn.status === 'COMPLETED') throw new Error('GRN already approved');
      if (grn.status === 'CANCELLED') throw new Error('Cannot approve a cancelled GRN');

      // Same row lock createFromPO takes — two GRNs against the same PO
      // (e.g. two created back-to-back before either was approved) must
      // have their approvals serialized too, or both could complete and
      // together push cumulative received past what was ever ordered.
      await tx.$queryRaw`SELECT id FROM "ProcurementOrder" WHERE id = ${grn.poId} FOR UPDATE`;

      // Defense in depth against exactly that: re-check cumulative received
      // (this GRN's own items + every OTHER already-COMPLETED GRN for the
      // PO) against each line's ordered quantity before posting inventory —
      // createFromPO validates at creation time, but a second GRN can be
      // created (and left PENDING) before the first is approved, so this
      // is the last real gate before stock/ledger entries are made.
      {
        const priorReceived = await this.getCumulativeReceived(tx, grn.poId, grnId);
        for (const item of grn.items) {
          if (!item.materialId) continue;
          const poItem = grn.procurementOrder.poItems.find(p => p.inventoryItemId === item.materialId);
          if (!poItem) continue;
          const already = priorReceived.get(item.materialId) || 0;
          const projected = already + item.receivedQty;
          if (projected > poItem.quantity + 0.0001) {
            const label = poItem.itemName || item.materialId;
            throw new Error(`Cannot approve: "${label}" would receive ${projected} against an ordered quantity of ${poItem.quantity} (already completed elsewhere: ${already}). Reduce this GRN's received quantity or cancel a duplicate GRN first.`);
          }
        }
      }

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
          if (item.warehouseId) {
            await this.validateWarehouseScope(tx, item.warehouseId, user);
          }
          const batchNo = (item.lotNumber || item.vendorBatchNo || '').trim();
          if (!batchNo) {
            throw new Error(`Batch/Lot number is required for material item "${item.materialId}" before approval.`);
          }
          
          if (!item.expDate || isNaN(new Date(item.expDate).getTime())) {
            throw new Error(`Valid Expiry (EXP) date is required for material item "${item.materialId}" before approval.`);
          }
          if (item.mfgDate && item.expDate && new Date(item.expDate).getTime() < new Date(item.mfgDate).getTime()) {
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
