import prisma from '../../lib/prisma';
import { InvoiceFulfilmentService } from './invoice-fulfilment.service';
import { SalesService } from './sales.service';

/** Explicit, single-invoice reconciliation via the established DC dispatch event. */
export class InvoiceDispatchService {
  static async review(id: string, user: any, db: any = prisma) {
    const invoice = await db.invoice.findFirst({ where: { OR: [{ id }, { orderId: id }] }, include: { order: { include: { orderItems: { include: { product: true } } } } } });
    if (!invoice || (user.role !== 'SUPER_ADMIN' && invoice.order.franchiseId !== user.franchiseId)) throw new Error('Invoice not found');
    const order = invoice.order;
    if (invoice.status === 'CANCELLED' || order.status === 'CANCELLED') throw new Error('Cancelled invoices cannot be dispatched.');
    const state = await InvoiceFulfilmentService.state(db, order.id);
    const challans = await db.deliveryChallan.findMany({ where: { sourceInvoiceId: order.id }, select: { id: true, status: true } });
    const legacyMovements = await db.stockMovement.count({ where: { referenceType: 'ORDER', referenceId: order.id, quantity: { lt: 0 } } });
    const warnings: string[] = [];
    if (legacyMovements && !order.inventory_deducted) warnings.push('Existing invoice stock movements require ledger review; automatic reconciliation is blocked.');
    if (state.status !== 'FULFILLED' && challans.some((c: any) => ['DRAFT', 'IN_TRANSIT', 'OPEN'].includes(c.status))) warnings.push('An existing Delivery Challan must be completed or reviewed before creating another dispatch.');
    const claims = new Map<string, number>();
    const lines: any[] = [];
    for (const line of state.lines.filter((l: any) => l.pendingQty > 0.0001)) {
      const original = order.orderItems.find((l: any) => l.id === line.orderItemId);
      if (!original.inventoryBatchId) { warnings.push(`Select lots in Delivery Challan for ${line.productName}.`); continue; }
      const lot = await db.inventoryBatch.findUnique({ where: { id: original.inventoryBatchId }, select: { id: true, warehouseId: true, currentQty: true, unitCost: true } });
      const options = await InvoiceFulfilmentService.options(db, { productId: line.productId, quantity: line.pendingQty, unit: line.unit, franchiseId: order.franchiseId, warehouseId: lot?.warehouseId || undefined }, true);
      const eligible = options.lots.find((l: any) => l.id === original.inventoryBatchId);
      const claimed = (claims.get(original.inventoryBatchId) || 0) + line.pendingQty * line.factor;
      claims.set(original.inventoryBatchId, claimed);
      if (!eligible || claimed > eligible.availableQty * line.factor + 0.0001) warnings.push(`Lot ${original.lotNumber || original.inventoryBatchId} is expired, blocked, reserved, outside this seller's stock, or has insufficient quantity.`);
      lines.push({ orderItemId: line.orderItemId, productId: line.productId, productName: line.productName, inventoryBatchId: original.inventoryBatchId, lotNumber: original.lotNumber || original.batchNumber, quantity: line.pendingQty, unit: line.unit, warehouseId: lot?.warehouseId, beforeQty: lot?.currentQty, afterQty: lot ? lot.currentQty - claimed : null });
    }
    return { invoiceId: invoice.id, orderId: order.id, invoiceNumber: order.invoiceNum, paymentStatus: order.paymentStatus, inventoryStatus: state.status, canPost: state.status !== 'FULFILLED' && !warnings.length && lines.length > 0, warnings, lines, challans };
  }
  static async post(id: string, user: any) {
    if (user.role !== 'SUPER_ADMIN') throw new Error('Only Super Admin can reconcile selected invoice lots.');
    const review = await this.review(id, user);
    const key = `invoice-selected-lots:${review.orderId}`;
    const existing = await prisma.deliveryChallan.findUnique({ where: { idempotencyKey: key }, include: { items: true } });
    if (existing) {
      const posted = await prisma.stockMovement.count({ where: { referenceType: 'INVOICE_FULFILMENT', referenceId: existing.id, quantity: { lt: 0 } } });
      if (posted && ['IN_TRANSIT', 'OPEN', 'CLOSED', 'CONVERTED'].includes(existing.status)) return { alreadyPosted: true, challan: existing };
      throw new Error('The prior reconciliation challan requires review; it cannot be posted again.');
    }
    if (review.inventoryStatus === 'FULFILLED') return { alreadyPosted: true };
    if (!review.canPost) throw new Error(review.warnings.join(' ') || 'No selected lots are ready for dispatch.');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: review.orderId } });
    const challan = await SalesService.createDeliveryChallan({ sourceInvoiceId: order.id, sourceFranchiseId: order.franchiseId, customerId: order.partyType === 'CUSTOMER' ? order.customerId || undefined : undefined, dealerId: order.partyType === 'DEALER' ? order.partyId || undefined : undefined, franchiseId: order.partyType === 'FRANCHISE' ? order.partyId || undefined : undefined, status: 'IN_TRANSIT', idempotencyKey: key, notes: `Selected-lot fulfilment for ${order.invoiceNum}`, items: review.lines }, user.userId);
    return { alreadyPosted: false, challan };
  }
}
