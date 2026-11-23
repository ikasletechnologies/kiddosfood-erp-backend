import prisma from '../../lib/prisma';
import { isPOReceiptEligible } from '../procurement/po-receipt-status';
import { purchaseLineTax } from '../procurement/purchase-tax';
import { InventoryService } from '../inventory/inventory.service';
import { ProcurementService } from '../procurement/procurement.service';
import { VendorInvoiceService } from '../vendor-invoices/vendor-invoices.service';
import { PurchaseService } from '../purchase/purchase.service';
import { AppError } from '../../middleware/error.middleware';
import { writeAuditLog, AuditActor } from '../../lib/audit-log';
import { resolveSellerState } from '../../utils/gst-tax.util';
import {
  computePOFulfilment, lockPOForReceipt, resolvePOLine, syncPOReceiptState,
  receiptBlockReason, poReceiptStatus, grnDisplayStatus
} from '../procurement/po-fulfilment';

const EPS = 0.0001;
// Create + post (stock, lots, bill) in one transaction can exceed Prisma's
// default 5 s interactive-transaction timeout on a busy database.
const GRN_TX_OPTIONS = { maxWait: 10000, timeout: 60000 };

export interface GRNLineInput {
  poItemId?: string;
  materialId?: string;
  productId?: string;
  purchaseOrderId?: string;
  poId?: string;
  orderedQty?: number;
  receivedQty: number;
  acceptedQty?: number;
  rejectedQty?: number;
  price?: number;
  priceOverrideReason?: string;
  qcStatus?: string;
  vendorBatchNo?: string;
  mfgDate?: string;
  expDate?: string;
  lotNumber?: string;
  warehouseId?: string;
  binId?: string;
}

export interface GRNCreateInput {
  grnNumber?: string;
  vendorId?: string;
  purchaseOrderId?: string;
  poId?: string;
  receivedAt?: string;
  receivedBy?: string;
  freightCost?: number;
  unloadingCost?: number;
  performedBy?: string;
  user?: any;
  items: GRNLineInput[];
}

export class GRNService {
  /**
   * Atomic sequence number — a row-level UPDATE...increment inside a
   * transaction serializes concurrent callers at the DB level, unlike
   * deriving a number from Date.now()/row counts (the previous batch number
   * used `Date.now().toString().slice(-4)`, which repeats every 10 seconds
   * and two GRNs approved in the same window collided).
   */
  private static async nextSequence(tx: any, key: string): Promise<number> {
    const seq = await tx.numberSequence.upsert({
      where: { key },
      create: { key, value: 1 },
      update: { value: { increment: 1 } }
    });
    return seq.value;
  }

  /**
   * Preview lot number for the "Auto Batch" control on the New GRN form.
   * Reads the current sequence state without consuming/incrementing it.
   */
  static async generateLotNumber(): Promise<string> {
    const seq = await prisma.numberSequence.findUnique({
      where: { key: 'GRN_LOT' }
    });
    const nextVal = (seq?.value || 0) + 1;
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    return `LOT-${ymd}-${String(nextVal).padStart(5, '0')}`;
  }

  static async getAll(params: { poId?: string; status?: string; startDate?: string; endDate?: string; fromDate?: string; toDate?: string } = {}) {
    const from = params.fromDate || params.startDate;
    const to = params.toDate || params.endDate;
    const dateFilter: any = {};
    if (from || to) {
      dateFilter.receivedAt = {};
      if (from) dateFilter.receivedAt.gte = new Date(from);
      if (to) {
        const toD = new Date(to);
        toD.setHours(23, 59, 59, 999);
        dateFilter.receivedAt.lte = toD;
      }
    }
    return prisma.goodsReceipt.findMany({
      where: {
        ...(params.poId ? { poId: params.poId } : {}),
        ...(params.status ? { status: params.status as any } : {}),
        ...dateFilter
      },
      include: {
        procurementOrder: { include: { vendor: true, poItems: true } },
        items: { include: { inventoryItem: true, warehouse: true, warehouseBin: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string) {
    return prisma.goodsReceipt.findUnique({
      where: { id },
      include: {
        procurementOrder: { include: { vendor: true, poItems: { include: { inventoryItem: true } } } },
        items: { include: { inventoryItem: true, warehouse: true, warehouseBin: true } }
      }
    });
  }

  /**
   * Remaining receivable quantity per PO line, for the New Receipt screen
   * (legacy shape, kept for GET /api/grn/po/:poId/remaining). Same numbers as
   * GET /api/purchase-orders/:poId/pending-items; see po-fulfilment.ts.
   * Read-only and advisory: creation and posting re-validate under row locks.
   */
  static async getRemainingQuantities(poId: string) {
    const f = await computePOFulfilment(prisma, poId);
    if (!f) throw new AppError('Purchase Order not found', 404);
    return f.lines.map(l => ({
      poItemId: l.poItemId,
      materialId: l.materialId,
      productId: l.productId,
      itemName: l.itemName,
      unit: l.unit,
      ordered: l.orderedQty,
      previouslyReceived: l.receivedQty,
      remaining: l.pendingQty
    }));
  }

  /** GRNs recorded against one PO, newest first, with per-GRN totals. */
  static async getGRNsForPO(poId: string) {
    const po = await prisma.procurementOrder.findUnique({ where: { id: poId }, select: { id: true } });
    if (!po) throw new AppError('Purchase Order not found', 404);
    const grns = await prisma.goodsReceipt.findMany({
      where: { poId },
      include: {
        vendor: { select: { id: true, name: true } },
        items: { include: { inventoryItem: { select: { name: true, unit: true } }, poItem: { select: { id: true, itemName: true } } } }
      },
      orderBy: { createdAt: 'desc' }
    });
    return grns.map(g => ({
      ...g,
      displayStatus: grnDisplayStatus(g.status),
      totalReceivedQty: Number(g.items.reduce((s, i) => s + (i.receivedQty || 0), 0).toFixed(4)),
      totalAcceptedQty: Number(g.items.reduce((s, i) => s + (i.acceptedQty || 0), 0).toFixed(4)),
      totalRejectedQty: Number(g.items.reduce((s, i) => s + (i.rejectedQty || 0), 0).toFixed(4))
    }));
  }

  /**
   * PO receipt summary: per-line ordered / received / pending, totals, the
   * PO's GRNs, and whether a new GRN may be created (with the reason if not).
   */
  static async getPOSummary(poId: string) {
    const f = await computePOFulfilment(prisma, poId);
    if (!f) throw new AppError('Purchase Order not found', 404);
    const grns = await this.getGRNsForPO(poId);
    const blockReason = receiptBlockReason(f.po, f.fullyReceived);
    return {
      poId: f.po.id,
      poNumber: f.po.poNumber,
      vendorId: f.po.vendorId,
      vendorName: f.po.vendor?.name || null,
      status: f.po.status,
      receiptStatus: poReceiptStatus(f.po.status),
      orderedAt: f.po.createdAt,
      shortClosed: f.shortClosed,
      shortClosedQty: f.shortClosedQty,
      canReceive: !blockReason,
      message: blockReason,
      totals: f.totals,
      lines: f.lines.map(l => ({ ...l, selectable: !blockReason && l.pendingQty > 0 })),
      grns
    };
  }

  /** Only the PO lines that still have pendingQty > 0. */
  static async getPendingItems(poId: string) {
    const f = await computePOFulfilment(prisma, poId);
    if (!f) throw new AppError('Purchase Order not found', 404);
    const blockReason = receiptBlockReason(f.po, f.fullyReceived);
    return {
      poId: f.po.id,
      poNumber: f.po.poNumber,
      vendorId: f.po.vendorId,
      status: f.po.status,
      receiptStatus: poReceiptStatus(f.po.status),
      canReceive: !blockReason,
      message: blockReason,
      items: blockReason ? [] : f.lines.filter(l => l.pendingQty > 0)
    };
  }
  /**
   * Authoritative backend scope validation for GRN warehouse assignments.
   * Ensures HQ users cannot receive goods into Franchise warehouses, and
   * Franchise users can only receive goods into their own assigned franchise warehouse.
   */
  private static async validateWarehouseScope(tx: any, warehouseId: string, user?: any): Promise<void> {
    if (!warehouseId) return;

    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      include: {
        primaryForFranchises: { select: { id: true, name: true, isHQ: true } }
      }
    });

    if (!warehouse) {
      throw new Error(`Warehouse with ID "${warehouseId}" not found`);
    }

    if (warehouse.status !== 'ACTIVE') {
      throw new Error(`Warehouse "${warehouse.name}" is inactive`);
    }

    if (!user) return; // Defensive fallback if call has no user payload

    const userRole = (user.role?.name || user.role || '').toUpperCase();
    const userFranchiseId = user.franchiseId;

    const nonHqOwners = (warehouse.primaryForFranchises || []).filter((f: any) => !f.isHQ);

    if (userRole === 'SUPER_ADMIN' || !userFranchiseId) {
      // HQ User Scope: Must NOT select a Franchise warehouse
      if (nonHqOwners.length > 0) {
        const ownerName = nonHqOwners[0].name;
        throw new Error(`HQ users cannot receive goods into Franchise warehouse "${warehouse.name}" (belonging to ${ownerName}). Please select an HQ warehouse.`);
      }
    } else {
      // Franchise User Scope: Must select their OWN franchise warehouse
      const isOwner = nonHqOwners.some((f: any) => f.id === userFranchiseId);
      if (!isOwner) {
        throw new Error(`Franchise users cannot receive goods into warehouse "${warehouse.name}". You can only receive goods into your own assigned franchise warehouse.`);
      }
    }
  }

  /** Next GRN number GRN-YYYY-NNNNN from the atomic GRN_<year> sequence. */
  private static async nextGrnNumber(tx: any): Promise<string> {
    const year = new Date().getFullYear();
    // A manually entered number may already occupy a generated value; skip it.
    for (let attempt = 0; attempt < 20; attempt++) {
      const seq = await this.nextSequence(tx, `GRN_${year}`);
      const candidate = `GRN-${year}-${String(seq).padStart(5, '0')}`;
      const taken = await tx.goodsReceipt.findUnique({ where: { grnNumber: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    throw new AppError('Could not allocate a GRN number. Please retry.', 409);
  }

  /**
   * Legacy create (POST /api/grn/from-po/:poId): creates a DRAFT (PENDING)
   * GRN; posting is a separate PATCH /api/grn/:id/approve. Lines with zero
   * received and zero rejected quantity are ignored (the old screen sends
   * every PO line). Same validation and locking as the new endpoint.
   */
  static async createFromPO(poId: string, data: GRNCreateInput) {
    return prisma.$transaction(tx => this.createDraftInTx(tx, poId, data, { strict: false }), GRN_TX_OPTIONS);
  }

  /**
   * POST /api/purchase-orders/:poId/grns. Creates the GRN against exactly one
   * PO and, unless `post` is false, posts it (stock, lots, vendor bill, PO
   * receipt counters and status) in the SAME transaction. Any failure rolls
   * back the GRN, the PO changes and the stock together.
   */
  static async receiveAgainstPO(poId: string, data: GRNCreateInput, opts: { post?: boolean; rejectionReason?: string; user?: any } = {}) {
    const post = opts.post !== false;
    if (post) {
      const role = String(opts.user?.role?.name || opts.user?.role || '').toUpperCase();
      if (opts.user && role !== 'SUPER_ADMIN') throw new AppError('Only a Super Admin can post a GRN. Save it as a draft instead.', 403);
    }
    const grnId = await prisma.$transaction(async tx => {
      const grn = await this.createDraftInTx(tx, poId, data, { strict: true });
      if (post) await this.approveInTx(tx, grn.id, opts.user, { rejectionReason: opts.rejectionReason });
      return grn.id;
    }, GRN_TX_OPTIONS);
    const [grn, summary] = await Promise.all([
      prisma.goodsReceipt.findUniqueOrThrow({
        where: { id: grnId },
        include: { vendor: { select: { id: true, name: true } }, items: { include: { inventoryItem: { select: { name: true, unit: true } } } } }
      }),
      this.getPOSummary(poId)
    ]);
    return { grn: { ...grn, displayStatus: grnDisplayStatus(grn.status) }, summary };
  }

  /**
   * Shared GRN creation core. Runs inside the caller's transaction:
   *  1. locks the PO row and every PO line (FOR UPDATE) before reading
   *     pendingQty, so two concurrent receipts serialize;
   *  2. rejects CANCELLED / CLOSED / DRAFT / fully received POs;
   *  3. validates vendor, GRN number, single PO, PO-line ownership, product
   *     match, duplicate lines and receivedQty <= pendingQty;
   *  4. creates the GRN as PENDING (draft). Stock is only touched by
   *     approveInTx (posting).
   */
  private static async createDraftInTx(tx: any, poId: string, data: GRNCreateInput, opts: { strict: boolean }) {
    const headerPoIds = [data.purchaseOrderId, data.poId].filter(v => v !== undefined && v !== null && v !== '');
    if (headerPoIds.some(v => v !== poId)) {
      throw new AppError('A GRN can belong to only one Purchase Order. The purchaseOrderId in the request does not match the Purchase Order being received.', 400);
    }

    if (!(await lockPOForReceipt(tx, poId))) throw new AppError('Purchase Order not found', 404);
    const fulfilment = await computePOFulfilment(tx, poId);
    if (!fulfilment) throw new AppError('Purchase Order not found', 404);
    const po = fulfilment.po;
    const poLabel = po.poNumber || poId;

    const blockReason = receiptBlockReason(po, fulfilment.fullyReceived);
    if (blockReason) throw new AppError(`${blockReason} (status ${po.status})`, 409);

    if (!Array.isArray(data.items) || data.items.length === 0) {
      throw new AppError('Add at least one PO item to receive.', 400);
    }

    if (data.vendorId && data.vendorId !== po.vendorId) {
      throw new AppError(`GRN vendor must be the Purchase Order's vendor (${po.vendor?.name || po.vendorId}).`, 400);
    }

    let grnNumber: string;
    const manualNumber = typeof data.grnNumber === 'string' ? data.grnNumber.trim() : '';
    if (manualNumber) {
      if (manualNumber.length > 50 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(manualNumber)) {
        throw new AppError('GRN number may contain only letters, digits and - / _ . (max 50 characters).', 400);
      }
      const taken = await tx.goodsReceipt.findUnique({ where: { grnNumber: manualNumber }, select: { id: true } });
      if (taken) throw new AppError(`GRN number "${manualNumber}" already exists.`, 409);
      grnNumber = manualNumber;
    } else {
      grnNumber = await this.nextGrnNumber(tx);
    }

    let receivedAt: Date | undefined;
    if (data.receivedAt) {
      receivedAt = new Date(data.receivedAt);
      if (isNaN(receivedAt.getTime())) throw new AppError('Invalid received date.', 400);
    }

    const lineById = new Map<string, any>(fulfilment.lines.map(l => [l.poItemId, l]));
    const seenLines = new Set<string>();
    const itemsData: any[] = [];

    for (const item of data.items) {
      const linePoIds = [item.purchaseOrderId, item.poId].filter(v => v !== undefined && v !== null && v !== '');
      if (linePoIds.some(v => v !== poId)) {
        throw new AppError(`A GRN cannot contain products from another Purchase Order. Every line must belong to ${poLabel}.`, 400);
      }

      // --- Resolve the PO line this GRN line receives against -------------
      const productKey = item.materialId || item.productId || null;
      let poItem: any;
      if (item.poItemId) {
        poItem = po.poItems.find((p: any) => p.id === item.poItemId);
        if (!poItem) {
          throw new AppError(`PO line ${item.poItemId} does not belong to Purchase Order ${poLabel}. A GRN cannot contain products from another Purchase Order.`, 400);
        }
        const keys = [item.materialId, item.productId].filter(Boolean);
        if (keys.some(k => k !== poItem.inventoryItemId && k !== poItem.productId)) {
          throw new AppError(`Product does not match PO line "${poItem.itemName || poItem.id}".`, 400);
        }
      } else {
        if (!productKey) throw new AppError('Each GRN line needs the poItemId (or productId) of the PO line it receives.', 400);
        const matches = po.poItems.filter((p: any) => p.inventoryItemId === productKey || p.productId === productKey);
        if (matches.length === 0) {
          throw new AppError(`Item ${productKey} does not belong to Purchase Order ${poLabel}. A GRN cannot contain products from another Purchase Order.`, 400);
        }
        if (matches.length > 1) throw new AppError(`Purchase Order ${poLabel} has more than one line for this product. Send the poItemId of the line being received.`, 400);
        poItem = matches[0];
      }
      const label = poItem.itemName || poItem.inventoryItemId || poItem.id;
      const line = lineById.get(poItem.id)!;

      // --- Quantities -------------------------------------------------------
      const received = Number(item.receivedQty ?? 0);
      const rejected = Number(item.rejectedQty ?? 0);
      if (!Number.isFinite(received) || !Number.isFinite(rejected)) {
        throw new AppError(`Quantities for "${label}" must be numbers.`, 400);
      }
      if (opts.strict && received <= 0) {
        throw new AppError(`Received quantity for "${label}" must be greater than zero.`, 400);
      }
      if (received < 0) throw new AppError(`Received quantity for "${label}" cannot be negative.`, 400);
      if (!opts.strict && received === 0 && rejected === 0) continue; // nothing on this line
      if (rejected < 0 || rejected > received + EPS) {
        throw new AppError(`Rejected quantity for "${label}" must be between 0 and the received quantity.`, 400);
      }
      const accepted = item.acceptedQty === undefined || item.acceptedQty === null ? received - rejected : Number(item.acceptedQty);
      if (!Number.isFinite(accepted) || accepted < 0 || Math.abs(accepted + rejected - received) > EPS) {
        throw new AppError(`For "${label}", accepted + rejected must equal the received quantity.`, 400);
      }

      if (seenLines.has(poItem.id)) {
        throw new AppError(`Duplicate line for "${label}". Enter each PO item once per GRN.`, 400);
      }
      seenLines.add(poItem.id);

      // Authoritative cap, computed under the locks above from persisted rows.
      if (received > line.pendingQty + EPS) {
        throw new AppError(
          `Received quantity cannot exceed pending quantity. "${label}": pending ${line.pendingQty} ${line.unit} ` +
          `(ordered ${line.orderedQty}, already received ${line.receivedQty}), tried to receive ${received}.`, 400);
      }

      purchaseLineTax(po.poItems, poItem.inventoryItemId, poItem.itemName || 'GRN line');

      if (item.warehouseId) {
        await this.validateWarehouseScope(tx, item.warehouseId, data.user);
      }

      const poPrice = Number(poItem.price ?? 0);
      const price = Number(item.price ?? poPrice);
      if (!Number.isFinite(price) || price < 0) throw new AppError(`Actual unit price for "${label}" cannot be negative.`, 400);

      const priceOverridden = Math.abs(price - poPrice) > 0.001;
      if (priceOverridden && !(item.priceOverrideReason || '').trim()) {
        throw new AppError(`Actual unit price for "${label}" differs from PO price (₹${poPrice}). An override reason is required.`, 400);
      }

      const mfgDate = item.mfgDate ? new Date(item.mfgDate) : null;
      const expDate = item.expDate ? new Date(item.expDate) : null;
      if (mfgDate && isNaN(mfgDate.getTime())) throw new AppError(`Invalid Manufacturing (MFG) date for "${label}".`, 400);
      if (expDate && isNaN(expDate.getTime())) throw new AppError(`Invalid Expiry (EXP) date for "${label}".`, 400);
      if (mfgDate && expDate && expDate.getTime() < mfgDate.getTime()) {
        throw new AppError(`Expiry (EXP) date cannot be earlier than Manufacturing (MFG) date for "${label}".`, 400);
      }

      let assignedLotNumber: string | null;
      const rawLot = (item.lotNumber || '').trim();
      const isAutoLot = !rawLot || rawLot === '[AUTO]' || rawLot.toUpperCase().endsWith('-[AUTO]') || rawLot.toUpperCase() === 'AUTO' || rawLot === 'Auto-Generated on Save' || /^LOT-\d{8}-\d{5}$/i.test(rawLot);

      if (accepted > 0) {
        if (isAutoLot) {
          const seq = await this.nextSequence(tx, 'GRN_LOT');
          const now = new Date();
          const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
          assignedLotNumber = `LOT-${ymd}-${String(seq).padStart(5, '0')}`;
        } else {
          // Manual lot numbers must be unique across non-cancelled GRN lines and lots.
          const existingGrnItem = await tx.goodsReceiptItem.findFirst({ where: { lotNumber: rawLot, grn: { status: { not: 'CANCELLED' } } } });
          const existingBatch = await tx.inventoryBatch.findFirst({ where: { lotNumber: rawLot } });
          if (existingGrnItem || existingBatch) {
            throw new AppError(`Batch/Lot Number "${rawLot}" already exists for item "${label}". Manual lot numbers must be unique.`, 400);
          }
          assignedLotNumber = rawLot;
        }
      } else {
        assignedLotNumber = isAutoLot ? null : rawLot;
      }

      itemsData.push({
        poItemId: poItem.id,
        materialId: poItem.inventoryItemId,
        isBulk: Boolean(poItem.isBulk),
        quantity: poItem.quantity,
        receivedQty: received,
        acceptedQty: accepted,
        rejectedQty: rejected,
        price,
        poPrice,
        priceOverridden,
        priceOverrideReason: priceOverridden ? item.priceOverrideReason!.trim() : null,
        priceOverrideBy: priceOverridden ? (data.performedBy || null) : null,
        priceOverrideAt: priceOverridden ? new Date() : null,
        unit: poItem.unit || 'UNIT',
        qcStatus: (item.qcStatus as any) || 'PENDING',
        vendorBatchNo: item.vendorBatchNo ? item.vendorBatchNo.trim() : null,
        mfgDate,
        expDate,
        lotNumber: assignedLotNumber,
        warehouseId: item.warehouseId,
        binId: item.binId
      });
    }

    if (itemsData.length === 0) throw new AppError('Enter a received quantity for at least one PO item.', 400);

    return tx.goodsReceipt.create({
      data: {
        grnNumber,
        poId,
        vendorId: po.vendorId,
        ...(receivedAt ? { receivedAt } : {}),
        receivedBy: data.receivedBy,
        freightCost: data.freightCost || 0,
        unloadingCost: data.unloadingCost || 0,
        status: 'PENDING',
        items: { create: itemsData }
      },
      include: {
        procurementOrder: { include: { vendor: true, poItems: true } },
        items: { include: { inventoryItem: true } }
      }
    });
  }
  /** Post a draft GRN (PATCH /api/grn/:id/approve). */
  static async approve(grnId: string, user?: any, options: { rejectionReason?: string } = {}) {
    return prisma.$transaction(tx => this.approveInTx(tx, grnId, user, options), GRN_TX_OPTIONS);
  }

  /**
   * Posting core, run inside the caller's transaction (so create + post can
   * be one atomic unit). Stock, lots, the vendor bill and the PO receipt
   * counters are written only here, and only once per GRN.
   */
  private static async approveInTx(tx: any, grnId: string, user?: any, options: { rejectionReason?: string } = {}) {
    {
      // Lock the GRN row BEFORE reading its status: two concurrent approvals
      // (double-click, retry) would otherwise both read PENDING and both
      // post lots, stock and a bill. The second waits here and then sees
      // COMPLETED below. InventoryBatch.goodsReceiptItemId is also unique,
      // as a DB-level backstop.
      await tx.$queryRaw`SELECT id FROM "GoodsReceipt" WHERE id = ${grnId} FOR UPDATE`;

      const grn = await tx.goodsReceipt.findUnique({
        where: { id: grnId },
        include: { items: true, procurementOrder: { include: { poItems: true, vendor: { select: { state: true } } } } }
      });
      if (!grn) throw new Error('GRN not found');
      if (grn.status === 'COMPLETED') throw new Error('GRN already approved');
      if (grn.status === 'REJECTED') throw new Error('GRN already finalized as fully rejected');
      if (grn.status === 'CANCELLED') throw new Error('Cannot approve a cancelled GRN');

      // Same PO + PO-line row locks GRN creation takes: two GRNs against the
      // same PO (e.g. two drafts created before either was posted) must have
      // their postings serialized, or both could complete and together push
      // received past what was ordered.
      await lockPOForReceipt(tx, grn.poId);
      const currentPO = await tx.procurementOrder.findUniqueOrThrow({ where: { id: grn.poId }, select: { status: true, shortClosedAt: true } });
      if (!isPOReceiptEligible(currentPO.status)) throw new AppError(`Cannot post a GRN for a PO in status ${currentPO.status}`, 409);
      if (currentPO.shortClosedAt) throw new AppError('Cannot post a GRN for a short-closed Purchase Order.', 409);

      // Full rejection: goods arrived but nothing was accepted. Finalized as
      // REJECTED with a mandatory reason — no inventory batch, stock
      // movement or vendor bill is posted, and (since received-against-PO
      // counts COMPLETED GRNs only) the PO quantity stays open for the
      // vendor's replacement shipment. Every stock/finance query filters on
      // COMPLETED, so a REJECTED GRN never reaches usable inventory.
      const anyReceived = grn.items.some(i => i.receivedQty > 0);
      const nothingAccepted = grn.items.every(i => !(i.acceptedQty > 0));
      if (anyReceived && nothingAccepted) {
        const reason = (options.rejectionReason || '').trim();
        if (reason.length < 3) {
          throw new Error('A rejection reason is required to finalize a fully rejected GRN.');
        }
        await tx.goodsReceiptItem.updateMany({ where: { grnId }, data: { qcStatus: 'REJECTED' } });
        const rejected = await tx.goodsReceipt.update({
          where: { id: grnId },
          data: { status: 'REJECTED', rejectionReason: reason, rejectedAt: new Date(), rejectedBy: user?.userId || null },
          include: { procurementOrder: { include: { vendor: true, poItems: true } }, items: { include: { inventoryItem: true } } }
        });
        await tx.auditLog.create({
          data: {
            module: 'GRN',
            action: 'REJECT',
            recordId: grnId,
            newValue: { status: 'REJECTED', reason, rejectedQty: grn.items.reduce((s, i) => s + (i.rejectedQty || 0), 0) },
            performedBy: user?.userId || 'SYSTEM'
          }
        });
        // Audit C-04: the return document is generated here, from this GRN's
        // own rejected quantities, in the same transaction.
        await PurchaseService.createGrnRejectionReturn(tx, grnId, `GRN FULL REJECTION: ${reason}`);
        return rejected;
      }
      if (nothingAccepted) throw new Error('Nothing was received on this GRN — there is nothing to approve.');

      // Defense in depth against exactly that: re-check cumulative received
      // (this GRN's own items + every OTHER already-COMPLETED GRN for the
      // PO) against each line's ordered quantity before posting inventory —
      // createFromPO validates at creation time, but a second GRN can be
      // created (and left PENDING) before the first is approved, so this
      // is the last real gate before stock/ledger entries are made.
      {
        const prior = await computePOFulfilment(tx, grn.poId, { excludeGrnId: grnId });
        const thisGrnByLine = new Map<string, number>();
        for (const item of grn.items) {
          const poItem = resolvePOLine(grn.procurementOrder.poItems, item);
          if (!poItem) throw new AppError(`GRN line ${item.id} does not belong to Purchase Order ${grn.procurementOrder.poNumber || grn.poId}.`, 400);
          thisGrnByLine.set(poItem.id, (thisGrnByLine.get(poItem.id) || 0) + (item.receivedQty || 0));
        }
        for (const [poItemId, receiving] of thisGrnByLine) {
          const line = prior!.lines.find(l => l.poItemId === poItemId)!;
          if (receiving > line.pendingQty + EPS) {
            throw new AppError(
              `Received quantity cannot exceed pending quantity. Cannot post: "${line.itemName || poItemId}" would receive ${receiving} ` +
              `but only ${line.pendingQty} ${line.unit} is pending (ordered ${line.orderedQty}, already received ${line.receivedQty}). ` +
              `Reduce this GRN's received quantity or cancel a duplicate GRN first.`, 400);
          }
        }
      }

      // Defense in depth: createFromPO already enforces this at entry, but
      // approval is the actual financial trigger (posts VendorLedger via
      // the auto-generated bill below), so re-validate against whatever is
      // actually persisted rather than trusting it was never bypassed.
            for (const item of grn.items) {
        if (item.price < 0) throw new Error(`Item ${item.materialId} has an invalid negative price`);
        if (item.priceOverridden && !(item.priceOverrideReason || '').trim()) {
          throw new Error(`Item ${item.materialId} has a price override with no reason recorded - cannot approve`);
        }
        if (item.acceptedQty > 0) {
          if (item.warehouseId) {
            await this.validateWarehouseScope(tx, item.warehouseId, user);
          }
          const batchNo = (item.lotNumber || item.vendorBatchNo || '').trim();
          if (!batchNo) {
            throw new Error(`Batch/Lot number is required for material item "${item.materialId}" before approval.`);
          }
          
          if (!item.expDate || isNaN(new Date(item.expDate).getTime())) {
            throw new Error(`Valid Expiry (EXP) date is required for material item "${item.materialId}" before approval.`);
          }
          if (item.mfgDate && item.expDate && new Date(item.expDate).getTime() < new Date(item.mfgDate).getTime()) {
            throw new Error(`Expiry (EXP) date cannot be earlier than Manufacturing (MFG) date for material item "${item.materialId}".`);
          }
        }
      }

      // Computed once up front so every batch created below AND the vendor
      // invoice generated later carry the exact same reference — FIFO
      // consumption should trace back to "which bill this stock came from,
      // at what price," not an arbitrary internal lot code. Uses the atomic
      // sequence (see nextSequence) instead of Date.now(), which two GRNs
      // approved within the same 10-second window could collide on.
      const billSeq = await this.nextSequence(tx, 'GRN_BILL');
      const billNumber = `BILL-${grn.procurementOrder.poNumber || grn.poId.slice(0, 8)}-${String(billSeq).padStart(6, '0')}`;

      for (const item of grn.items) {
        if (item.acceptedQty <= 0) continue;

        const batchRef = (item.lotNumber || item.vendorBatchNo || '').trim() || billNumber;

        // 2. Mark GRN Item as APPROVED
        await tx.goodsReceiptItem.update({
          where: { id: item.id },
          data: { qcStatus: 'APPROVED' }
        });

        // Convert accepted quantity to inventory base unit for stock updates
        const invItemBefore = await tx.inventoryItem.findUnique({ where: { id: item.materialId! } });
        if (!invItemBefore) throw new Error(`Inventory item ${item.materialId} not found`);

        let canonicalQty = item.acceptedQty;
        console.log(`[GRN DBG] item.unit: ${item.unit}, inv.unit: ${invItemBefore.unit}, qty: ${canonicalQty}`);
        if (item.unit && invItemBefore.unit && item.unit.toUpperCase() !== invItemBefore.unit.toUpperCase() && item.unit !== 'UNIT') {
          const countUnits = ['PC', 'PCS', 'UNIT', 'PACKET', 'BOX', 'NOS'];
          const u1 = item.unit.toUpperCase();
          const u2 = invItemBefore.unit.toUpperCase();
          if (countUnits.includes(u1) && countUnits.includes(u2)) {
            canonicalQty = item.acceptedQty;
          } else {
            try {
              const { convertMeasurement } = require('@businessgroupikasle/erp-units');
              canonicalQty = convertMeasurement(item.acceptedQty, u1, u2).toNumber();
              console.log(`[GRN DBG] canonicalQty after calc: ${canonicalQty}`);
            } catch (err: any) {
               throw new Error(`Unit conversion failed for "${invItemBefore.name}": ${err.message}`);
            }
          }
        }

        const alreadyPosted = await tx.inventoryBatch.findUnique({ where: { goodsReceiptItemId: item.id } });
        if (alreadyPosted) {
          throw new Error(`Stock for "${invItemBefore.name}" on this GRN was already posted as lot ${alreadyPosted.batchNumber}.`);
        }

        // item.price is per GRN/PO unit; the lot's unitCost must be per
        // stock unit or lot valuation is off whenever the two differ
        // (e.g. bought per G, stocked per KG). Same value, re-expressed.
        const lineValue = item.acceptedQty * item.price;
        const unitCostPerStockUnit = canonicalQty > 0 ? lineValue / canonicalQty : item.price;

        const poItem: any = resolvePOLine(grn.procurementOrder.poItems, item);
        const isBulkItem = Boolean(
          item.isBulk ||
          poItem?.isBulk ||
          (invItemBefore.category === 'SEMI_FINISHED' &&
            (grn.procurementOrder.purchaseType === 'FINISHED_GOOD' || grn.procurementOrder.purchaseType === 'FINISHED_GOODS'))
        );

        let productBatchId: string | null = null;
        if (isBulkItem) {
          const existingProductBatch = await tx.productBatch.findUnique({
            where: { goodsReceiptItemId: item.id }
          });

          if (!existingProductBatch) {
            let resolvedProductId = poItem?.productId || null;
            if (!resolvedProductId) {
              const baseName = invItemBefore.name.replace(/\s*-\s*Bulk$/i, '').trim();
              const prod = await tx.product.findFirst({
                where: {
                  OR: [
                    { name: { equals: baseName, mode: 'insensitive' } },
                    { name: { contains: baseName, mode: 'insensitive' } }
                  ]
                }
              });
              if (prod) resolvedProductId = prod.id;
            }

            const createdBatch = await tx.productBatch.create({
              data: {
                sourceType: 'PURCHASE',
                productId: resolvedProductId,
                productionId: null,
                batchCode: batchRef,
                quantity: canonicalQty,
                approvedQty: canonicalQty,
                packagedQty: 0,
                qcStatus: 'QC_NOT_REQUIRED',
                packagingStatus: 'PENDING',
                unitCost: unitCostPerStockUnit,
                totalCost: lineValue,
                vendorId: grn.procurementOrder.vendorId,
                procurementOrderId: grn.poId,
                goodsReceiptId: grn.id,
                goodsReceiptItemId: item.id,
                warehouseId: item.warehouseId || grn.procurementOrder.warehouseId || null,
                mfgDate: item.mfgDate || grn.receivedAt,
                expiryDate: item.expDate,
                franchiseId: grn.procurementOrder.franchiseId,
              }
            });
            productBatchId = createdBatch.id;
          } else {
            productBatchId = existingProductBatch.id;
          }
        }

        // 1. Create Inventory Batch (APPROVED status directly to update stock) using canonicalQty
        const lot = await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.materialId!,
            productBatchId: productBatchId || undefined,
            batchNumber: batchRef,
            lotNumber: item.lotNumber,
            // Always the real Purchase Bill reference, independent of
            // whichever value batchNumber ended up prioritizing above — the
            // business-facing consumption screens read this, not batchNumber.
            billNumber,
            mfgDate: item.mfgDate,
            expDate: item.expDate,
            initialQty: canonicalQty,
            currentQty: canonicalQty,
            unitCost: unitCostPerStockUnit,
            warehouseId: item.warehouseId || null,
            status: 'APPROVED',
            goodsReceiptItemId: item.id,
            procurementOrderId: grn.poId,
            vendorId: grn.procurementOrder.vendorId,
            receivedAt: grn.receivedAt,
            purchaseQty: item.acceptedQty,
            purchaseUnit: item.unit,
            purchasePrice: item.price
          }
        });

        // 3. Record stock movement and cost price update immediately
        const preReceiptStock = await InventoryService.computeStock(item.materialId!, tx);
        const priorQty = Math.max(0, preReceiptStock);
        const priorCost = invItemBefore?.costPrice || 0;
        const newCostPrice = priorQty + canonicalQty > 0
          ? ((priorQty * priorCost) + (item.acceptedQty * item.price)) / (priorQty + canonicalQty)
          : item.price; // Note: PO value remains (acceptedQty * price), but per-canonical-unit cost applies

        await tx.inventoryItem.update({
          where: { id: item.materialId! },
          data: { 
            vendorId: grn.procurementOrder.vendorId, 
            costPrice: newCostPrice 
          }
        });

        await InventoryService.recordMovement(tx, {
          itemId: item.materialId!,
          type: 'PURCHASE_IN',
          quantity: canonicalQty,
          referenceType: 'GOODS_RECEIPT',
          referenceId: grnId,
          warehouseId: item.warehouseId || undefined,
          batchId: lot.id,
          unitCost: unitCostPerStockUnit,
          note: `GRN Approved & Synced: ${item.acceptedQty} ${item.unit} -> ${canonicalQty} ${invItemBefore.unit}`
        });
      }

      // 4. Update Financial Ledger (Liability) & Generate Purchase Bill (Vendor Invoice).
      // Commercials (subtotal/CGST/SGST/gross) are derived per-line from the
      // PO's own GST rates against ACCEPTED quantities — the same shared
      // helper the manual "Generate Bill" screen now uses too, so the two
      // paths can no longer disagree the way they used to (this path had
      // tax right via a flat taxFactor; the manual path hardcoded 0% and
      // could overwrite this correct bill with a tax-free one).
      const sellerState = await resolveSellerState(grn.procurementOrder.franchiseId);
      const commercials = VendorInvoiceService.computeCommercialsFromPO(grn.procurementOrder, grn.items, grn.procurementOrder.vendor?.state, sellerState);

      if (commercials.amount > 0) {
        // Automatically generate a Purchase Bill (Vendor Invoice) only if one doesn't exist yet.
        const existingInvoice = await tx.vendorInvoice.findFirst({
          where: { grnId: grnId }
        });
        if (!existingInvoice) {
          const newInvoice = await tx.vendorInvoice.create({
            data: {
              vendorId: grn.procurementOrder.vendorId,
              poId: grn.poId,
              grnId: grnId,
              invoiceNumber: billNumber,
              amount: commercials.amount,
              subtotal: commercials.subtotal,
              taxAmount: commercials.taxAmount,
              cgst: commercials.cgst,
              sgst: commercials.sgst,
              igst: commercials.igst,
              discountAmount: commercials.discountAmount || 0,
              freightCost: commercials.freightCost || 0,
              warehouseId: commercials.warehouseId,
              status: 'PENDING',
              billDate: new Date()
            }
          });

          // Recognize the liability (Vendor Ledger CREDIT + advance
          // attribution) immediately — the Purchase Bills UI has no
          // "Approve" action, only "Make Payment" on PENDING bills, so
          // waiting for a manual approve() call left Total Purchases at ₹0
          // and Make Payment/outstanding using the full gross amount
          // instead of net-of-advance. See VendorInvoiceService.recognizeLiability.
          await VendorInvoiceService.recognizeLiability(tx, newInvoice.id);
        }
      }

      // Mark the GRN posted first, then recompute the PO receipt state from
      // persisted rows (this GRN now included): PO line receivedQty /
      // pendingQty and PO status (PARTIALLY_RECEIVED / RECEIVED). Must run
      // before settleVendorOrders, which settles RECEIVED POs only.
      await tx.goodsReceipt.update({ where: { id: grnId }, data: { status: 'COMPLETED' } });
      await syncPOReceiptState(tx, grn.poId);

      // Settle against any available advance
      await ProcurementService.settleVendorOrders(grn.procurementOrder.vendorId, tx);

      // Audit C-04: rejected lines on a partially accepted GRN get their
      // return document server-side (quantity = rejectedQty, rate = GRN price).
      // Only QC-rejected goods: an undelivered balance stays pending on the PO.
      await PurchaseService.createGrnRejectionReturn(tx, grnId, null);

      await tx.auditLog.create({
         data: {
            module: 'GRN',
            action: 'APPROVE',
            recordId: grnId,
            newValue: { status: 'COMPLETED', inventoryState: 'QC_HOLD' },
            performedBy: user?.userId || 'SYSTEM'
         }
      });

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: grnId },
        include: {
          procurementOrder: { include: { vendor: true, poItems: true } },
          items: { include: { inventoryItem: true } }
        }
      });
    }
  }

  /**
   * Cancel a PENDING GRN (audit M-01). The previous version read the status
   * outside any transaction and then wrote CANCELLED unconditionally, so a
   * cancel racing an approval could stamp CANCELLED over a COMPLETED GRN —
   * whose stock and bill were already posted — reopening the PO quantity for
   * a second receipt. Now: same row locks as approve() (GRN, then PO), a
   * conditional PENDING -> CANCELLED claim, a mandatory reason, and an audit
   * record, all in one transaction.
   */
  static async cancel(grnId: string, opts: { reason?: unknown; actor?: AuditActor } = {}) {
    const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
    if (reason.length < 3) throw new AppError('A cancellation reason (at least 3 characters) is required.', 400);

    return prisma.$transaction(async (tx) => {
      const locked: any[] = await tx.$queryRaw`SELECT id FROM "GoodsReceipt" WHERE id = ${grnId} FOR UPDATE`;
      if (!locked.length) throw new AppError('GRN not found', 404);
      const grn = await tx.goodsReceipt.findUniqueOrThrow({ where: { id: grnId } });
      await tx.$queryRaw`SELECT id FROM "ProcurementOrder" WHERE id = ${grn.poId} FOR UPDATE`;

      if (grn.status === 'COMPLETED') throw new AppError('Cannot cancel an approved GRN. Use a purchase return for received goods.', 409);
      if (grn.status === 'REJECTED') throw new AppError('Cannot cancel a GRN already finalized as fully rejected', 409);
      if (grn.status === 'CANCELLED') throw new AppError('GRN is already cancelled', 409);

      const claimed = await tx.goodsReceipt.updateMany({ where: { id: grnId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      if (claimed.count !== 1) throw new AppError('GRN status changed concurrently — reload and try again.', 409);

      await writeAuditLog(tx, {
        module: 'GRN',
        action: 'CANCELLED',
        recordId: grnId,
        oldValue: { status: grn.status },
        newValue: { status: 'CANCELLED', reason, poId: grn.poId },
        actor: opts.actor
      });

      return tx.goodsReceipt.findUniqueOrThrow({
        where: { id: grnId },
        include: {
          procurementOrder: { include: { vendor: true, poItems: true } },
          items: { include: { inventoryItem: true } }
        }
      });
    });
  }

  static async updateQCStatus(grnItemId: string, qcStatus: 'PENDING' | 'APPROVED' | 'HOLD' | 'REJECTED') {
     return prisma.goodsReceiptItem.update({
        where: { id: grnItemId },
        data: { qcStatus }
     });
  }
}
