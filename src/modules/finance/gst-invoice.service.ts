import prisma from '../../lib/prisma';
import { isInterState as computeIsInterState, resolveSellerState } from '../../utils/gst-tax.util';

interface GSTBreakdown {
  subtotal: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  isInterState: boolean;
}

// Still takes an explicit isInterState boolean (this file's call sites deal
// in franchise-to-franchise internal invoices, not a buyer/seller pair) —
// generateFranchiseInvoice below now derives that boolean from real
// franchise locations via the canonical util's isInterState() rather than
// trusting the caller's query-param boolean blindly.
export function calculateGST(subtotal: number, gstRate: number, isInterState = false): GSTBreakdown {
  const gstAmount = Number(((subtotal * gstRate) / 100).toFixed(2));
  const half = Number((gstAmount / 2).toFixed(2));

  return {
    subtotal: Number(subtotal.toFixed(2)),
    gstRate,
    cgst: isInterState ? 0 : half,
    sgst: isInterState ? 0 : half,
    igst: isInterState ? gstAmount : 0,
    total: Number((subtotal + gstAmount).toFixed(2)),
    isInterState,
  };
}

// Generate a GST-compliant invoice for a FranchiseOrder
export class GSTInvoiceService {
  static async generateFranchiseInvoice(franchiseOrderId: string, isInterState = false) {
    const order = await prisma.franchiseOrder.findUnique({
      where: { id: franchiseOrderId },
      include: {
        items: { include: { product: true } },
        franchise: true,
      },
    });

    if (!order) throw new Error('Franchise order not found');
    if (order.status === 'CANCELLED') throw new Error('Cannot generate invoice for a cancelled franchise order');

    // HQ is the seller on every franchise-order invoice; the destination
    // franchise is the buyer. Derive inter-state from their real locations
    // when both are known, falling back to the caller-supplied query param
    // only when HQ's own location isn't configured yet.
    const hqLocation = await resolveSellerState(null);
    const resolvedInterState = (hqLocation && order.franchise.location)
      ? computeIsInterState(order.franchise.location, hqLocation)
      : isInterState;

    const lineItems = order.items.map(item => {
      const gst = calculateGST(item.totalAmount, item.product.taxPercent ?? 5, resolvedInterState);
      return {
        productName: item.product.name,
        hsnCode: item.product.hsnCode ?? 'N/A',
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice.toFixed(2)),
        subtotal: Number(item.totalAmount.toFixed(2)),
        gstRate: item.product.taxPercent ?? 5,
        cgst: gst.cgst,
        sgst: gst.sgst,
        igst: gst.igst,
        total: gst.total,
      };
    });

    const subtotal   = Number(lineItems.reduce((s, l) => s + l.subtotal, 0).toFixed(2));
    const totalCGST  = Number(lineItems.reduce((s, l) => s + l.cgst, 0).toFixed(2));
    const totalSGST  = Number(lineItems.reduce((s, l) => s + l.sgst, 0).toFixed(2));
    const totalIGST  = Number(lineItems.reduce((s, l) => s + l.igst, 0).toFixed(2));
    const grandTotal = Number((subtotal + totalCGST + totalSGST + totalIGST).toFixed(2));

    return {
      invoiceNumber: `INV-${order.orderNumber}`,
      orderNumber: order.orderNumber,
      franchise: order.franchise.name,
      franchiseLocation: order.franchise.location,
      issuedAt: new Date().toISOString(),
      lineItems,
      subtotal,
      cgst: totalCGST,
      sgst: totalSGST,
      igst: totalIGST,
      grandTotal,
      paymentType: order.paymentType,
      paymentStatus: order.paymentStatus,
    };
  }

  // ─── Vendor Ledger Balance ─────────────────────────────────────────────────
  static async getVendorBalance(vendorId: string) {
    const result = await prisma.vendorLedger.groupBy({
      by: ['type'],
      where: { vendorId },
      _sum: { amount: true },
    });

    const credit = result.find(r => r.type === 'CREDIT')?._sum.amount ?? 0;
    const debit  = result.find(r => r.type === 'DEBIT')?._sum.amount ?? 0;
    const balance = Number((credit - debit).toFixed(2)); // positive = vendor owes us; negative = we owe vendor

    const entries = await prisma.vendorLedger.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { vendorId, credit, debit, balance, entries };
  }
}
