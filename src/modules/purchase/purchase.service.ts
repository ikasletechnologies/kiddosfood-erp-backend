import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ProcurementService } from '../procurement/procurement.service';
import { InventoryService } from '../inventory/inventory.service';
import { PurchaseLotsService } from '../inventory/purchase-lots.service';
import { purchaseLineTax } from '../procurement/purchase-tax';

type ReturnItemInput = {
  itemName: string;
  quantity: number;
  unit: string;
  rate: number;
  // Optional: the received lot being sent back (see PurchaseLotsService).
  inventoryBatchId?: string;
  materialId?: string;
  baseQty?: number;
  unitCost?: number;
};


async function generateRFQNumber() {
  const year = new Date().getFullYear();
  const count = await prisma.requestForQuotation.count({
    where: { createdAt: { gte: new Date(year, 0, 1) } }
  });
  return `RFQ-${year}-${(count + 1).toString().padStart(5, '0')}`;
}

async function generateReturnNumber() {
  const year = new Date().getFullYear();
  const count = await prisma.purchaseReturn.count({
    where: { createdAt: { gte: new Date(year, 0, 1) } }
  });
  return `PR-${year}-${(count + 1).toString().padStart(5, '0')}`;
}

export class PurchaseService {
  // ─── RFQ (New Enterprise Structure) ──────────────────────────────────────────

  static async getRFQs(filters: { status?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { rfqNumber: { contains: filters.search, mode: 'insensitive' } },
        { notes: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.requestForQuotation.findMany({
      where,
      include: { 
         purchaseRequest: true,
         quotations: { include: { vendor: true, items: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getRFQById(id: string) {
    return prisma.requestForQuotation.findUnique({
      where: { id },
      include: { 
         purchaseRequest: true,
         quotations: { include: { vendor: true, items: true } }
      }
    });
  }

  static async createRFQ(data: {
    purchaseRequestId?: string;
    deadline?: string;
    notes?: string;
    createdBy?: string;
  }) {
    return prisma.requestForQuotation.create({
      data: {
        rfqNumber: await generateRFQNumber(),
        purchaseRequestId: data.purchaseRequestId,
        deadline: data.deadline ? new Date(data.deadline) : undefined,
        notes: data.notes,
        createdBy: data.createdBy,
        status: 'OPEN'
      }
    });
  }

  static async addVendorQuotation(rfqId: string, data: {
     vendorId: string;
     validUntil?: string;
     notes?: string;
     items: Array<{ itemName: string; quantity: number; unit: string; quotedRate: number; notes?: string }>;
  }) {
     const totalAmount = data.items.reduce((s, i) => s + i.quantity * i.quotedRate, 0);

     return prisma.vendorQuotation.create({
        data: {
           rfqId,
           vendorId: data.vendorId,
           totalAmount,
           validUntil: data.validUntil ? new Date(data.validUntil) : null,
           notes: data.notes,
           status: 'PENDING',
           items: {
              create: data.items.map(item => ({
                 itemName: item.itemName,
                 quantity: item.quantity,
                 unit: item.unit,
                 quotedRate: item.quotedRate,
                 notes: item.notes
              }))
           }
        },
        include: { vendor: true, items: true }
     });
  }

  static async updateRFQ(id: string, data: {
    status?: string;
    notes?: string;
  }) {
    return prisma.requestForQuotation.update({
      where: { id },
      data: { status: data.status as any, notes: data.notes }
    });
  }

  static async convertQuotationToPO(quotationId: string) {
    const quote = await prisma.vendorQuotation.findUnique({
      where: { id: quotationId },
      include: {
        items: true,
        rfq: { include: { purchaseRequest: { include: { items: { include: { inventoryItem: true } } } } } }
      }
    });
    if (!quote) throw new Error('Quotation not found');

    // VendorQuotationItem only stores a free-text itemName (it isn't linked to a
    // real InventoryItem), but a normal PO requires a real inventoryItemId on every
    // line so GST/costing can be computed. Resolve each quoted item to a real
    // InventoryItem: prefer a name match against the RFQ's linked Purchase Request
    // (if any), then fall back to a direct case-insensitive name match. If a line
    // can't be resolved, fail loudly instead of creating a PO with no real items —
    // that's what silently produced the previous broken (poNumber-less) PO.
    const prItemsByName = new Map(
      (quote.rfq?.purchaseRequest?.items || []).map((pi) => [pi.inventoryItem.name.toLowerCase(), pi.inventoryItem])
    );

    const resolvedItems = await Promise.all(
      quote.items.map(async (item) => {
        const key = item.itemName.trim().toLowerCase();
        let inventoryItem = prItemsByName.get(key);
        if (!inventoryItem) {
          inventoryItem = await prisma.inventoryItem.findFirst({
            where: { name: { equals: item.itemName, mode: 'insensitive' } }
          }) || undefined;
        }
        if (!inventoryItem) {
          throw new Error(
            `Cannot convert quotation to PO: "${item.itemName}" is not linked to any Inventory item. Add it to Inventory first, then retry.`
          );
        }
        return {
          inventoryItemId: inventoryItem.id,
          quantity: item.quantity,
          price: item.quotedRate || 0
        };
      })
    );

    // Delegate to the real PO-creation path so GST computation, poNumber
    // generation, and structured poItems all match a normally-created PO.
    const po = await ProcurementService.createPurchaseOrder({
      vendorId: quote.vendorId,
      status: 'PENDING_APPROVAL',
      notes: `Converted from Quotation (RFQ ${quote.rfq?.rfqNumber || quote.rfqId})`,
      items: resolvedItems
    });

    await prisma.vendorQuotation.update({ where: { id: quotationId }, data: { status: 'ACCEPTED' } });
    await prisma.requestForQuotation.update({ where: { id: quote.rfqId }, data: { status: 'CLOSED' } });

    // Reject other quotes for this RFQ
    await prisma.vendorQuotation.updateMany({
       where: { rfqId: quote.rfqId, id: { not: quotationId } },
       data: { status: 'REJECTED' }
    });

    return po;
  }

  // ─── Purchase Returns ────────────────────────────────────────────────────────

  static async getPurchaseReturns(filters: { vendorId?: string; status?: string; search?: string }) {
    const where: any = {};
    if (filters.vendorId) where.vendorId = filters.vendorId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { returnNumber: { contains: filters.search, mode: 'insensitive' } },
        { reason: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.purchaseReturn.findMany({
      where,
      include: { vendor: true, procurementOrder: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Backfill a Purchase Return's GST breakdown once it's APPROVED/COMPLETED
   * — the point it becomes an "applicable" debit note (see PurchaseReturn's
   * schema comment). Resolve the original lot/PO and stable material ID,
   * rejecting missing or ambiguous source rates. Sum the original per-line
   * tax; gstRate is only the effective display rate for that saved total.
   * The CGST/SGST vs IGST split uses the shared GST utility.
   */
  static async backfillPurchaseReturnTax(tx: any, returnId: string) {
    const { splitGstAmount, resolveSellerState } = require('../../utils/gst-tax.util');
    const pr = await tx.purchaseReturn.findUnique({
      where: { id: returnId },
      include: {
        items: true,
        vendor: { select: { state: true } },
        procurementOrder: { include: { poItems: true } }
      }
    });
    if (!pr) return;

    const sellerState = await resolveSellerState(pr.procurementOrder?.franchiseId || null);
    const poItems = pr.procurementOrder?.poItems || [];
    const { Decimal } = Prisma;
    const taxableValue = Number(pr.refundAmount ?? 0);
    let lineTaxTotal = new Decimal(0);
    let lineValueTotal = new Decimal(0);
    for (const item of pr.items) {
      let sourceItems = poItems;
      let materialId = item.materialId;
      if (item.inventoryBatchId) {
        const lot = await tx.inventoryBatch.findUnique({ where:{id:item.inventoryBatchId}, include:{ procurementOrder:{include:{poItems:true}}, goodsReceiptItem:{include:{grn:{include:{procurementOrder:{include:{poItems:true}}}}}} } });
        if (!lot || lot.vendorId !== pr.vendorId) throw new Error('Purchase return lot does not match its original supplier.');
        materialId = lot.inventoryItemId;
        sourceItems = lot.procurementOrder?.poItems || lot.goodsReceiptItem?.grn?.procurementOrder?.poItems || [];
      }
      if (!materialId && sourceItems.length) {
        const matches = sourceItems.filter((p:any)=>(p.itemName || '').trim().toLowerCase() === item.itemName.trim().toLowerCase());
        const ids = [...new Set(matches.map((p:any)=>p.inventoryItemId).filter(Boolean))];
        if (ids.length !== 1) throw new Error('Purchase return source is ambiguous. Select the original purchase lot or PO line.');
        materialId = ids[0];
      }
      if (!sourceItems.length && materialId) sourceItems = await tx.procurementOrderItem.findMany({ where:{inventoryItemId:materialId,procurementOrder:{vendorId:pr.vendorId,goodsReceipts:{some:{status:'COMPLETED'}}}} });
      const rate = purchaseLineTax(sourceItems,materialId,item.itemName);
      const lineValue = new Decimal(item.totalAmount ?? item.quantity * item.rate);
      lineValueTotal = lineValueTotal.plus(lineValue);
      lineTaxTotal = lineTaxTotal.plus(lineValue.times(rate).div(100));
    }
    const taxAmount = lineValueTotal.gt(0) ? lineTaxTotal.times(taxableValue).div(lineValueTotal).toDecimalPlaces(2).toNumber() : 0;
    const gstRate = taxableValue > 0 ? Number((taxAmount/taxableValue*100).toFixed(4)) : 0;
    const split = splitGstAmount(taxAmount, pr.vendor?.state, sellerState);

    await tx.purchaseReturn.update({
      where: { id: returnId },
      data: { taxableValue, gstRate, cgst: split.cgst, sgst: split.sgst, igst: split.igst, taxAmount }
    });
  }

  /**
   * Recognize a Purchase Return in the Vendor Ledger (DEBIT) and update running balance.
   * Idempotent: Skips if a RETURN ledger entry for this return already exists.
   */
  static async recognizeReturn(tx: any, returnId: string) {
    const pr = await tx.purchaseReturn.findUnique({
      where: { id: returnId },
      include: {
        vendor: true,
        items: true,
        procurementOrder: { include: { invoices: true } }
      }
    });
    if (!pr) throw new Error('Purchase Return not found');

    const taxableReturnAmount = Number(pr.taxableValue ?? pr.refundAmount) || pr.items.reduce(
      (sum: number, item: any) => sum + (Number(item.quantity) || 0) * (Number(item.rate) || 0),
      0
    );
    const returnTaxAmount = Number(pr.taxAmount ?? ((Number(pr.cgst) || 0) + (Number(pr.sgst) || 0) + (Number(pr.igst) || 0)));
    const returnAmount = taxableReturnAmount + returnTaxAmount;
    if (returnAmount <= 0) return pr;

    let invoiceId: string | undefined = undefined;
    let billRefNote = '';
    const linkedInvoice = pr.procurementOrder?.invoices?.[0];
    if (linkedInvoice) {
      invoiceId = linkedInvoice.id;
      billRefNote = ` against Purchase Bill ${linkedInvoice.invoiceNumber}`;
    }

    const alreadyPosted = await tx.vendorLedger.findFirst({
      where: {
        vendorId: pr.vendorId,
        referenceType: 'RETURN',
        OR: [
          { referenceId: pr.id },
          { referenceId: pr.returnNumber }
        ]
      }
    });
    if (alreadyPosted) {
      if (Math.abs(returnAmount - Number(alreadyPosted.amount || 0)) > 0.011) throw new Error('A posted return ledger amount differs from its tax snapshot. An authorised, audited accounting correction is required.');
      return pr;
    }

    const lastEntry = await tx.vendorLedger.findFirst({
      where: { vendorId: pr.vendorId },
      orderBy: { createdAt: 'desc' }
    });
    const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
    const nextBalance = currentBalance - returnAmount;

    await tx.vendorLedger.create({
      data: {
        vendorId: pr.vendorId,
        type: 'DEBIT',
        amount: returnAmount,
        balanceAfterTransaction: nextBalance,
        sourceModule: 'PROCUREMENT',
        referenceType: 'RETURN',
        referenceId: pr.returnNumber,
        invoiceId,
        paymentMode: 'CASH',
        note: `Purchase Return ${pr.returnNumber}${billRefNote}: ${pr.reason}`,
        createdAt: pr.createdAt || new Date()
      }
    });

    return pr;
  }

  static async createPurchaseReturn(data: {
    procurementOrderId?: string;
    vendorId: string;
    reason: string;
    returnSource?: string;
    status?: string;
    items: Array<ReturnItemInput>;
  }) {
    const { Decimal } = Prisma;
    const returnSource = data.returnSource || 'MANUAL';
    const initialStatus = data.status || 'PENDING';

    // Lot fields are only ever set below, after server-side validation.
    let resolvedItems: ReturnItemInput[] = data.items.map(({ itemName, quantity, unit, rate }) => ({ itemName, quantity, unit, rate }));

    // Lot-linked lines (Phase 1): the lot must be one this vendor supplied
    // for this material, and the return is capped at what that lot still
    // holds minus what other pending returns already claim on it.
    const lotIds = returnSource === 'MANUAL'
      ? Array.from(new Set(data.items.map(i => i.inventoryBatchId).filter((id): id is string => !!id)))
      : [];
    const lots = lotIds.length ? await prisma.inventoryBatch.findMany({ where: { id: { in: lotIds } } }) : [];
    const lotById = new Map(lots.map(l => [l.id, l]));
    const pendingByLot = await PurchaseLotsService.getPendingReturnClaims(prisma, { batchIds: lotIds });
    const lotRemaining = new Map(lots.map(l => [l.id, l.currentQty - (pendingByLot.get(l.id) || 0)]));

    // MANUAL returns must represent material actually received from this
    // vendor — never trust a client-supplied rate/quantity. Resolve both
    // authoritatively from ProcurementService.getVendorReturnableMaterials
    // (completed-GRN accepted qty and actual weighted price, minus whatever
    // is already claimed by an earlier non-rejected/non-cancelled return) —
    // the SAME source the frontend's material picker calls, so client and
    // server can't drift apart. GRN_REJECTION returns are exempt: they're
    // generated by the GRN page itself from data that was just accepted at
    // that exact moment, and rejected stock was never part of the accepted
    // pool this check validates against.
    if (returnSource === 'MANUAL') {
      const eligible = await ProcurementService.getVendorReturnableMaterials(data.vendorId);
      const eligibleByName = new Map(eligible.map((m: any) => [(m.name || '').toLowerCase().trim(), m]));
      // Tracks remaining balance across ALL items in this one submission —
      // two rows returning the same material must not each pass an
      // independent check against the same total availableQty.
      const remainingByName = new Map(eligible.map((m: any) => [(m.name || '').toLowerCase().trim(), m.availableQty]));

      resolvedItems = data.items.map((item) => {
        const key = (item.itemName || '').toLowerCase().trim();
        const match = eligibleByName.get(key);
        if (!match) {
          throw new Error(`"${item.itemName}" is not an eligible returnable material for this vendor (no completed GRN receipt found, or nothing left available to return).`);
        }
        const remaining = remainingByName.get(key) ?? 0;
        if (item.quantity > remaining + 0.0001) {
          throw new Error(`Cannot return ${item.quantity} ${match.unit} of "${item.itemName}" — only ${remaining} ${match.unit} is available for return.`);
        }
        remainingByName.set(key, remaining - item.quantity);
        if (item.inventoryBatchId) {
          const lot = lotById.get(item.inventoryBatchId);
          if (!lot || lot.vendorId !== data.vendorId || lot.inventoryItemId !== match.materialId) {
            throw new Error(`The selected lot is not a lot of "${item.itemName}" received from this vendor.`);
          }
          if (data.procurementOrderId && lot.procurementOrderId && lot.procurementOrderId !== data.procurementOrderId) throw new Error('The selected return lot belongs to a different Purchase Order.');
          const lotLabel = lot.lotNumber || lot.batchNumber;
          if (lot.status === 'REJECTED' || lot.status === 'RETURNED') {
            throw new Error(`Lot ${lotLabel} is ${lot.status} and cannot be returned.`);
          }
          const left = lotRemaining.get(lot.id) ?? 0;
          if (item.quantity > left + 0.0001) {
            throw new Error(`Cannot return ${item.quantity} ${match.unit} of "${item.itemName}" from lot ${lotLabel} — only ${Number(Math.max(0, left).toFixed(4))} ${match.unit} is left in that lot.`);
          }
          lotRemaining.set(lot.id, left - item.quantity);
          // The returnable unit is the material's stock unit, so quantity is
          // already the base quantity. Rate is this lot's own purchase cost.
          const lotCost = lot.unitCost ?? match.rate;
          return { itemName: item.itemName, quantity: item.quantity, unit: match.unit, rate: lotCost, materialId: match.materialId, inventoryBatchId: lot.id, baseQty: item.quantity, unitCost: lotCost };
        }
        // Authoritative rate always wins over whatever the client sent.
        return { itemName: item.itemName, quantity: item.quantity, unit: match.unit, rate: match.rate, materialId: match.materialId };
      });
    }

    if (returnSource === 'MANUAL' && data.procurementOrderId) {
      const bill = await prisma.vendorInvoice.findFirst({
        where: { poId: data.procurementOrderId },
        include: { grn: { include: { items: true } } },
        orderBy: { createdAt: 'desc' }
      });

      if (bill && bill.grn) {
        const grnItems = bill.grn.items.filter(i => (i.acceptedQty || 0) > 0);
        const totalBilledValue = grnItems.reduce((s, i) => new Decimal(i.acceptedQty).times(i.price).plus(s), new Decimal(0));

        const effectiveRateMap = new Map<string, InstanceType<typeof Decimal>>();
        for (const gi of grnItems) {
          if (!gi.materialId) continue;
          const lineValue = new Decimal(gi.acceptedQty).times(gi.price);
          const ratio = totalBilledValue.isZero() ? new Decimal(1) : lineValue.dividedBy(totalBilledValue);
          const billGoodsValue = new Decimal(bill.subtotal ?? totalBilledValue).minus(bill.discountAmount ?? 0).plus(bill.freightCost ?? 0);
          const allocatedBillAmount = billGoodsValue.times(ratio);
          const effectiveRate = allocatedBillAmount.dividedBy(new Decimal(gi.acceptedQty));
          effectiveRateMap.set(gi.materialId, effectiveRate);
        }

        // Refines the already-validated resolvedItems above (quantity cap
        // still applies) with this specific bill's own per-line effective
        // rate, which accounts for that bill's discount/freight allocation
        // — more precise than the vendor-wide weighted average when a
        // specific PO/bill is known. Never re-derives from raw data.items,
        // or the quantity validation above would be silently bypassed.
        resolvedItems = await Promise.all(resolvedItems.map(async (item) => {
          if (item.inventoryBatchId) return item; // lot-linked: keeps its own lot cost
          const material = await prisma.inventoryItem.findFirst({
            where: { name: { equals: item.itemName, mode: 'insensitive' } }
          });
          if (material && effectiveRateMap.has(material.id)) {
            const effectiveRate = effectiveRateMap.get(material.id)!;
            return { ...item, rate: effectiveRate.toDecimalPlaces(4).toNumber() };
          }
          return item;
        }));
      }
    }

    const refundAmount = resolvedItems.reduce((s, i) =>
      new Decimal(s).plus(new Decimal(i.quantity).times(i.rate)).toNumber(), 0);

    return prisma.$transaction(async (tx) => {
      // A GRN approval can be retried by the client after a slow response.
      // Serialize on the PO and return the existing equivalent document so
      // the same rejected products never create duplicate Purchase Returns.
      if (returnSource === 'GRN_REJECTION' && data.procurementOrderId) {
        await tx.$queryRaw`SELECT id FROM "ProcurementOrder" WHERE id = ${data.procurementOrderId} FOR UPDATE`;
        const existingReturns = await tx.purchaseReturn.findMany({
          where: {
            procurementOrderId: data.procurementOrderId,
            vendorId: data.vendorId,
            returnSource: 'GRN_REJECTION',
            status: { not: 'CANCELLED' }
          },
          include: { vendor: true, items: true, procurementOrder: true },
          orderBy: { createdAt: 'desc' }
        });
        const signature = (items: Array<{ itemName: string; quantity: number }>) => items
          .map(item => `${(item.itemName || '').toLowerCase().trim()}:${Number(item.quantity)}`)
          .sort()
          .join('|');
        const requestedSignature = signature(resolvedItems);
        const duplicate = existingReturns.find((purchaseReturn: any) => signature(purchaseReturn.items) === requestedSignature);
        if (duplicate) return duplicate;
      }

      const created = await tx.purchaseReturn.create({
        data: {
          returnNumber: await generateReturnNumber(),
          procurementOrderId: data.procurementOrderId,
          vendorId: data.vendorId,
          reason: data.reason,
          returnSource,
          status: initialStatus,
          refundAmount,
          items: {
            create: resolvedItems.map((item) => ({
              itemName: item.itemName,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              totalAmount: new Decimal(item.quantity).times(item.rate).toDecimalPlaces(4).toNumber(),
              materialId: item.materialId ?? null,
              inventoryBatchId: item.inventoryBatchId ?? null,
              baseQty: item.baseQty ?? null,
              unitCost: item.unitCost ?? null
            }))
          }
        },
        include: { vendor: true, items: true, procurementOrder: true }
      });

      if (initialStatus === 'COMPLETED') {
        if (returnSource !== 'GRN_REJECTION') {
          await this.postReturnStock(tx, created);
        }

        await this.backfillPurchaseReturnTax(tx, created.id);
        await this.recognizeReturn(tx, created.id);
      }

      return created;
    });
  }

  /**
   * Takes a completed return's goods out of stock. Lot-linked lines come out
   * of exactly that lot at its own cost; legacy name-only lines keep the
   * previous FIFO behaviour unchanged.
   */
  private static async postReturnStock(tx: any, pr: { id: string; returnNumber: string; vendor: { name: string }; items: any[] }) {
    for (const item of pr.items) {
      const note = `Purchase Return ${pr.returnNumber} to ${pr.vendor.name}`;

      if (item.inventoryBatchId && item.materialId) {
        const baseQty = Number(item.baseQty ?? item.quantity);
        const lot = await tx.inventoryBatch.findUnique({ where: { id: item.inventoryBatchId }, select: { warehouseId: true } });
        const fifo = await PurchaseLotsService.depleteLot(tx, item.inventoryBatchId, item.materialId, baseQty);
        await InventoryService.recordMovement(tx, {
          itemId: item.materialId,
          type: 'RETURN_OUT',
          quantity: -item.quantity,
          baseQty: -baseQty,
          transactionUnit: item.unit,
          referenceType: 'PURCHASE_RETURN',
          referenceId: pr.id,
          warehouseId: lot?.warehouseId || undefined,
          precalculatedFifo: fifo,
          note
        });
        continue;
      }

      const material = await tx.inventoryItem.findFirst({
        where: { name: { equals: item.itemName, mode: 'insensitive' } }
      });
      if (material) {
        await InventoryService.recordMovement(tx, {
          itemId: material.id,
          type: 'RETURN_OUT',
          quantity: -item.quantity,
          transactionUnit: item.unit,
          referenceType: 'PURCHASE_RETURN',
          referenceId: pr.id,
          note
        });
      }
    }
  }

  static async updatePurchaseReturn(id: string, data: { status: string; reason?: string }) {
    const { status } = data;
    if (status === 'APPROVED') {
      throw new Error('APPROVED status is no longer supported. Use COMPLETED instead.');
    }
    if (status !== 'COMPLETED' && status !== 'CANCELLED') {
      throw new Error(`Invalid status "${status}". Allowed statuses are COMPLETED or CANCELLED.`);
    }

    return prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseReturn.findUnique({
        where: { id },
        include: { items: true, vendor: true }
      });
      if (!existing) throw new Error('Purchase Return not found');
      const submittedReason = data.reason?.trim();
      if (status === 'COMPLETED' && existing.returnSource === 'GRN_REJECTION' && !submittedReason && existing.reason === 'PENDING_RETURN_REASON') {
        throw new Error('Return reason is required before submitting this GRN product return.');
      }

      // Double-completion protection / Idempotency:
      if (existing.status === 'COMPLETED' && status === 'COMPLETED') {
        await this.recognizeReturn(tx, id);
        return existing;
      }
      if (existing.status === 'COMPLETED') throw new Error('Cannot update a completed return');
      if (existing.status === 'CANCELLED') throw new Error('Cannot update a cancelled return');

      if (status === 'COMPLETED') {
        // Atomic status claim: update status from PENDING to COMPLETED only if it is currently PENDING.
        // In PostgreSQL/Prisma, updateMany returns count of rows affected. If count === 0, another
        // concurrent request already updated status to COMPLETED.
        const claimed = await tx.purchaseReturn.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'COMPLETED', ...(submittedReason ? { reason: submittedReason } : {}) }
        });

        if (claimed.count === 0) {
          // Another concurrent transaction claimed and completed this return.
          const reFetched = await tx.purchaseReturn.findUnique({
            where: { id },
            include: { vendor: true, items: true, procurementOrder: true }
          });
          if (reFetched && reFetched.status === 'COMPLETED') {
            await this.recognizeReturn(tx, id);
            return reFetched;
          }
          throw new Error('Cannot update return: status changed concurrently');
        }

        if (existing.returnSource !== 'GRN_REJECTION') {
          await this.postReturnStock(tx, existing);
        }

        // B. Update Vendor Ledger (DEBIT reduces what we owe the vendor) and GST breakdown
        await this.backfillPurchaseReturnTax(tx, id);
        await this.recognizeReturn(tx, id);

        // A GRN rejection closes the PO balance only after the operator enters
        // the reason and submits the product return. Fulfilment is accepted
        // stock plus completed GRN-return quantity, so rejected goods cannot
        // keep reappearing on the GRN ready-to-receive screen.
        if (existing.returnSource === 'GRN_REJECTION' && existing.procurementOrderId) {
          const po = await tx.procurementOrder.findUnique({
            where: { id: existing.procurementOrderId },
            include: {
              poItems: { include: { inventoryItem: true } },
              goodsReceipts: {
                where: { status: 'COMPLETED' },
                include: { items: { include: { inventoryItem: true } } }
              },
              purchaseReturns: {
                where: { status: 'COMPLETED', returnSource: 'GRN_REJECTION' },
                include: { items: true }
              }
            }
          });

          if (po) {
            const fulfilledByName = new Map<string, number>();
            for (const receipt of po.goodsReceipts) {
              for (const item of receipt.items) {
                const key = (item.inventoryItem?.name || '').toLowerCase().trim();
                if (key) fulfilledByName.set(key, (fulfilledByName.get(key) || 0) + (item.acceptedQty || 0));
              }
            }
            for (const purchaseReturn of po.purchaseReturns) {
              for (const item of purchaseReturn.items) {
                const key = (item.itemName || '').toLowerCase().trim();
                if (key) fulfilledByName.set(key, (fulfilledByName.get(key) || 0) + (item.quantity || 0));
              }
            }

            const allFulfilled = po.poItems.every((item: any) => {
              const key = (item.itemName || item.inventoryItem?.name || '').toLowerCase().trim();
              return (fulfilledByName.get(key) || 0) + 0.0001 >= item.quantity;
            });
            const anyFulfilled = Array.from(fulfilledByName.values()).some(quantity => quantity > 0);
            await tx.procurementOrder.update({
              where: { id: po.id },
              data: {
                status: allFulfilled ? 'RECEIVED' : (anyFulfilled ? 'PARTIALLY_RECEIVED' : po.status),
                received: allFulfilled
              }
            });
          }
        }

        return tx.purchaseReturn.findUnique({
          where: { id },
          include: { vendor: true, items: true, procurementOrder: true }
        });
      }

      return tx.purchaseReturn.update({
        where: { id },
        data: { status: status as any },
        include: { vendor: true, items: true, procurementOrder: true }
      });
    });
  }

  static async createRequisition(data: {
    vendorId: string;
    items: Array<{ itemName: string; quantity: number; unit: string; estimatedRate?: number }>;
    notes?: string;
  }) {
    const totalAmount = data.items.reduce((s, i) => s + i.quantity * (i.estimatedRate || 0), 0);

    return prisma.procurementOrder.create({
      data: {
        vendorId: data.vendorId,
        totalAmount,
        items: data.items,
        status: 'PENDING_APPROVAL'
      },
      include: { vendor: true }
    });
  }
}
