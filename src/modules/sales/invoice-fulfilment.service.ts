import { InventoryService } from '../inventory/inventory.service';
import { scopeWhere } from './lot-pricing.service';
import { isLotExpired } from '../inventory/lot-eligibility';

const ACTIVE = ['IN_TRANSIT', 'OPEN', 'CLOSED', 'CONVERTED'];
const REF = 'INVOICE_FULFILMENT';
const round = (n: number) => Math.round(n * 10000) / 10000;
export function compareFefo(a: any, b: any): number {
  const expiry = (l: any) => l.expDate ? new Date(l.expDate).getTime() : Infinity;
  const receipt = (l: any) => new Date(l.receivedAt || l.createdAt || 0).getTime();
  return (expiry(a) === expiry(b) ? 0 : expiry(a) < expiry(b) ? -1 : 1) || receipt(a) - receipt(b) || String(a.id).localeCompare(String(b.id));
}

export class InvoiceFulfilmentService {
  static async options(tx: any, input: { productId: string; quantity: number; unit?: string; franchiseId?: string | null; warehouseId?: string }, showCost: boolean) {
    if (!Number.isFinite(input.quantity) || input.quantity < 0) throw new Error('Quantity must be a non-negative number.');
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    const item = await tx.inventoryItem.findFirst({ where: { ...(product?.sku ? { sku: product.sku } : { id: input.productId }), category: 'FINISHED_GOOD', ...(await scopeWhere(tx, input.franchiseId)) } });
    const unit = input.unit || item?.unit || 'PC';
    if (!item) return { lots: [], allocations: [], availableQty: 0, allocatedQty: 0, pendingQty: input.quantity, unit, showCost };
    const factor = (await InventoryService.convertUnitToBase(item.id, unit, 1, tx)).requiredBaseQty;
    if (!(factor > 0)) throw new Error('Invalid stocking unit.');
    const rows = await tx.inventoryBatch.findMany({ where: { inventoryItemId: item.id, currentQty: { gt: 0.0001 }, status: 'APPROVED', ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}) }, include: { warehouse: { select: { id: true, name: true } }, productBatch: { select: { expiryDate: true, recall: { select: { status: true } } } } } });
    const reserved = await InventoryService.reservedQtyByLot(tx, rows.map((l: any) => l.id));
    const eligible = rows.map((l: any) => ({ ...l, expDate: [l.expDate, l.productBatch?.expiryDate].filter(Boolean).sort((a: Date, b: Date) => a.getTime() - b.getTime())[0] || null }))
      .filter((l: any) => !isLotExpired(l.expDate) && !['IN_PROGRESS', 'COMPLETED'].includes(l.productBatch?.recall?.status))
      .sort(compareFefo);
    const allReserved = await tx.inventoryReservationAllocation.aggregate({ where: { inventoryItemId: item.id, reservation: { status: 'ACTIVE' } }, _sum: { reservedQty: true, consumedQty: true, releasedQty: true } });
    const outstanding = Math.max(0, (allReserved._sum.reservedQty || 0) - (allReserved._sum.consumedQty || 0) - (allReserved._sum.releasedQty || 0));
    const lotReserved = [...reserved.values()].reduce((s: number, n) => s + n, 0);
    let stockCap = Math.max(0, item.currentStock - Math.max(0, outstanding - lotReserved));
    const lots = eligible.map((l: any) => {
      const baseAvailable = Math.min(stockCap, Math.max(0, l.currentQty - (reserved.get(l.id) || 0))); stockCap -= baseAvailable;
      return { id: l.id, lotNumber: l.lotNumber || l.batchNumber, batchNumber: l.batchNumber, productId: product?.id || input.productId, productName: product?.name || item.name, sku: item.sku, unit,
        packSize: null, productionBatchCode: null, productionDate: l.mfgDate, packagingDate: l.receivedAt || l.createdAt, expiryDate: l.expDate, warehouse: l.warehouse, location: input.franchiseId || 'HQ',
        producedQty: l.initialQty / factor, currentQty: l.currentQty / factor, reservedQty: (reserved.get(l.id) || 0) / factor, availableQty: round(baseAvailable / factor),
        unitCost: showCost ? (l.unitCost == null ? null : l.unitCost * factor) : undefined, taxPercent: item.gstRate ?? product?.taxPercent ?? 0, selectable: true, sellable: true };
    }).filter((l: any) => l.availableQty > 0.0001);
    let remaining = input.quantity;
    const allocations = (lots.length === 1 ? lots : []).map((l: any) => { const quantity = round(Math.min(remaining, l.availableQty)); remaining = round(Math.max(0, remaining - quantity)); return { lotId: l.id, lotNumber: l.lotNumber, batchNumber: l.batchNumber, quantity, unitCost: l.unitCost, taxPercent: l.taxPercent }; }).filter((a: any) => a.quantity > 0);
    return { lots, allocations, availableQty: round(lots.reduce((s: number, l: any) => s + l.availableQty, 0)), allocatedQty: round(input.quantity - remaining), pendingQty: remaining, unit, showCost };
  }
  /** Persist proposals using existing per-lot invoice lines; never reserve or issue here. */
  static async prepareInvoiceItems(tx: any, items: any[], franchiseId: string | null, pendingConfirmed = false) {
    const claims = new Map<string, number>();
    const result: any[] = [];
    for (const line of items) {
      const quantity = Number(line.qty ?? line.quantity);
      if (!line.productId) { if (line.inventoryBatchId || line.lotAllocations?.length) throw new Error('Select a SKU before selecting lots.'); result.push(line); continue; }
      const options = await this.options(tx, { productId: line.productId, quantity, unit: line.unit, franchiseId, warehouseId: line.warehouseId }, true);
      const product = await tx.product.findUnique({ where: { id: line.productId } });
      const item = await tx.inventoryItem.findFirst({ where: { ...(product?.sku ? { sku: product.sku } : { id: line.productId }), category: 'FINISHED_GOOD', ...(await scopeWhere(tx, franchiseId)) } });
      const factor = item ? (await InventoryService.convertUnitToBase(item.id, line.unit || item.unit, 1, tx)).requiredBaseQty : 1;
      const explicit = line.lotAllocations !== undefined;
      if (explicit && !Array.isArray(line.lotAllocations)) throw new Error('Invalid lot allocations.');
      let choices = explicit ? line.lotAllocations : line.inventoryBatchId ? [{ lotId: line.inventoryBatchId, quantity }] : [];
      if (!explicit && !line.inventoryBatchId && options.lots.length === 1) {
        const lot = options.lots[0];
        const take = Math.min(quantity, Math.max(0, lot.availableQty - (claims.get(lot.id) || 0) / factor));
        if (take > 0) choices = [{ lotId: lot.id, quantity: take }];
      }
      let selected = 0;
      for (const choice of choices) {
        const amount = Number(choice.quantity);
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('Lot quantities must be positive, finite numbers.');
        selected += amount;
        if (selected > quantity + 0.0001) throw new Error('Selected lot quantity exceeds the invoice quantity.');
        const lot = options.lots.find((l: any) => l.id === choice.lotId);
        const claimed = (claims.get(choice.lotId) || 0) + amount * factor;
        if (!lot || claimed > lot.availableQty * factor + 0.0001) throw new Error('Selected lot is unavailable, belongs to another SKU or warehouse, or exceeds availability. Select lots again.');
        claims.set(choice.lotId, claimed);
        result.push({ ...line, lotAllocations: undefined, qty: undefined, quantity: amount, discountAmount: line.discountAmount == null ? undefined : line.discountAmount * amount / quantity, inventoryBatchId: lot.id, batchNumber: lot.batchNumber });
      }
      const pending = Math.max(0, quantity - selected);
      if (pending > 0.0001) {
        if ((options.lots.length > 1 || (explicit && !choices.length && options.lots.length > 0)) && !pendingConfirmed) throw new Error('Confirm unallocated quantities as pending fulfilment, or select stock lots.');
        result.push({ ...line, lotAllocations: undefined, qty: undefined, quantity: pending, discountAmount: line.discountAmount == null ? undefined : line.discountAmount * pending / quantity, inventoryBatchId: null, batchNumber: '' });
      }
    }
    return result;
  }
  static async isDeferred(tx: any, orderId: string) {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { inventory_deducted: true } });
    if (!order) throw new Error('Source invoice not found.');
    if (!order.inventory_deducted) return true;
    const ids = (await tx.deliveryChallan.findMany({ where: { sourceInvoiceId: orderId }, select: { id: true } })).map((c: any) => c.id);
    return !!(ids.length && await tx.stockMovement.count({ where: { referenceType: REF, referenceId: { in: ids } } }));
  }
  static async state(tx: any, orderId: string, excludeId?: string) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { orderItems: { include: { product: true } } } });
    if (!order) throw new Error('Invoice not found.');
    const challans = await tx.deliveryChallan.findMany({ where: { sourceInvoiceId: orderId, status: { in: ACTIVE }, ...(excludeId ? { id: { not: excludeId } } : {}) }, include: { items: true } });
    const sourceItems = new Map<string, any>();
    const base = async (productId: string, unit: string, quantity: number) => {
      if (!sourceItems.has(productId)) { const p = await tx.product.findUnique({ where: { id: productId } }); sourceItems.set(productId, p?.sku ? await tx.inventoryItem.findFirst({ where: { sku: p.sku, ...(await scopeWhere(tx, order.franchiseId)) } }) : null); }
      const item = sourceItems.get(productId); return item ? (await InventoryService.convertUnitToBase(item.id, unit || 'NONE', quantity, tx)).requiredBaseQty : quantity;
    };
    const dispatched = new Map<string, number>();
    for (const dc of challans) for (const line of dc.items) if (line.productId) dispatched.set(line.productId, (dispatched.get(line.productId) || 0) + await base(line.productId, line.unit, line.quantity));
    const lines: any[] = [];
    for (const line of order.orderItems) {
      const required = await base(line.productId, line.unit, line.quantity);
      const factor = line.quantity > 0 ? required / line.quantity : 1;
      const fulfilledBase = order.inventory_deducted ? required : Math.min(required, dispatched.get(line.productId) || 0);
      dispatched.set(line.productId, Math.max(0, (dispatched.get(line.productId) || 0) - fulfilledBase));
      lines.push({ orderItemId: line.id, productId: line.productId, productName: line.product?.name || 'Item', unit: line.unit, quantity: line.quantity, fulfilledQty: round(fulfilledBase / factor), pendingQty: round(Math.max(0, required - fulfilledBase) / factor), requiredBase: required, fulfilledBase, factor, netUnitPrice: line.price * (1 - (line.discountPct || 0) / 100), totalCost: line.totalCost });
    }
    return { status: lines.every(l => l.pendingQty <= 0.0001) ? 'FULFILLED' : lines.some(l => l.fulfilledQty > 0.0001) ? 'PARTIALLY_FULFILLED' : 'PENDING', lines };
  }
  static async snapshotItems(tx: any, orderId: string, lines: any[], sellerId?: string | null) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { orderItems: true } });
    if (!order || (sellerId && sellerId !== order.franchiseId)) throw new Error('Dispatch seller does not match the source invoice.');
    return Promise.all(lines.map(async line => {
      const original = order.orderItems.find((l: any) => l.productId === line.productId);
      if (!original) throw new Error('Dispatch SKU is not on the source invoice.');
      const product = await tx.product.findUnique({ where: { id: line.productId } });
      const item = product?.sku ? await tx.inventoryItem.findFirst({ where: { sku: product.sku, ...(await scopeWhere(tx, order.franchiseId)) } }) : null;
      const originalFactor = item ? (await InventoryService.convertUnitToBase(item.id, original.unit || 'NONE', 1, tx)).requiredBaseQty : 1;
      const dispatchFactor = item ? (await InventoryService.convertUnitToBase(item.id, line.unit || 'NONE', 1, tx)).requiredBaseQty : 1;
      const net = original.price * (1 - (original.discountPct || 0) / 100);
      const taxable = original.price * original.quantity * (1 - (original.discountPct || 0) / 100);
      return { ...line, rate: net * dispatchFactor / originalFactor, taxPercent: taxable > 0 ? (original.taxAmount || 0) / taxable * 100 : 0 };
    }));
  }
  static async dispatch(tx: any, challan: any, userId: string) {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${challan.sourceInvoiceId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: challan.sourceInvoiceId }, include: { invoice: true } });
    if (!order || order.status === 'CANCELLED' || order.invoice?.status === 'CANCELLED') throw new Error('Source invoice is cancelled or missing.');
    if ((order.partyType === 'CUSTOMER' && order.customerId && order.customerId !== challan.customerId) || (order.partyType === 'DEALER' && order.partyId !== challan.dealerId) || (order.partyType === 'FRANCHISE' && order.partyId !== challan.franchiseId)) throw new Error('Dispatch destination does not match the source invoice.');
    if (challan.sourceFranchiseId && challan.sourceFranchiseId !== order.franchiseId) throw new Error('Dispatch seller does not match the source invoice.');
    if (await tx.stockMovement.count({ where: { referenceType: REF, referenceId: challan.id } })) return;
    // The current challan is already IN_TRANSIT inside this transaction: exclude it while measuring prior fulfilment.
    const state = await this.stateExcluding(tx, order.id, challan.id);
    const remaining = new Map<string, number>();
    for (const line of state.lines) remaining.set(line.productId, (remaining.get(line.productId) || 0) + line.pendingQty * line.factor);
    for (const line of challan.items) {
      if (!line.productId) throw new Error('An invoice dispatch must reference an invoiced SKU.');
      const p = await tx.product.findUnique({ where: { id: line.productId } });
      const item = p?.sku ? await tx.inventoryItem.findFirst({ where: { sku: p.sku, ...(await scopeWhere(tx, order.franchiseId)) } }) : null;
      if (!item) throw new Error('No stock is available for ' + line.productName + '.');
      await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${item.id} FOR UPDATE`;
      const factor = (await InventoryService.convertUnitToBase(item.id, line.unit || 'NONE', 1, tx)).requiredBaseQty;
      const required = line.quantity * factor;
      if (!(required > 0) || required > (remaining.get(line.productId) || 0) + 0.0001) throw new Error('Dispatch quantity exceeds the outstanding invoice quantity for ' + line.productName + '.');
      const suggestion = await this.options(tx, { productId: line.productId, quantity: line.quantity, unit: line.unit, franchiseId: order.franchiseId }, true);
      if (suggestion.availableQty + 0.0001 < line.quantity) throw new Error('Stock changed or is insufficient for ' + line.productName + '. Refresh the lot allocation before dispatch.');
      if (!line.inventoryBatchId && suggestion.lots.length > 1) throw new Error('Multiple stock lots are available. Select lots before dispatch.');
      const choices = line.inventoryBatchId ? [{ lotId: line.inventoryBatchId, quantity: line.quantity }] : suggestion.allocations;
      let cost = 0;
      for (const choice of choices) {
        if (!suggestion.lots.some((l: any) => l.id === choice.lotId && l.availableQty + 0.0001 >= choice.quantity)) throw new Error('Selected lot is no longer available. Refresh the lot allocation.');
        const issued = await InventoryService.depleteLot(tx, item.id, choice.lotId, choice.quantity * factor);
        cost += issued.totalCost;
        await InventoryService.recordMovement(tx, { itemId: item.id, type: 'SALES_OUT', quantity: -choice.quantity, baseQty: -choice.quantity * factor, transactionUnit: line.unit, referenceType: REF, referenceId: challan.id, warehouseId: (await tx.inventoryBatch.findUnique({ where: { id: choice.lotId }, select: { warehouseId: true } }))?.warehouseId || undefined, userId, note: 'Invoice fulfilment ' + order.invoiceNum, precalculatedFifo: issued });
      }
      await tx.deliveryChallanItem.update({ where: { id: line.id }, data: { lotUnitCost: line.quantity > 0 ? cost / line.quantity : null } });
      let toAssign = required;
      for (const invoiceLine of state.lines.filter((l: any) => l.productId === line.productId)) {
        const take = Math.min(toAssign, invoiceLine.pendingQty * invoiceLine.factor);
        if (take <= 0) continue;
        await tx.orderItem.update({ where: { id: invoiceLine.orderItemId }, data: { totalCost: { increment: cost * take / required }, unitCost: null } });
        invoiceLine.pendingQty -= take / invoiceLine.factor; toAssign -= take;
      }
      remaining.set(line.productId, (remaining.get(line.productId) || 0) - required);
    }
    const after = await this.state(tx, order.id);
    await tx.order.update({ where: { id: order.id }, data: { inventory_deducted: after.status === 'FULFILLED' } });
  }
  static async stateExcluding(tx: any, orderId: string, excludeId: string) {
    // Reuse the read projection with an adapter that excludes the not-yet-posted current challan.
    return this.state(tx, orderId, excludeId);
  }
  static async reverse(tx: any, challan: any, userId: string): Promise<boolean> {
    const movements = await tx.stockMovement.findMany({ where: { referenceType: REF, referenceId: challan.id, quantity: { lt: 0 } } });
    if (!movements.length) return false;
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${challan.sourceInvoiceId} FOR UPDATE`;
    if (await tx.stockMovement.count({ where: { referenceType: REF + '_REVERSAL', referenceId: challan.id } })) return true;
    for (const m of movements) await InventoryService.restoreToBatches(tx, { itemId: m.itemId, allocation: [{ batchId: m.batchId, qty: Math.abs(m.baseQty ?? m.quantity), unitCost: m.unitCost || 0 }], movementType: 'SALES_RETURN_IN', referenceType: REF + '_REVERSAL', referenceId: challan.id, warehouseId: m.warehouseId, userId });
    await tx.order.update({ where: { id: challan.sourceInvoiceId }, data: { inventory_deducted: false } });
    // Remove only the cancelled dispatch's actual costs, distributed over its invoiced SKU lines.
    const lines = await tx.orderItem.findMany({ where: { orderId: challan.sourceInvoiceId } });
    const reversed = new Map<string, number>();
    for (const line of challan.items) reversed.set(line.productId, (reversed.get(line.productId) || 0) + (line.lotUnitCost || 0) * line.quantity);
    for (const [productId, reversalCost] of reversed) {
      const matches = lines.filter((l: any) => l.productId === productId); const total = matches.reduce((s: number, l: any) => s + (l.totalCost || 0), 0);
      for (const l of matches) await tx.orderItem.update({ where: { id: l.id }, data: { totalCost: Math.max(0, (l.totalCost || 0) - (total > 0 ? reversalCost * (l.totalCost || 0) / total : 0)) } });
    }
    return true;
  }
}
