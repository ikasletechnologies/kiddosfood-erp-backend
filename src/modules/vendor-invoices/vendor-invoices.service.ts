import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';


export class VendorInvoiceService {
  /**
   * Single source of truth for a Purchase Bill's commercial figures when
   * it's tied to a real PO — used by both this service's manual create()
   * and GRNService.approve()'s automatic bill generation, which used to
   * disagree: approve() correctly derived tax from the PO, the manual
   * "Generate Bill" UI hardcoded 0% tax and could overwrite approve()'s
   * correct figures with the wrong ones. Server-side and authoritative:
   * never trusts a client-supplied amount/tax when a poId is present.
   *
   * With GRN items supplied, bills only what was actually ACCEPTED, at
   * each line's own PO gst rate (not a single blended rate) — under-receipt
   * must not be billed at the full ordered quantity.
   */
  static computeCommercialsFromPO(
    po: { poItems: { inventoryItemId: string | null; gstRate: number; quantity: number; price: number }[]; subtotal: number; cgst: number; sgst: number; igst: number; totalAmount: number; discountAmount?: number | null; freightCost?: number | null; warehouseId?: string | null },
    grnItems?: { materialId: string | null; acceptedQty: number; price: number; warehouseId?: string | null }[]
  ) {
    if (!grnItems || grnItems.length === 0) {
      // No GRN context (direct/full-PO bill) — bill the PO's own totals as-is.
      return {
        subtotal: po.subtotal,
        cgst: po.cgst,
        sgst: po.sgst,
        igst: po.igst,
        taxAmount: po.cgst + po.sgst + po.igst,
        discountAmount: po.discountAmount || 0,
        freightCost: po.freightCost || 0,
        amount: po.totalAmount,
        warehouseId: po.warehouseId || null,
      };
    }

    const { Decimal } = Prisma;
    let acceptedSubtotal = new Decimal(0);
    let cgst = new Decimal(0);
    let sgst = new Decimal(0);
    let igst = new Decimal(0);
    let warehouseId: string | null = null;

    // 1. Calculate accepted value and item-level taxes
    for (const gi of grnItems) {
      if (!gi.acceptedQty || gi.acceptedQty <= 0) continue;
      const poItem = po.poItems.find(p => p.inventoryItemId === gi.materialId);
      const gstRate = new Decimal(poItem?.gstRate ?? 0);
      
      const lineSubtotal = new Decimal(gi.acceptedQty).times(gi.price);
      const lineTax = lineSubtotal.times(gstRate).dividedBy(100);
      
      acceptedSubtotal = acceptedSubtotal.plus(lineSubtotal);
      cgst = cgst.plus(lineTax.dividedBy(2));
      sgst = sgst.plus(lineTax.dividedBy(2));
      
      if (!warehouseId && gi.warehouseId) warehouseId = gi.warehouseId;
    }

    // 2. Pro-rata PO Discount and Freight based on accepted value
    const poSubtotal = new Decimal(po.subtotal || 1); // Avoid div by 0
    const fulfillmentRatio = acceptedSubtotal.dividedBy(poSubtotal);
    
    const poDiscount = new Decimal(po.discountAmount || 0);
    const poFreight = new Decimal(po.freightCost || 0);
    
    const proRataDiscount = poDiscount.times(fulfillmentRatio);
    const proRataFreight = poFreight.times(fulfillmentRatio);

    const taxAmount = cgst.plus(sgst).plus(igst);
    
    // Amount = Subtotal + Tax - Discount + Freight
    const finalAmount = acceptedSubtotal.plus(taxAmount).minus(proRataDiscount).plus(proRataFreight);

    // Return plain numbers rounded to 2 decimal places to match DB schema
    return { 
      subtotal: acceptedSubtotal.toDecimalPlaces(2).toNumber(), 
      cgst: cgst.toDecimalPlaces(2).toNumber(), 
      sgst: sgst.toDecimalPlaces(2).toNumber(), 
      igst: igst.toDecimalPlaces(2).toNumber(), 
      taxAmount: taxAmount.toDecimalPlaces(2).toNumber(), 
      discountAmount: proRataDiscount.toDecimalPlaces(2).toNumber(),
      freightCost: proRataFreight.toDecimalPlaces(2).toNumber(),
      amount: finalAmount.toDecimalPlaces(2).toNumber(), 
      warehouseId 
    };
  }

  static async getAll(params: { vendorId?: string; status?: string } = {}) {
    const invoices = await prisma.vendorInvoice.findMany({
      where: {
        ...(params.vendorId ? { vendorId: params.vendorId } : {}),
        ...(params.status ? { status: params.status as any } : {})
      },
      include: {
        vendor: true,
        procurementOrder: { include: { poItems: { include: { inventoryItem: true } } } },
        grn: { include: { items: { include: { inventoryItem: true } } } },
        payments: { where: { status: 'PAID', isCancelled: false }, select: { paidAmount: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Deduplicate any existing PENDING invoices with the same grnId (keep the newest/manual bill)
    const seenGrnIds = new Set<string>();
    const cleanedInvoices: typeof invoices = [];
    const duplicateIdsToDelete: string[] = [];

    for (const inv of invoices) {
      if (inv.grnId && inv.status === 'PENDING') {
        if (seenGrnIds.has(inv.grnId)) {
          duplicateIdsToDelete.push(inv.id);
          continue;
        }
        seenGrnIds.add(inv.grnId);
      }
      cleanedInvoices.push(inv);
    }

    if (duplicateIdsToDelete.length > 0) {
      prisma.vendorInvoice.deleteMany({ where: { id: { in: duplicateIdsToDelete } } }).catch(e => console.error("Error deduplicating vendor invoices", e));
    }

    // Outstanding = gross amount - advance already applied - cash/bank
    // payments already recorded. This is what "Make Payment" should default
    // to, not the invoice's raw gross `amount` (which ignores any advance
    // or partial payment already settled against it).
    return cleanedInvoices.map((inv: any) => {
      const paidAmount = (inv.payments || []).reduce((s: number, p: any) => s + (p.paidAmount || 0), 0);
      const outstanding = Math.max(0, Number((inv.amount - (inv.advanceApplied || 0) - paidAmount).toFixed(2)));
      return { ...inv, paidAmount, outstanding };
    });
  }

  static async create(data: {
    vendorId: string;
    poId?: string;
    grnId?: string;
    invoiceNumber?: string;
    amount: number;
    subtotal?: number;
    taxAmount?: number;
    discountAmount?: number;
    freightCost?: number;
    items?: any[];
    billDate?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      let actualPoId = data.poId;
      let commercials: { subtotal: number; cgst: number; sgst: number; igst: number; taxAmount: number; discountAmount: number; freightCost: number; amount: number; warehouseId: string | null } | null = null;

      if (!actualPoId) {
        // Auto-generate a Direct Purchase Order — nothing to derive tax from
        // beyond what the caller sent, since there's no PO/GRN backing it.
        const directPo = await tx.procurementOrder.create({
          data: {
            vendorId: data.vendorId,
            status: 'RECEIVED', // Direct purchase is already received
            totalAmount: data.amount,
            discountAmount: data.discountAmount || 0,
            freightCost: data.freightCost || 0,
            poNumber: `DPO-${Date.now().toString().slice(-6)}`,
            purchaseType: 'RAW_MATERIAL',
            received: true,
            items: data.items || [],
          }
        });
        actualPoId = directPo.id;
      } else {
        const po = await tx.procurementOrder.findUnique({ where: { id: actualPoId }, include: { poItems: true } });
        if (!po) throw new Error('Purchase Order not found');

        // Bill tied to a real PO — derive subtotal/tax/gross SERVER-SIDE from
        // the PO (and GRN accepted quantities, if this bill came from one)
        // rather than trusting whatever the client computed. This is the fix
        // for GST silently vanishing: the old manual "Generate Bill" screen
        // hardcoded 0% tax client-side and that was taken at face value.
        const grn = data.grnId
          ? await tx.goodsReceipt.findUnique({ where: { id: data.grnId }, include: { items: true } })
          : null;
        commercials = this.computeCommercialsFromPO(po, grn?.items);
      }

      let invoiceId: string;

      if (data.grnId) {
        const existingInvoices = await tx.vendorInvoice.findMany({
          where: { grnId: data.grnId },
          orderBy: { createdAt: 'asc' }
        });

        if (existingInvoices.length > 0) {
          // Find existing PENDING invoice to update instead of creating a duplicate
          const targetInvoice = existingInvoices.find((inv: any) => inv.status === 'PENDING') || existingInvoices[0];

          // Delete any extra duplicate PENDING invoices for this same GRN
          const extraPendingIds = existingInvoices
            .filter((inv: any) => inv.status === 'PENDING' && inv.id !== targetInvoice.id)
            .map((inv: any) => inv.id);

          if (extraPendingIds.length > 0) {
            await tx.vendorInvoice.deleteMany({
              where: { id: { in: extraPendingIds } }
            });
          }

          await tx.vendorInvoice.update({
            where: { id: targetInvoice.id },
            data: {
              vendorId: data.vendorId,
              poId: actualPoId || targetInvoice.poId,
              invoiceNumber: data.invoiceNumber || targetInvoice.invoiceNumber,
              amount: commercials?.amount ?? data.amount,
              subtotal: commercials?.subtotal ?? data.subtotal,
              taxAmount: commercials?.taxAmount ?? data.taxAmount,
              cgst: commercials?.cgst,
              sgst: commercials?.sgst,
              igst: commercials?.igst,
              discountAmount: commercials?.discountAmount ?? data.discountAmount ?? 0,
              freightCost: commercials?.freightCost ?? data.freightCost ?? 0,
              warehouseId: commercials?.warehouseId,
              billDate: data.billDate ? new Date(data.billDate) : undefined,
            }
          });
          invoiceId = targetInvoice.id;
        }
      }

      if (!invoiceId!) {
        const created = await tx.vendorInvoice.create({
          data: {
            vendorId: data.vendorId,
            poId: actualPoId,
            grnId: data.grnId || null,
            invoiceNumber: data.invoiceNumber || `BILL-${Date.now().toString().slice(-6)}`,
            amount: commercials?.amount ?? data.amount,
            subtotal: commercials?.subtotal ?? data.subtotal,
            taxAmount: commercials?.taxAmount ?? data.taxAmount,
            cgst: commercials?.cgst,
            sgst: commercials?.sgst,
            igst: commercials?.igst,
            discountAmount: commercials?.discountAmount ?? data.discountAmount ?? 0,
            freightCost: commercials?.freightCost ?? data.freightCost ?? 0,
            warehouseId: commercials?.warehouseId,
            status: 'PENDING',
            billDate: data.billDate ? new Date(data.billDate) : new Date()
          }
        });
        invoiceId = created.id;
      }

      // Recognize the liability the moment the bill exists — see
      // recognizeLiability's comment for why this can't wait behind a
      // manual "approve" step the UI never exposes.
      return this.recognizeLiability(tx, invoiceId);
    });
  }

  /**
   * Run strict 3-way matching: 
   * 1. PO Price vs Invoice Price
   * 2. GRN Accepted Qty vs Invoice Billed Qty
   */
  static async match(invoiceId: string) {
    const invoice = await prisma.vendorInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        procurementOrder: { include: { poItems: true } },
        grn: { include: { items: { include: { inspection: true } } } }
      }
    });
    if (!invoice) throw new Error('Invoice not found');

    const poValue = invoice.procurementOrder?.totalAmount ?? 0;
    
    // Sum up the value of goods that actually passed QC
    const acceptedGrnValue = invoice.grn?.items.reduce((s, i) => s + (i.acceptedQty * i.price), 0) ?? 0;
    const invoiceAmount = invoice.amount;

    // Strict Match Rules
    const priceMismatch = Math.abs(invoiceAmount - poValue) > (poValue * 0.01);
    const qtyMismatch = Math.abs(invoiceAmount - acceptedGrnValue) > (acceptedGrnValue * 0.01);

    const isMatched = !priceMismatch && !qtyMismatch;

    return prisma.vendorInvoice.update({
      where: { id: invoiceId },
      data: { status: isMatched ? 'MATCHED' : 'MISMATCH' },
      include: { vendor: true, procurementOrder: true, grn: true }
    });
  }

  /**
   * Recognize a bill's liability in the Vendor Ledger (CREDIT) and attribute
   * whatever PO-level advance reservation belongs to it — the single place
   * this happens, called both automatically the moment a bill is created
   * (GRNService.approve()'s auto-generated bill, and this service's own
   * create()) and from the explicit approve() endpoint below.
   *
   * This used to run ONLY inside approve(), which nothing in the product
   * ever calls — the UI's only action on a PENDING bill is "Make Payment".
   * That meant a bill's liability was never posted, "Total Purchases"
   * stayed ₹0 forever, and advanceApplied stayed 0 so Make Payment/outstanding
   * used the full gross amount instead of net-of-advance. Recognizing the
   * liability at creation time (not behind an unreachable manual approval
   * step) is what makes the GRN → Bill → Pay flow correct without adding a
   * click nobody was ever going to make.
   *
   * Idempotent: a VendorLedger PURCHASE row already existing for this
   * invoice means liability was already recognized (e.g. create() called
   * again for the same GRN, or approve() called after auto-recognition
   * already ran) — skip re-posting so the liability, and Total Purchases,
   * never get double-counted.
   */
  static async recognizeLiability(tx: any, invoiceId: string) {
    const invoice = await tx.vendorInvoice.findUnique({
      where: { id: invoiceId },
      include: { vendor: true, procurementOrder: true }
    });
    if (!invoice) throw new Error('Invoice not found');

    const alreadyRecognized = await tx.vendorLedger.findFirst({
      where: { invoiceId: invoice.id, referenceType: 'PURCHASE' }
    });
    if (alreadyRecognized) return invoice;

    // 1. Recognize Liability (CREDIT in Vendor Ledger)
    const lastEntry = await tx.vendorLedger.findFirst({
      where: { vendorId: invoice.vendorId },
      orderBy: { createdAt: 'desc' }
    });
    const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
    const nextBalance = currentBalance + invoice.amount;

    await tx.vendorLedger.create({
      data: {
        vendorId: invoice.vendorId,
        type: 'CREDIT',
        amount: invoice.amount,
        balanceAfterTransaction: nextBalance,
        sourceModule: 'FINANCE',
        referenceType: 'PURCHASE',
        referenceId: invoice.id,
        invoiceId: invoice.id,
        paymentMode: 'CASH',
        note: `Purchase Bill #${invoice.invoiceNumber} — Liability Recognized`
      }
    });

    // 2. Advance is already IN the ledger as the original DEBIT/ADVANCE
    // entry from whenever it was paid to the vendor — it doesn't need a
    // second "settlement" entry to take effect: summing that existing
    // DEBIT against the CREDIT just written above already nets the
    // balance down to the correct payable-net-of-advance figure. Writing
    // a further DEBIT here (an earlier version of this fix did) would
    // count the same ₹ of advance as two separate outflows.
    //
    // `invoice.advanceApplied` below is purely a DISPLAY/reporting field
    // (drives the invoice's own `outstanding` calc and the "Advance
    // Applied" UI) recording how much of this invoice the vendor's
    // already-reserved PO-level advance (ProcurementOrder.advanceApplied)
    // covers — not a second ledger movement. A PO can be billed across
    // multiple invoices (partial GRNs), so what's left to attribute here
    // is that reservation minus whatever earlier invoices on the same PO
    // already claimed.
    const poAdvanceApplied = invoice.procurementOrder?.advanceApplied || 0;
    let advanceAlreadyShown = 0;
    if (poAdvanceApplied > 0) {
      const priorInvoices = await tx.vendorInvoice.aggregate({
        where: { poId: invoice.poId, id: { not: invoice.id } },
        _sum: { advanceApplied: true }
      });
      advanceAlreadyShown = priorInvoices._sum.advanceApplied || 0;
    }
    const advanceApplied = Math.max(0, Math.min(invoice.amount, poAdvanceApplied - advanceAlreadyShown));

    // 3. PAID once advance alone covers the full gross amount — status is
    // otherwise left as-is (still PENDING) so the "Make Payment" action
    // (gated on status === 'PENDING' in the Purchase Bills UI) stays
    // available. Forcing it to APPROVED here would hide that action behind
    // a status the UI has no button to move a bill out of.
    return tx.vendorInvoice.update({
      where: { id: invoiceId },
      data: {
        advanceApplied,
        status: advanceApplied >= invoice.amount - 0.01 ? 'PAID' : invoice.status
      },
      include: { vendor: true, procurementOrder: true, grn: true }
    });
  }

  /**
   * Explicit approve endpoint — kept for the 3-way-match/manual-approval
   * API surface. Delegates to recognizeLiability (idempotent: a no-op if
   * the bill's liability was already recognized at creation time) and then
   * moves the status to APPROVED for any caller that still relies on that
   * transition, unless it's already PAID.
   */
  static async approve(invoiceId: string, approvedBy?: string) {
    return prisma.$transaction(async (tx) => {
      const invoice = await tx.vendorInvoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new Error('Invoice not found');
      if (invoice.status === 'PAID') throw new Error('Invoice already paid');

      const recognized = await this.recognizeLiability(tx, invoiceId);
      if (recognized.status === 'PAID') return recognized;

      return tx.vendorInvoice.update({
        where: { id: invoiceId },
        data: { status: 'APPROVED' },
        include: { vendor: true, procurementOrder: true }
      });
    });
  }

  static async updateStatus(invoiceId: string, status: 'PENDING' | 'MATCHED' | 'MISMATCH' | 'APPROVED' | 'PAID') {
    return prisma.vendorInvoice.update({
      where: { id: invoiceId },
      data: { status },
      include: { vendor: true, procurementOrder: true }
    });
  }
}
