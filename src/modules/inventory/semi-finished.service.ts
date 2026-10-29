import prisma from '../../lib/prisma';
import { InventoryService } from './inventory.service';
import { scopeWhere } from '../sales/lot-pricing.service';
import { canViewCost } from '../sales/profitability';
import { ProductionFlags, PACKAGEABLE_QC_STATUSES } from '../production/production.flags';
import { isLotExpired } from './lot-eligibility';
import { expiryStatusOf } from './expiry-tracking.service';

type User = { role?: string; franchiseId?: string | null } | null | undefined;
type Filters = { search?: string; sourceType?: string; warehouseId?: string; expiryStatus?: string; franchiseId?: string; lotId?: string };
const round = (n: number) => Math.round(n * 10000) / 10000;
const date = (d: any): string | null => d ? new Date(d).toISOString() : null;

/** Read projection of existing bulk lots; it never posts or duplicates inventory. */
export function shapeBulkLot(lot: any, packagedQty: number, reservedQty: number, showCost: boolean, now = new Date()) {
  const batch = lot.productBatch;
  const recipe = batch?.production?.recipe;
  const item = lot.inventoryItem;
  const remainingQty = Math.max(0, Number(lot.currentQty) || 0);
  const expiryDate = [lot.expDate, batch?.expiryDate, batch?.production?.expiryDate].filter(Boolean).map(d => new Date(d)).sort((a, b) => a.getTime() - b.getTime())[0];
  const expiryStatus = expiryDate ? expiryStatusOf(expiryDate, now) : 'VALID';
  const recall = batch?.recall?.status;
  let status = 'READY';
  if (isLotExpired(expiryDate, now)) status = 'EXPIRED';
  else if (recall === 'IN_PROGRESS' || recall === 'COMPLETED') status = 'BLOCKED';
  else if (lot.status !== 'APPROVED') status = lot.status;
  else if (!batch) status = 'SOURCE_UNAVAILABLE';
  else if (batch.packagingStatus === 'PACKAGED') status = 'FULLY_PROCESSED';
  else if (!PACKAGEABLE_QC_STATUSES.includes(batch.qcStatus || '') && !(lot.unreleased && !ProductionFlags.qcEnabled)) status = 'PENDING_QC';
  const availableQty = status === 'READY' ? Math.max(0, remainingQty - reservedQty) : 0;
  const purchased = batch?.sourceType === 'PURCHASE' || !!lot.goodsReceiptItemId;
  const familyId = recipe?.id || item.id;
  const unitCost = lot.unitCost == null ? null : Number(lot.unitCost);
  return {
    id: lot.id, inventoryItemId: item.id, productBatchId: batch?.id || null,
    familyId, familyCode: recipe?.recipeCode || item.sku,
    productName: recipe?.name || item.name.replace(/\s*-\s*Bulk$/i, ''),
    lotNumber: lot.lotNumber || lot.batchNumber, sourceBatchCode: batch?.batchCode || null,
    sourceType: purchased ? 'PURCHASE' : 'MANUFACTURED',
    warehouse: lot.warehouse || batch?.warehouse || batch?.production?.warehouse || null,
    originalQty: Number(lot.initialQty), packagedQty: round(packagedQty), remainingQty: round(remainingQty), reservedQty: round(reservedQty), availableQty: round(availableQty),
    unit: String(item.unit || recipe?.yieldUnit || 'KG').toUpperCase(),
    unitCost: showCost ? unitCost : undefined,
    remainingValue: showCost ? (unitCost == null ? null : round(remainingQty * unitCost)) : undefined,
    productionDate: purchased ? date(lot.receivedAt || lot.createdAt || batch?.createdAt) : date(lot.mfgDate || batch?.mfgDate || batch?.createdAt || lot.createdAt),
    expiryDate: date(expiryDate), expiryStatus, status,
    supplier: batch?.vendor?.name || lot.vendor?.name || null,
    purchaseOrderId: batch?.procurementOrderId || lot.procurementOrderId || null,
    purchaseOrderNumber: batch?.procurementOrder?.poNumber || null,
    goodsReceiptId: batch?.goodsReceiptId || lot.goodsReceiptItem?.grnId || null,
    franchiseId: batch?.franchiseId || item.franchiseId || null,
    unreleased: !!lot.unreleased,
    packagingUrl: batch ? '/packaging?' + new URLSearchParams({ batchId: batch.id, ...(lot.unreleased ? {} : { bulkLotId: lot.id }), ...(batch.franchiseId ? { franchiseId: batch.franchiseId } : {}) }).toString() : null,
  };
}
export type SemiFinishedRow = ReturnType<typeof shapeBulkLot>;
export function summarizeBulk(rows: SemiFinishedRow[]) {
  const active = rows.filter(r => r.availableQty > 0.0001);
  const totals = (source?: string) => {
    const byUnit: Record<string, number> = {};
    for (const r of active) if (!source || r.sourceType === source) byUnit[r.unit] = round((byUnit[r.unit] || 0) + r.availableQty);
    return byUnit;
  };
  return { productFamilies: new Set(rows.map(r => r.familyId)).size, availableByUnit: totals(), activeLots: active.length,
    manufacturedByUnit: totals('MANUFACTURED'), purchasedByUnit: totals('PURCHASE'), expiringSoonLots: rows.filter(r => r.expiryStatus === 'EXPIRING_SOON').length };
}

export class SemiFinishedService {
  static async list(filters: Filters, user: User) {
    const showCost = canViewCost(user);
    if (user?.role !== 'SUPER_ADMIN' && !user?.franchiseId) return { rows: [], summary: summarizeBulk([]), warehouses: [], showCost };
    const branch = user?.role === 'SUPER_ADMIN' ? filters.franchiseId : user?.franchiseId;
    const scope = branch ? await scopeWhere(prisma, branch) : {};
    return prisma.$transaction(async tx => {
    const batchInclude = { product: true, production: { include: { recipe: true, warehouse: true } }, warehouse: true, recall: true, vendor: true, procurementOrder: { select: { poNumber: true } }, packagings: true } as const;
    const lots = await tx.inventoryBatch.findMany({
      where: { productPackagingId: null, currentQty: { gt: 0.0001 }, inventoryItem: { category: 'SEMI_FINISHED', ...scope } },
      include: { inventoryItem: true, warehouse: true, vendor: true, goodsReceiptItem: { select: { grnId: true } }, productBatch: { include: batchInclude } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const reserved = await InventoryService.reservedQtyByLot(tx, lots.map(l => l.id));
    const confirmed = await tx.productPackaging.findMany({
      where: { status: 'CONFIRMED', ...(branch ? { batch: { franchiseId: branch } } : {}) }, select: { batchId: true, totalWeight: true, bulkBreakdown: true },
    });
    const packaged = new Map<string, number>();
    const legacy = new Map<string, number>();
    for (const ticket of confirmed) {
      const layers = Array.isArray(ticket.bulkBreakdown) ? ticket.bulkBreakdown as any[] : [];
      if (!layers.length) legacy.set(ticket.batchId, (legacy.get(ticket.batchId) || 0) + ticket.totalWeight);
      for (const layer of layers) packaged.set(layer.batchId, (packaged.get(layer.batchId) || 0) + (Number(layer.qty) || 0));
    }
    const lotCounts = new Map<string, number>();
    for (const lot of lots) if (lot.productBatchId) lotCounts.set(lot.productBatchId, (lotCounts.get(lot.productBatchId) || 0) + 1);
    let rows = lots.map(l => shapeBulkLot(l, (packaged.get(l.id) || 0) + (lotCounts.get(l.productBatchId || '') === 1 ? legacy.get(l.productBatchId || '') || 0 : 0), reserved.get(l.id) || 0, showCost));
    // Completed legacy batches still awaiting the existing auto-release have physical output, but no ledger lot yet.
    // Project them once; Packaging's existing release transaction creates their lot on confirmation.
    if (!ProductionFlags.qcEnabled) {
      const pending = await tx.productBatch.findMany({ where: { qcStatus: 'PENDING', quantity: { gt: 0 }, production: { status: 'COMPLETED' }, inventoryBatches: { none: {} }, ...(branch ? { franchiseId: branch } : {}) }, include: batchInclude });
      for (const b of pending) {
        const pendingQty = b.packagings.filter(p => p.status === 'AWAITING_CONFIRMATION').reduce((s, p) => s + p.totalWeight, 0);
        const remaining = Math.max(0, b.quantity - (b.packagedQty || 0) - pendingQty);
        if (remaining <= 0.0001) continue;
        rows.push(shapeBulkLot({ id: 'batch:' + b.id, inventoryItem: { id: b.production?.recipeId || b.productId || b.id, name: b.product?.name || b.production?.recipe?.name || b.batchCode, sku: b.production?.recipe?.recipeCode || b.product?.sku || b.batchCode, unit: b.production?.recipe?.yieldUnit || 'KG', franchiseId: b.franchiseId }, productBatch: b, initialQty: b.quantity, currentQty: remaining, unitCost: (b.totalCost || b.production?.totalCost || b.production?.materialCost || 0) / b.quantity, batchNumber: b.batchCode, status: 'APPROVED', unreleased: true }, b.packagedQty || 0, 0, showCost));
      }
    }
    const warehouses = [...new Map(rows.filter(r => r.warehouse).map(r => [r.warehouse!.id, { id: r.warehouse!.id, name: r.warehouse!.name }])).values()];
    const q = String(filters.search || '').trim().toLowerCase();
    rows = rows.filter(r => (!filters.lotId || r.id === filters.lotId) && (!filters.sourceType || r.sourceType === filters.sourceType) && (!filters.warehouseId || r.warehouse?.id === filters.warehouseId) && (!filters.expiryStatus || r.expiryStatus === filters.expiryStatus) && (!q || [r.productName, r.familyCode, r.familyId, r.lotNumber, r.sourceBatchCode, r.supplier, r.purchaseOrderNumber].some(v => v && String(v).toLowerCase().includes(q))));
    return { rows, summary: summarizeBulk(rows), warehouses, showCost };
    }, { isolationLevel: 'RepeatableRead' });
  }
}
