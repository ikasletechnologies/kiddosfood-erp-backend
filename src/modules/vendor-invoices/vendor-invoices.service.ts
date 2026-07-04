import prisma from '../../lib/prisma';

export class VendorInvoiceService {
  static async getAll(params: { vendorId?: string; status?: string } = {}) {
    return prisma.vendorInvoice.findMany({
      where: {
        ...(params.vendorId ? { vendorId: params.vendorId } : {}),
        ...(params.status ? { status: params.status as any } : {})
      },
      include: {
        vendor: true,
        procurementOrder: { include: { poItems: { include: { inventoryItem: true } } } },
        grn: { include: { items: { include: { inventoryItem: true } } } }
      },
      orderBy: { createdAt: 'desc' }
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

    if (!actualPoId) {
      // Auto-generate a Direct Purchase Order
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
      const po = await prisma.procurementOrder.findUnique({ where: { id: actualPoId } });
      if (!po) throw new Error('Purchase Order not found');
    }

    return prisma.vendorInvoice.create({
      data: {
        vendorId: data.vendorId,
        poId: actualPoId,
        grnId: data.grnId || null,
        invoiceNumber: data.invoiceNumber || `BILL-${Date.now().toString().slice(-6)}`,
        amount: data.amount,
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

      // 2. Advance Utilization Logic
      // Check if vendor has unutilized advances. In this system, advance payments create a negative (Dr) balance.
      // So if currentBalance < 0, we have an advance to apply.
      if (currentBalance < 0) {
        const availableAdvance = Math.min(Math.abs(currentBalance), invoice.amount);
        if (availableAdvance > 0) {
          await tx.vendorLedger.create({
            data: {
              vendorId: invoice.vendorId,
              type: 'DEBIT', // Applying advance against the invoice reduces the newly created liability
              amount: availableAdvance,
              balanceAfterTransaction: nextBalance - availableAdvance,
              sourceModule: 'FINANCE',
              referenceType: 'ADJUSTMENT',
              referenceId: invoice.id,
              invoiceId: invoice.id,
              paymentMode: 'CASH',
              note: `Auto-applied Advance against Invoice #${invoice.invoiceNumber}`
            }
          });
          
          // If fully paid by advance
          if (availableAdvance >= invoice.amount) {
            await tx.vendorInvoice.update({
              where: { id: invoiceId },
              data: { status: 'PAID' }
            });
          }
        }
      }

      // 3. Finalize Invoice Status
      return tx.vendorInvoice.update({
        where: { id: invoiceId },
        data: { status: (invoice.status as string) === 'PAID' ? 'PAID' : 'APPROVED' },
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
