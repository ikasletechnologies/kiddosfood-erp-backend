import prisma from '../../lib/prisma';

export class VendorInvoiceService {
  static async getAll(params: { vendorId?: string; status?: string } = {}) {
    return prisma.vendorInvoice.findMany({
      where: {
        ...(params.vendorId ? { vendorId: params.vendorId } : {}),
        ...(params.status ? { status: params.status as "PENDING" | "MATCHED" | "MISMATCH" } : {})
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
    poId: string;
    grnId?: string;
    invoiceNumber: string;
    amount: number;
  }) {
    const po = await prisma.procurementOrder.findUnique({ where: { id: data.poId } });
    if (!po) throw new Error('Purchase Order not found');

    return prisma.vendorInvoice.create({
      data: {
        vendorId: data.vendorId,
        poId: data.poId,
        grnId: data.grnId || null,
        invoiceNumber: data.invoiceNumber,
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
   * Run 3-way matching: PO value vs GRN total vs Invoice amount.
   * Marks as MATCHED if all three align within a 1% tolerance; otherwise MISMATCH.
   */
  static async match(invoiceId: string) {
    const invoice = await prisma.vendorInvoice.findUnique({
      where: { id: invoiceId },
      include: {
        procurementOrder: { include: { poItems: true } },
        grn: { include: { items: true } }
      }
    });
    if (!invoice) throw new Error('Invoice not found');

    const poValue = invoice.procurementOrder?.totalAmount ?? 0;
    const grnValue = invoice.grn
      ? invoice.grn.items.reduce((s, i) => s + i.acceptedQty * i.price, 0)
      : 0;
    const invoiceAmount = invoice.amount;

    // 3-Way Match Logic: PO vs GRN vs Invoice
    // All three must match within a 1% tolerance
    const tolerance = poValue * 0.01;
    
    const poVsInvoice = Math.abs(invoiceAmount - poValue) <= tolerance;
    const poVsGrn = Math.abs(grnValue - poValue) <= tolerance;
    const grnVsInvoice = Math.abs(invoiceAmount - grnValue) <= tolerance;

    const isMatched = poVsInvoice && poVsGrn && grnVsInvoice;

    return prisma.vendorInvoice.update({
      where: { id: invoiceId },
      data: { status: isMatched ? 'MATCHED' : 'MISMATCH' },
      include: { vendor: true, procurementOrder: true, grn: true }
    });
  }

  static async updateStatus(invoiceId: string, status: 'PENDING' | 'MATCHED' | 'MISMATCH') {
    return prisma.vendorInvoice.update({
      where: { id: invoiceId },
      data: { status },
      include: { vendor: true, procurementOrder: true }
    });
  }
}
