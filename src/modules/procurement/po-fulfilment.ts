/**
 * Purchase Order receipt (fulfilment) state, per PO line.
 *
 * Single source of truth for "how much of this PO line has been received and
 * how much is still pending". Used by GRN creation, GRN posting, GRN-rejection
 * return completion, short-close and the PO summary / pending-items APIs, so
 * all of them agree.
 *
 *   receivedQty = accepted qty on POSTED (COMPLETED) GRNs
 *               + qty of COMPLETED GRN-rejection purchase returns
 *                 (rejected goods count as fulfilled only once returned),
 *                 capped at what is still open after the accepted qty
 *   pendingQty  = orderedQty - receivedQty        (0 once short-closed)
 *
 * The undelivered balance of a partial delivery is simply pendingQty. It is
 * never turned into a purchase return.
 *
 * Draft (PENDING) GRNs do not consume pendingQty; they are reported as
 * draftQty, and posting re-validates against pendingQty under the row locks.
 */
import { isPOReceiptEligible } from './po-receipt-status';

const EPS = 0.0001;
const round = (n: number) => Number(n.toFixed(4));

export interface POLineFulfilment {
  poItemId: string;
  materialId: string | null;
  productId: string | null;
  itemName: string | null;
  unit: string;
  orderedQty: number;
  acceptedQty: number;   // accepted on posted GRNs
  rejectedQty: number;   // rejected on posted GRNs (QC)
  returnedQty: number;   // rejected qty counted as fulfilled via completed returns
  receivedQty: number;   // fulfilled = accepted + returned (capped)
  pendingQty: number;    // still receivable
  draftQty: number;      // on PENDING (draft) GRNs, not yet posted
}

export interface POFulfilment {
  po: any;
  lines: POLineFulfilment[];
  totals: { orderedQty: number; receivedQty: number; pendingQty: number; acceptedQty: number; rejectedQty: number; draftQty: number };
  shortClosed: boolean;
  shortClosedQty: number;
  fullyReceived: boolean;
}

/** Statuses the receipt flow may move forward (never DRAFT/CLOSED/CANCELLED/billing states). */
const RECEIPT_PROGRESS_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'ORDERED', 'SENT', 'PARTIALLY_RECEIVED'];

/**
 * Row-level locks for a receipt against a PO: the PO row first, then every
 * PO line in id order (a stable order, so concurrent lockers cannot deadlock).
 * Must be taken before pendingQty is read for validation. Re-entrant within
 * the same transaction. Returns false when the PO does not exist.
 */
export async function lockPOForReceipt(tx: any, poId: string): Promise<boolean> {
  const locked: any[] = await tx.$queryRaw`SELECT id FROM "ProcurementOrder" WHERE id = ${poId} FOR UPDATE`;
  if (!locked.length) return false;
  await tx.$queryRaw`SELECT id FROM "ProcurementOrderItem" WHERE "poId" = ${poId} ORDER BY id FOR UPDATE`;
  return true;
}

/**
 * Resolve which PO line a GRN line belongs to: its poItemId when set, else
 * (legacy rows written before poItemId existed) the first PO line with the
 * same material.
 */
export function resolvePOLine<T extends { id: string; inventoryItemId: string | null }>(
  poItems: T[], grnItem: { poItemId?: string | null; materialId?: string | null }
): T | undefined {
  if (grnItem.poItemId) return poItems.find(p => p.id === grnItem.poItemId);
  if (!grnItem.materialId) return undefined;
  return poItems.find(p => p.inventoryItemId === grnItem.materialId);
}

export async function computePOFulfilment(tx: any, poId: string, opts: { excludeGrnId?: string } = {}): Promise<POFulfilment | null> {
  const po = await tx.procurementOrder.findUnique({
    where: { id: poId },
    include: { vendor: { select: { id: true, name: true } }, poItems: { include: { inventoryItem: { select: { name: true, unit: true } } } } }
  });
  if (!po) return null;
  // Stable line order (the order lines were created in has no timestamp).
  const poItems: any[] = [...po.poItems].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const [grnItems, completedReturns] = await Promise.all([
    tx.goodsReceiptItem.findMany({
      where: {
        grn: {
          poId,
          status: { in: ['COMPLETED', 'PENDING'] },
          ...(opts.excludeGrnId ? { id: { not: opts.excludeGrnId } } : {})
        }
      },
      select: { poItemId: true, materialId: true, receivedQty: true, acceptedQty: true, rejectedQty: true, grn: { select: { status: true } } }
    }),
    tx.purchaseReturn.findMany({
      where: { procurementOrderId: poId, returnSource: 'GRN_REJECTION', status: 'COMPLETED' },
      select: { items: { select: { itemName: true, quantity: true } } }
    })
  ]);

  const acc = new Map<string, { accepted: number; rejected: number; draft: number; returned: number }>();
  for (const p of poItems) acc.set(p.id, { accepted: 0, rejected: 0, draft: 0, returned: 0 });

  for (const gi of grnItems) {
    const line = resolvePOLine(poItems, gi);
    if (!line) continue;
    const a = acc.get(line.id)!;
    if (gi.grn.status === 'COMPLETED') {
      a.accepted += gi.acceptedQty || 0;
      a.rejected += gi.rejectedQty || 0;
    } else {
      a.draft += gi.receivedQty || 0;
    }
  }

  // Completed GRN-rejection returns are keyed by line name (that is what the
  // return document stores; see PurchaseService.createGrnRejectionReturn).
  const lineByName = new Map<string, string>();
  for (const p of poItems) {
    const key = (p.itemName || p.inventoryItem?.name || '').toLowerCase().trim();
    if (key && !lineByName.has(key)) lineByName.set(key, p.id);
  }
  for (const r of completedReturns) {
    for (const item of r.items) {
      const lineId = lineByName.get((item.itemName || '').toLowerCase().trim());
      if (lineId) acc.get(lineId)!.returned += item.quantity || 0;
    }
  }

  const shortClosed = Boolean(po.shortClosedAt);
  let shortClosedQty = 0;
  const lines: POLineFulfilment[] = poItems.map(p => {
    const a = acc.get(p.id)!;
    const ordered = p.quantity || 0;
    const returnedCounted = Math.min(Math.max(0, ordered - a.accepted), a.returned);
    const received = Math.min(ordered, a.accepted + returnedCounted);
    const open = Math.max(0, ordered - received);
    if (shortClosed) shortClosedQty += open;
    return {
      poItemId: p.id,
      materialId: p.inventoryItemId,
      productId: p.productId || null,
      itemName: p.itemName || p.inventoryItem?.name || null,
      unit: p.unit || p.inventoryItem?.unit || 'UNIT',
      orderedQty: round(ordered),
      acceptedQty: round(a.accepted),
      rejectedQty: round(a.rejected),
      returnedQty: round(returnedCounted),
      receivedQty: round(received),
      pendingQty: shortClosed ? 0 : round(open < EPS ? 0 : open),
      draftQty: round(a.draft),
    };
  });

  const sum = (k: keyof POLineFulfilment) => round(lines.reduce((s, l) => s + (l[k] as number), 0));
  const totals = {
    orderedQty: sum('orderedQty'),
    receivedQty: sum('receivedQty'),
    pendingQty: sum('pendingQty'),
    acceptedQty: sum('acceptedQty'),
    rejectedQty: sum('rejectedQty'),
    draftQty: sum('draftQty'),
  };
  return {
    po,
    lines,
    totals,
    shortClosed,
    shortClosedQty: round(shortClosedQty),
    fullyReceived: lines.length > 0 && lines.every(l => l.pendingQty <= EPS),
  };
}

/**
 * Persist the receipt state: write receivedQty / pendingQty on every PO line
 * and move the PO status forward:
 *   all lines pending 0           -> RECEIVED (fully received; closed for receipt)
 *   something received, some open -> PARTIALLY_RECEIVED
 *   nothing received              -> unchanged (APPROVED / SENT ...)
 * Only receipt-progress statuses are moved. DRAFT, CANCELLED, CLOSED and
 * billing states are never touched here. CLOSED stays the finance step
 * (fully received AND fully paid), set by the payment paths.
 * Takes the PO + PO-line row locks itself (re-entrant in the caller's tx).
 */
export async function syncPOReceiptState(tx: any, poId: string): Promise<POFulfilment | null> {
  if (!(await lockPOForReceipt(tx, poId))) return null;
  const f = await computePOFulfilment(tx, poId);
  if (!f) return null;

  const stored = new Map<string, any>(f.po.poItems.map((p: any) => [p.id, p]));
  for (const line of f.lines) {
    const cur = stored.get(line.poItemId);
    if (cur && Math.abs((cur.receivedQty || 0) - line.receivedQty) < EPS && Math.abs((cur.pendingQty || 0) - line.pendingQty) < EPS) continue;
    await tx.procurementOrderItem.update({ where: { id: line.poItemId }, data: { receivedQty: line.receivedQty, pendingQty: line.pendingQty } });
  }

  if (RECEIPT_PROGRESS_STATUSES.includes(f.po.status) && !f.shortClosed) {
    const anyReceived = f.lines.some(l => l.receivedQty > EPS);
    const next = f.fullyReceived ? 'RECEIVED' : anyReceived ? 'PARTIALLY_RECEIVED' : f.po.status;
    if (next !== f.po.status || (f.fullyReceived && !f.po.received)) {
      await tx.procurementOrder.update({ where: { id: poId }, data: { status: next, received: f.fullyReceived } });
      f.po.status = next;
      f.po.received = f.fullyReceived;
    }
  }
  return f;
}

/** Spec-facing PO receipt status, mapped from the existing POStatus values. */
export function poReceiptStatus(status: string): 'DRAFT' | 'SENT' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED' | 'CLOSED' | 'CANCELLED' {
  switch (status) {
    case 'DRAFT': return 'DRAFT';
    case 'PARTIALLY_RECEIVED': return 'PARTIALLY_RECEIVED';
    case 'RECEIVED': case 'INVOICED': case 'PAID': return 'FULLY_RECEIVED';
    case 'CLOSED': return 'CLOSED';
    case 'CANCELLED': return 'CANCELLED';
    default: return 'SENT'; // PENDING_APPROVAL / APPROVED / ORDERED / SENT: issued, awaiting receipt
  }
}

/** Spec-facing GRN status, mapped from the existing GRNStatus values. */
export function grnDisplayStatus(status: string): 'DRAFT' | 'POSTED' | 'CANCELLED' | 'REJECTED' {
  switch (status) {
    case 'COMPLETED': return 'POSTED';
    case 'CANCELLED': return 'CANCELLED';
    case 'REJECTED': return 'REJECTED';
    default: return 'DRAFT';
  }
}

/** Why a PO cannot take a new GRN, or null when it can. */
export function receiptBlockReason(po: { status: string; shortClosedAt?: Date | null }, fullyReceived: boolean): string | null {
  if (po.status === 'CANCELLED') return 'This Purchase Order is cancelled. New GRNs are not allowed.';
  if (po.status === 'CLOSED') return 'This Purchase Order is closed. New GRNs are not allowed.';
  if (po.shortClosedAt) return 'This Purchase Order was short-closed. The undelivered balance was cancelled.';
  if (po.status === 'DRAFT') return 'This Purchase Order is still a draft. Complete it before receiving goods.';
  if (fullyReceived || po.status === 'RECEIVED') return 'All quantities for this Purchase Order have been received.';
  if (!isPOReceiptEligible(po.status)) return `A Purchase Order in status ${po.status} cannot be received.`;
  return null;
}
