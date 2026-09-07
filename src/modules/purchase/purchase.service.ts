import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { ProcurementService } from '../procurement/procurement.service';
import { InventoryService } from '../inventory/inventory.service';


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
   * schema comment). Approximated (matches PurchaseReturnItem to the
   * originating PO's line by item name, since neither carries per-line tax
   * of its own): taxableValue is the refund total, gstRate is a
   * quantity-weighted average of the matched PO lines' own rates, and the
   * CGST/SGST vs IGST split reuses the same canonical util as every other
   * GST report/write path.
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
    const rateMap = new Map(poItems.map((pi: any) => [(pi.itemName || '').toLowerCase(), pi.gstRate]));

    const taxableValue = Number(pr.refundAmount) || 0;
    let weightedRateSum = 0;
    let weightTotal = 0;
    for (const item of pr.items) {
      const key = (item.itemName || '').toLowerCase();
      const rate = rateMap.has(key) ? (rateMap.get(key) as number) : 5;
      const lineValue = item.totalAmount || item.quantity * item.rate;
      weightedRateSum += rate * lineValue;
      weightTotal += lineValue;
    }
    const gstRate = weightTotal > 0 ? Number((weightedRateSum / weightTotal).toFixed(2)) : 0;
    const taxAmount = Number(((taxableValue * gstRate) / 100).toFixed(2));
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
    if (alreadyPosted) return pr;

    const returnAmount = Number(pr.refundAmount) || 0;
    if (returnAmount <= 0) return pr;

    const lastEntry = await tx.vendorLedger.findFirst({
      where: { vendorId: pr.vendorId },
      orderBy: { createdAt: 'desc' }
    });
    const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
    const nextBalance = currentBalance - returnAmount;

    let invoiceId: string | undefined = undefined;
    let billRefNote = '';
    const linkedInvoice = pr.procurementOrder?.invoices?.[0];
    if (linkedInvoice) {
      invoiceId = linkedInvoice.id;
      billRefNote = ` against Purchase Bill ${linkedInvoice.invoiceNumber}`;
    }

    await tx.vendorLedger.create({
      data: {
        vendorId: pr.vendorId,
        type: 'DEBIT',
        amount: returnAmount,
        balanceAfterTransaction: nextBalance,
        sourceModule: 'PROCUREMENT',
        referenceType: 'RETURN',
        referenceId: pr.returnNumber,
        invoiceId: invoiceId,
        paymentMode: 'CASH',
        note: `Purchase Return ${pr.returnNumber}${billRefNote}`,
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
    items: Array<{ itemName: string; quantity: number; unit: string; rate: number }>;
  }) {
    const { Decimal } = Prisma;
    const returnSource = data.returnSource || 'MANUAL';
    const initialStatus = data.status || 'PENDING';

    let resolvedItems = data.items;

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
        // Authoritative rate always wins over whatever the client sent.
        return { ...item, unit: match.unit, rate: match.rate };
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
          const allocatedBillAmount = new Decimal(bill.amount).times(ratio);
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
              totalAmount: new Decimal(item.quantity).times(item.rate).toDecimalPlaces(4).toNumber()
            }))
          }
        },
        include: { vendor: true, items: true, procurementOrder: true }
      });

      if (initialStatus === 'COMPLETED' || initialStatus === 'APPROVED') {
        if (returnSource !== 'GRN_REJECTION') {
          for (const item of created.items) {
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
                referenceId: created.id,
                note: `Purchase Return ${created.returnNumber} to ${created.vendor.name}`
              });
            }
          }
        }

        await this.backfillPurchaseReturnTax(tx, created.id);
        await this.recognizeReturn(tx, created.id);
      }

      return created;
    });
  }

  static async updatePurchaseReturn(id: string, data: { status: string }) {
    const { status } = data;
    
    return prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseReturn.findUnique({
        where: { id },
        include: { items: true, vendor: true }
      });
      if (!existing) throw new Error('Purchase Return not found');
      
      // If already completed and user passes completed, ensure ledger recognition is posted if missing
      if (existing.status === 'COMPLETED' && status === 'COMPLETED') {
        await this.recognizeReturn(tx, id);
        return existing;
      }
      if (existing.status === 'COMPLETED') throw new Error('Cannot update a completed return');

      // 1. If transitioning to APPROVED or COMPLETED, trigger Inventory and Financial adjustments
      if (status === 'APPROVED' || status === 'COMPLETED') {
        if (existing.returnSource !== 'GRN_REJECTION') {
          for (const item of existing.items) {
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
                referenceId: id,
                note: `Purchase Return ${existing.returnNumber} to ${existing.vendor.name}`
              });
            }
          }
        }

        // B. Update Vendor Ledger (DEBIT reduces what we owe the vendor)
        await this.backfillPurchaseReturnTax(tx, id);
        await this.recognizeReturn(tx, id);
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
