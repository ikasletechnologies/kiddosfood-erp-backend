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
    po: { poItems: { inventoryItemId: string | null; gstRate: number; quantity: number; price: number }[]; subtotal: number; cgst: number; sgst: number; igst: number; totalAmount: number; warehouseId?: string | null },
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
        amount: po.totalAmount,
        warehouseId: po.warehouseId || null,
      };
    }

    let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
    let warehouseId: string | null = null;
    for (const gi of grnItems) {
      if (!gi.acceptedQty || gi.acceptedQty <= 0) continue;
      const poItem = po.poItems.find(p => p.inventoryItemId === gi.materialId);
      const gstRate = poItem?.gstRate ?? 0;
      const lineSubtotal = gi.acceptedQty * gi.price;
      const lineTax = (lineSubtotal * gstRate) / 100;
      subtotal += lineSubtotal;
      cgst += lineTax / 2;
      sgst += lineTax / 2;
      if (!warehouseId && gi.warehouseId) warehouseId = gi.warehouseId;
    }
    const taxAmount = cgst + sgst + igst;
    return { subtotal, cgst, sgst, igst, taxAmount, amount: subtotal + taxAmount, warehouseId };
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
    items?: any[];
  }) {
    let actualPoId = data.poId;
    let commercials: { subtotal: number; cgst: number; sgst: number; igst: number; taxAmount: number; amount: number; warehouseId: string | null } | null = null;

    if (!actualPoId) {
      // Auto-generate a Direct Purchase Order — nothing to derive tax from
      // beyond what the caller sent, since there's no PO/GRN backing it.
      const directPo = await prisma.procurementOrder.create({
        data: {
          vendorId: data.vendorId,
          status: 'RECEIVED', // Direct purchase is already received
          totalAmount: data.amount,
          poNumber: `DPO-${Date.now().toString().slice(-6)}`,
          purchaseType: 'RAW_MATERIAL',
          received: true,
          items: data.items || [],
        }
      });
      actualPoId = directPo.id;
    } else {
      const po = await prisma.procurementOrder.findUnique({ where: { id: actualPoId }, include: { poItems: true } });
      if (!po) throw new Error('Purchase Order not found');

      // Bill tied to a real PO — derive subtotal/tax/gross SERVER-SIDE from
      // the PO (and GRN accepted quantities, if this bill came from one)
      // rather than trusting whatever the client computed. This is the fix
      // for GST silently vanishing: the old manual "Generate Bill" screen
      // hardcoded 0% tax client-side and that was taken at face value.
      const grn = data.grnId
        ? await prisma.goodsReceipt.findUnique({ where: { id: data.grnId }, include: { items: true } })
        : null;
      commercials = this.computeCommercialsFromPO(po, grn?.items);
    }

    if (data.grnId) {
      const existingInvoices = await prisma.vendorInvoice.findMany({
        where: { grnId: data.grnId },
        orderBy: { createdAt: 'asc' }
      });

      if (existingInvoices.length > 0) {
        // Find existing PENDING invoice to update instead of creating a duplicate
        const targetInvoice = existingInvoices.find(inv => inv.status === 'PENDING') || existingInvoices[0];

        // Delete any extra duplicate PENDING invoices for this same GRN
        const extraPendingIds = existingInvoices
          .filter(inv => inv.status === 'PENDING' && inv.id !== targetInvoice.id)
          .map(inv => inv.id);

        if (extraPendingIds.length > 0) {
          await prisma.vendorInvoice.deleteMany({
            where: { id: { in: extraPendingIds } }
          });
        }

        return prisma.vendorInvoice.update({
          where: { id: targetInvoice.id },
          data: {
            vendorId: data.vendorId,
            poId: actualPoId || targetInvoice.poId,
            invoiceNumber: data.invoiceNumber || targetInvoice.invoiceNumber,
            amount: commercials?.amount ?? data.amount,
            subtotal: commercials?.subtotal,
            taxAmount: commercials?.taxAmount,
            cgst: commercials?.cgst,
            sgst: commercials?.sgst,
            igst: commercials?.igst,
            warehouseId: commercials?.warehouseId,
          },
          include: {
            vendor: true,
            procurementOrder: true,
            grn: true
          }
        });
      }
    }

    return prisma.vendorInvoice.create({
      data: {
        vendorId: data.vendorId,
        poId: actualPoId,
        grnId: data.grnId || null,
        invoiceNumber: data.invoiceNumber || `BILL-${Date.now().toString().slice(-6)}`,
        amount: commercials?.amount ?? data.amount,
        subtotal: commercials?.subtotal,
        taxAmount: commercials?.taxAmount,
        cgst: commercials?.cgst,
        sgst: commercials?.sgst,
        igst: commercials?.igst,
        warehouseId: commercials?.warehouseId,
        status: 'PENDING'
      },
      include: {
        vendor: true,
        procurementOrder: true,
        grn: true
      }
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
   * Approve Invoice: The point where Liability is officially recognized in the Ledger.
   */
  static async approve(invoiceId: string, approvedBy?: string) {
    return prisma.$transaction(async (tx) => {
      const invoice = await tx.vendorInvoice.findUnique({
        where: { id: invoiceId },
        include: { vendor: true, procurementOrder: true }
      });

      if (!invoice) throw new Error('Invoice not found');
      if (invoice.status === 'APPROVED' || invoice.status === 'PAID') throw new Error('Invoice already approved');

      // 1. Recognize Liability (CREDIT in Vendor Ledger)
      const lastEntry = await tx.vendorLedger.findFirst({
        where: { vendorId: invoice.vendorId },
        orderBy: { createdAt: 'desc' }
      });
      const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
      const nextBalance = currentBalance + invoice.amount;

      const ledgerEntry = await tx.vendorLedger.create({
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
          note: `Approved Invoice #${invoice.invoiceNumber} — Liability Recognized`
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

      if (advanceApplied > 0) {
        await tx.vendorInvoice.update({
          where: { id: invoiceId },
          data: { advanceApplied }
        });
      }

      // 3. Finalize Invoice Status — PAID once advance alone covers the
      // full gross amount, APPROVED otherwise (a cash/bank Payment can
      // finish the rest later).
      return tx.vendorInvoice.update({
        where: { id: invoiceId },
        data: { status: advanceApplied >= invoice.amount - 0.01 ? 'PAID' : 'APPROVED' },
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
