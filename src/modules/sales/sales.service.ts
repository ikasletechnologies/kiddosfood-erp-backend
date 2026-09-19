import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FranchiseService } from '../franchise/franchise.service';

// Atomic, collision-safe document numbering. A raw `.count()`-based scheme
// (the old approach here) lets two concurrent requests read the same N
// before either commits — the @unique column then hard-fails the second
// insert instead of preventing the race. NumberSequence upsert is atomic
// within the surrounding transaction (same pattern as
// ProductionService.nextProductionBatchCode), so retries/concurrent
// creates cannot reuse a number. Every Sales-chain document (Estimate,
// Sales Order, Proforma, Tax Invoice) shares this one generator so there's
// exactly one counter per prefix+year, not several independently-
// incrementing schemes racing to produce the same string.
async function nextDocumentNumber(tx: any, key: string, prefix: string, pad = 5): Promise<string> {
  const year = new Date().getFullYear();
  const seq = await tx.numberSequence.upsert({
    where: { key: `${key}_${year}` },
    create: { key: `${key}_${year}`, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${year}-${String(seq.value).padStart(pad, '0')}`;
}

async function generateReturnNumber() {
  const count = await prisma.returnOrder.count();
  return `SR${(count + 1).toString().padStart(10, '0')}`;
}

// A quotation/order always stores customerId + a denormalized customerName
// snapshot, but callers that select a real party only ever send customerId —
// without this, customerName is saved as null and every later screen that
// reads it (list, convert modal, the converted Sales Order) shows "—" even
// though the party is correctly linked via customerId.
async function resolveCustomerName(customerId?: string, customerName?: string): Promise<string | undefined> {
  if (customerName) return customerName;
  if (!customerId) return undefined;
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  return customer?.name;
}

function calculateTotals<T extends {
  quantity: number;
  rate: number;
  taxPercent?: number;
  discountPercent?: number;
  discountPct?: number;
  discountAmount?: number;
  discount?: number;
}>(items: T[], documentDiscountAmount: number = 0) {
  let subTotal = 0;
  let taxAmount = 0;
  let totalDiscount = 0;

  const validItems = items || [];
  const totalGross = validItems.reduce((sum, item) => sum + (item.quantity || 0) * (item.rate || 0), 0);
  // A negotiated discount is a legitimate, cashier/salesperson-entered
  // value with no configured ceiling to check it against — but it can
  // never exceed the value actually being sold, and never be negative.
  // Clamping here (rather than removing the feature) is what keeps this a
  // "manual discount" and not a way to fabricate a negative or inflated
  // bill.
  const clampedDocumentDiscount = Math.max(0, Math.min(documentDiscountAmount || 0, totalGross));
  const hasExplicitItemDiscounts = validItems.some((item) =>
    (item.discountAmount !== undefined && item.discountAmount > 0) ||
    (item.discount !== undefined && item.discount > 0) ||
    (item.discountPercent !== undefined && item.discountPercent > 0) ||
    (item.discountPct !== undefined && item.discountPct > 0)
  );

  const computed = validItems.map((item) => {
    const gross = (item.quantity || 0) * (item.rate || 0);
    let discAmt = (item.discountAmount !== undefined && item.discountAmount > 0)
      ? item.discountAmount
      : ((item.discount !== undefined && item.discount > 0) ? item.discount : 0);
    discAmt = Math.max(0, Math.min(discAmt, gross));

    let discPct = (item.discountPercent !== undefined && item.discountPercent > 0)
      ? item.discountPercent
      : ((item.discountPct !== undefined && item.discountPct > 0) ? item.discountPct : 0);
    discPct = Math.max(0, Math.min(discPct, 100));

    if (!hasExplicitItemDiscounts && clampedDocumentDiscount > 0 && totalGross > 0) {
      discAmt = Math.round((clampedDocumentDiscount * (gross / totalGross)) * 100) / 100;
      discPct = gross > 0 ? Math.round(((discAmt / gross) * 100) * 100) / 100 : 0;
    } else if (!discAmt && discPct > 0) {
      discAmt = Math.round((gross * discPct / 100) * 100) / 100;
    } else if (!discPct && gross > 0 && discAmt > 0) {
      discPct = Math.round(((discAmt / gross) * 100) * 100) / 100;
    }
    // Re-clamp: the derivations above can only move discAmt within
    // [0, gross] mathematically, but this is the actual enforcement point.
    discAmt = Math.max(0, Math.min(discAmt, gross));

    const taxable = Math.max(0, Math.round((gross - discAmt) * 100) / 100);
    const lineTax = Math.round((taxable * (item.taxPercent || 0) / 100) * 100) / 100;

    subTotal += taxable;
    taxAmount += lineTax;
    totalDiscount += discAmt;

    return {
      ...item,
      discountPercent: discPct,
      discountPct: discPct,
      discountAmount: discAmt,
      taxableAmount: taxable,
      taxAmount: lineTax,
      totalAmount: Math.round((taxable + lineTax) * 100) / 100
    };
  });

  subTotal = Math.round(subTotal * 100) / 100;
  taxAmount = Math.round(taxAmount * 100) / 100;
  totalDiscount = Math.round(totalDiscount * 100) / 100;
  const grandTotal = Math.max(0, Math.round((subTotal + taxAmount) * 100) / 100);

  return { computed, subTotal, taxAmount, totalDiscount, totalAmount: grandTotal };
}

// Resolve the authoritative channel price + GST rate + "Customer Retail
// Discount" for one line from InventoryItem/Product — mirrors
// POSService.checkout's price/tax/discount resolution, so a document's
// rate/taxPercent are never blindly trusted from the client. Only a
// positive channel price counts as "configured" (these fields default to
// 0, not null); otherwise falls back to the generic base price, same as
// before channel prices existed.
//
// discountType/discountValue is the Item Master's "Customer Retail
// Discount" — CUSTOMER channel only, never Dealer/Franchise (see
// POSService.checkout's getItemDiscount). It is returned here only as a
// DEFAULT for applyAuthoritativePricing to fill in when the client sent no
// explicit discount at all — an existing manual/negotiated discount the
// client did supply is never overwritten by it (see applyAuthoritativePricing).
//
// A line with NO productId at all (a genuine free-text/custom line, e.g.
// a one-off service charge) has nothing authoritative to check against
// and keeps whatever price the client sent. But a line that DOES supply a
// productId and still fails to resolve must reject the whole document —
// silently falling back to the client-submitted price there would mean a
// scope/mapping failure (or a forged id) quietly reopens the exact trust
// hole this resolver exists to close (e.g. a real Dealer price of ₹40
// with a resolution failure otherwise accepting a submitted ₹1).
async function resolveItemChannelPricing(
  tx: any,
  productId: string | undefined,
  productName: string | undefined,
  scopeFranchiseId: string | null,
  partyType: 'CUSTOMER' | 'DEALER' | 'FRANCHISE'
): Promise<{ rate: number; taxPercent: number; discountType: string; discountValue: number } | null> {
  if (!productId) return null;

  let product = await tx.product.findUnique({ where: { id: productId } });
  let inv: any = null;

  if (product) {
    inv = product.sku
      ? await tx.inventoryItem.findFirst({ where: { sku: product.sku, franchiseId: scopeFranchiseId } })
      : await tx.inventoryItem.findFirst({ where: { name: { equals: product.name, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });
  } else {
    // Estimate/Proforma/Delivery Challan let the operator pick straight
    // from the InventoryItem catalog (see convertProformaToInvoice's
    // "Proforma items carry an InventoryItem ID, not a Product ID"
    // comment) — item.productId is often an InventoryItem.id, not a
    // Product.id.
    inv = await tx.inventoryItem.findUnique({ where: { id: productId } });
    if (!inv) {
      throw new Error(`Cannot price line item "${productName || productId}" — productId "${productId}" does not match any known Product or InventoryItem. Remove the reference to use a free-text price, or fix the id.`);
    }
  }

  const channelPrice =
    partyType === 'DEALER' ? inv?.dealerPrice :
    partyType === 'FRANCHISE' ? inv?.franchisePrice :
    inv?.customerPrice;
  const rate = channelPrice && channelPrice > 0 ? channelPrice : (inv?.basePrice || product?.basePrice || 0);
  const taxPercent = inv?.gstRate ?? product?.taxPercent ?? 5;
  const discountType = inv?.discountType || product?.discountType || 'PERCENT';
  const discountValue = partyType === 'CUSTOMER' ? Number(inv?.discountValue ?? product?.discountValue ?? 0) : 0;

  return { rate, taxPercent, discountType, discountValue };
}

// Overrides rate/taxPercent in place for every line with a resolvable
// productId; a hand-typed custom line with no master-data link (no
// productId at all) keeps whatever the client sent, since there's nothing
// authoritative to check it against. A line that supplies a productId but
// fails to resolve throws (see resolveItemChannelPricing).
//
// If the client sent no explicit discount at all for a resolvable line,
// the Customer Retail Discount (CUSTOMER channel only) is filled in as the
// default so the discount isn't silently lost when a client forgets to
// send it — but a discount the client DID explicitly supply (whether the
// frontend's own auto-fill or a manually negotiated adjustment) is never
// overwritten; calculateTotals' existing bounds ([0, gross]) still apply
// to it either way.
async function applyAuthoritativePricing<T extends {
  productId?: string;
  productName?: string;
  rate: number;
  taxPercent?: number;
  quantity: number;
  discountAmount?: number;
  discount?: number;
  discountPercent?: number;
  discountPct?: number;
}>(
  tx: any,
  items: T[],
  scopeFranchiseId: string | null,
  partyType: 'CUSTOMER' | 'DEALER' | 'FRANCHISE',
  // Delivery Challan is a logistics/dispatch document with no discount
  // concept at all (DeliveryChallanItem has no discount column) — the
  // Customer Retail Discount must not be invented there. Every other
  // document (Estimate, Proforma, Sales Order) supports discounts and
  // defaults to applying it.
  applyDiscount: boolean = true
): Promise<T[]> {
  return Promise.all(items.map(async (item) => {
    const resolved = await resolveItemChannelPricing(tx, item.productId, item.productName, scopeFranchiseId, partyType);
    if (!resolved) return item;
    if (!applyDiscount) return { ...item, rate: resolved.rate, taxPercent: resolved.taxPercent };

    const hasExplicitDiscount =
      (item.discountAmount !== undefined && item.discountAmount > 0) ||
      (item.discount !== undefined && item.discount > 0) ||
      (item.discountPercent !== undefined && item.discountPercent > 0) ||
      (item.discountPct !== undefined && item.discountPct > 0);

    const updated: T = { ...item, rate: resolved.rate, taxPercent: resolved.taxPercent };
    if (!hasExplicitDiscount && resolved.discountValue > 0) {
      if (resolved.discountType === 'FLAT') {
        // discountValue is a per-unit flat amount (matches POSService's
        // getItemDiscount) — scale by quantity, capped at the line's gross.
        const gross = resolved.rate * (item.quantity || 0);
        (updated as any).discountAmount = Math.min(resolved.discountValue * (item.quantity || 0), gross);
      } else {
        (updated as any).discountPercent = Math.min(100, resolved.discountValue);
      }
    }
    return updated;
  }));
}

export class SalesService {
  // ─── Quotations ──────────────────────────────────────────────────────────────

    // Helper to parse YYYY-MM-DD (or ISO) into Date with proper start/end boundaries
    private static parseDate(str: string, endOfDay: boolean = false): Date {
      // If string already contains time component, trust it
      if (str.includes('T')) return new Date(str);
      // Append appropriate time; treat as UTC to avoid timezone shifts
      const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
      return new Date(str + suffix);
    }

    static async getQuotations(filters: {
    status?: string;
    customerId?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const where: any = {};
    if (filters.status && filters.status !== 'ALL') where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.fromDate || filters.toDate || filters.startDate || filters.endDate) {
      const startStr = (filters.fromDate || filters.startDate) as string;
      const endStr = (filters.toDate || filters.endDate) as string;
      const createdAtFilter: any = {};
      if (startStr) {
        createdAtFilter.gte = SalesService.parseDate(startStr);
      }
      if (endStr) {
        createdAtFilter.lte = SalesService.parseDate(endStr, true);
      }
      where.createdAt = createdAtFilter;
    }
    if (filters.search && filters.search.trim()) {
      const s = filters.search.trim();
      where.OR = [
        { quotationNumber: { contains: s, mode: 'insensitive' } },
        { customerName: { contains: s, mode: 'insensitive' } },
        { customer: { name: { contains: s, mode: 'insensitive' } } }
      ];
    }
    const quotations = await prisma.quotation.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });

    const salesOrderIds = quotations.map(q => q.convertedOrderId).filter(Boolean) as string[];
    const invoiceIds = quotations.map(q => q.convertedInvoiceId).filter(Boolean) as string[];
    const salesOrderMap = salesOrderIds.length
      ? new Map((await prisma.salesOrder.findMany({ where: { id: { in: salesOrderIds } }, select: { id: true, orderNumber: true } })).map(o => [o.id, o.orderNumber]))
      : new Map<string, string>();
    const invoiceMap = invoiceIds.length
      ? new Map((await prisma.order.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNum: true } })).map(i => [i.id, i.invoiceNum]))
      : new Map<string, string>();

    return quotations.map(q => ({
      ...q,
      convertedOrderNumber: q.convertedOrderId ? salesOrderMap.get(q.convertedOrderId) || null : null,
      convertedInvoiceNumber: q.convertedInvoiceId ? invoiceMap.get(q.convertedInvoiceId) || null : null
    }));
  }

  static async getQuotationById(id: string) {
    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
    if (!quotation) return null;

    let convertedOrderNumber: string | null = null;
    let convertedInvoiceNumber: string | null = null;

    if (quotation.convertedOrderId) {
      const salesOrder = await prisma.salesOrder.findUnique({
        where: { id: quotation.convertedOrderId },
        select: { orderNumber: true }
      });
      convertedOrderNumber = salesOrder?.orderNumber || null;
    }

    if (quotation.convertedInvoiceId) {
      const invoiceOrder = await prisma.order.findUnique({
        where: { id: quotation.convertedInvoiceId },
        select: { invoiceNum: true }
      });
      convertedInvoiceNumber = invoiceOrder?.invoiceNum || null;
    }

    return {
      ...quotation,
      convertedOrderNumber,
      convertedInvoiceNumber
    };
  }

  static async createQuotation(data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    validUntil?: string;
    stateOfSupply?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number; discountPercent?: number; discountPct?: number; discountAmount?: number; discount?: number }>;
    discountAmount?: number;
    totalAmount?: number;
    // Signed nearest-rupee adjustment the UI computed and displayed as the
    // payable total (e.g. +0.25 on a ₹99.75 pre-round total to show
    // ₹100.00) — persisted into totalAmount here rather than re-derived
    // server-side, so the figure the user actually saw is what's stored and
    // what propagates verbatim through Sales Order -> Proforma -> Tax
    // Invoice (each of those already copies totalAmount unchanged).
    roundOffAmount?: number;
    termsConditions?: string;
    notes?: string;
    createdBy?: string;
    quotationNumber?: string;
    status?: string;
  }) {
    const discount = data.discountAmount || 0;
    const partyType = data.partyType || 'CUSTOMER';
    // Quotation has no franchise scope of its own (it's an HQ-level
    // document — franchise scoping only enters at Delivery Challan), so
    // channel prices resolve against HQ-scoped InventoryItems.
    const pricedItems = await applyAuthoritativePricing(prisma, data.items, null, partyType);
    const { computed, subTotal, taxAmount, totalDiscount, totalAmount } = calculateTotals(pricedItems, discount);
    const roundOff = data.roundOffAmount || 0;
    // The `customer` relation/customerId only ever means a real Customer
    // record — a Dealer or Franchise party has no such row, so customerId
    // must stay null for those (partyId carries the id for every type).
    const customerId = partyType === 'CUSTOMER' ? data.customerId : undefined;
    const customerName = partyType === 'CUSTOMER' ? await resolveCustomerName(customerId, data.customerName) : (data.customerName || undefined);

    return prisma.$transaction(async (tx) => tx.quotation.create({
      data: {
        quotationNumber: data.quotationNumber || await nextDocumentNumber(tx, 'QT', 'QT'),
        partyType: partyType as any,
        partyId: data.partyId,
        customerId,
        customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
        stateOfSupply: data.stateOfSupply || undefined,
        status: (data.status as any) || undefined,
        subTotal,
        taxAmount,
        // Store the server-computed (clamped, per-line-distributed) figure,
        // not the raw client-submitted discount — calculateTotals already
        // bounds this to [0, totalGross], but the stored field should
        // reflect what was actually applied, not an unclamped claim.
        discountAmount: totalDiscount,
        // data.totalAmount is trusted only as a small nearest-rupee rounding
        // adjustment (see comment above) — bounded to ±₹2 of the
        // server-computed total so a forged totalAmount can't understate
        // (or inflate) what the resolved rate/tax actually add up to.
        totalAmount: (data.totalAmount !== undefined && Math.abs(data.totalAmount - (totalAmount + roundOff)) <= 2)
          ? data.totalAmount
          : (totalAmount + roundOff),
        termsConditions: data.termsConditions,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            discountPercent: item.discountPercent || item.discountPct || 0,
            discountAmount: item.discountAmount || 0,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { customer: true, items: true }
    }));
  }

  static async updateQuotation(id: string, data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    stateOfSupply?: string;
    status?: string;
    notes?: string;
    termsConditions?: string;
    validUntil?: string;
    items?: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number; discountPercent?: number; discountPct?: number; discountAmount?: number; discount?: number }>;
    discountAmount?: number;
    totalAmount?: number;
    roundOffAmount?: number;
    quotationNumber?: string;
    trackingNumber?: string;
    courierName?: string;
  }) {
    // Once an Estimate is CONVERTED it has a live Sales Order downstream —
    // silently rewriting its party/items/status here (e.g. the shared
    // create-form's autosave-on-back firing against an already-converted
    // record) would desync the two with nothing to reconcile them. Mirrors
    // the same guard on updateProformaInvoice. trackingNumber/courierName
    // stay editable post-conversion (delivery info legitimately changes).
    const existingForGuard = await prisma.quotation.findUnique({ where: { id } });
    if (!existingForGuard) throw new Error('Estimate not found.');
    if (existingForGuard.status === 'CONVERTED') {
      const trackingOnly = Object.keys(data).every(k => ['trackingNumber', 'courierName'].includes(k) || data[k as keyof typeof data] === undefined);
      if (!trackingOnly) {
        throw new Error('Cannot update a converted Estimate — it already has a Sales Order.');
      }
    }

    const partyType = data.partyType;
    // Same CUSTOMER-only rule as createQuotation — but only override
    // customerId here when the caller actually sent a partyType (a plain
    // field-only PATCH, e.g. tracking info, must not clobber it to null).
    const customerId = partyType ? (partyType === 'CUSTOMER' ? data.customerId : undefined) : data.customerId;
    const updateData: any = {
      partyType: partyType as any,
      partyId: data.partyId,
      customerId,
      customerName: partyType === 'DEALER' || partyType === 'FRANCHISE' ? (data.customerName || undefined) : await resolveCustomerName(customerId, data.customerName),
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      status: data.status as any,
      notes: data.notes,
      termsConditions: data.termsConditions,
      stateOfSupply: data.stateOfSupply !== undefined ? (data.stateOfSupply || null) : undefined,
      validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
      quotationNumber: data.quotationNumber,
      trackingNumber: data.trackingNumber,
      courierName: data.courierName
    };

    return prisma.$transaction(async (tx) => {
      if (data.items) {
        const discountInput = data.discountAmount !== undefined ? data.discountAmount : 0;
        const { computed, subTotal, taxAmount, totalDiscount, totalAmount } = calculateTotals(data.items, discountInput);
        const roundOff = data.roundOffAmount || 0;
        const computedTotal = totalAmount + roundOff;

        updateData.subTotal = subTotal;
        updateData.taxAmount = taxAmount;
        // Store the server-computed (clamped) discount, not the raw
        // client-submitted figure — mirrors createQuotation.
        updateData.discountAmount = totalDiscount;
        // Same ±₹2 rounding-adjustment tolerance as createQuotation — a
        // forged totalAmount can't understate or inflate what the resolved
        // rate/tax/discount actually add up to.
        const clientTotal = (data as any).totalAmount;
        updateData.totalAmount = (clientTotal !== undefined && Math.abs(clientTotal - computedTotal) <= 2)
          ? clientTotal
          : computedTotal;

        // Delete old items
        await tx.quotationItem.deleteMany({ where: { quotationId: id } });
        
        // Recreate items
        updateData.items = {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            discountPercent: item.discountPercent || item.discountPct || 0,
            discountAmount: item.discountAmount || 0,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        };
      }

      const updated = await tx.quotation.update({
        where: { id },
        data: updateData,
        include: { customer: true, items: true }
      });

      if (updated.convertedOrderId) {
        await tx.salesOrder.update({
          where: { id: updated.convertedOrderId },
          data: {
            trackingNumber: data.trackingNumber || undefined,
            courierName: data.courierName || undefined
          }
        });
      }
      return updated;
    });
  }

  static async deleteQuotation(id: string) {
    return prisma.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      return tx.quotation.delete({ where: { id } });
    });
  }

  // ─── Document chain conversions ────────────────────────────────────────────
  // Estimate -> Sales Order -> Proforma Invoice -> Tax Invoice -> Payment.
  // Every step here: (1) validates the source doc and rejects a repeat
  // conversion via a real DB-unique marker (not just an app-level check —
  // see the @unique columns on SalesOrder.proformaInvoiceId and
  // ProformaInvoice.convertedInvoiceId), (2) copies every field forward so
  // the user never re-enters data, (3) runs inside one $transaction so a
  // failure never leaves the source doc marked converted without the target
  // doc actually existing.

  // Estimate -> Sales Order. This replaces the old convertQuotationToInvoice,
  // which skipped straight to a Tax Invoice — wrong per the confirmed chain.
  static async convertQuotationToSalesOrder(
    quotationId: string,
    createdBy: string,
    trackingData?: { trackingNumber?: string; courierName?: string; deliveryDate?: string; deliveryAddress?: string; dueDate?: string; }
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
        const quotation = await tx.quotation.findUnique({ where: { id: quotationId }, include: { items: true } });
        if (!quotation) throw new Error('Estimate not found.');

        if (quotation.status === 'CONVERTED' || quotation.convertedOrderId || quotation.convertedInvoiceId) {
          throw new Error('This estimate has already been converted.');
        }

        const orderDate = new Date();
        const DEFAULT_DUE_DAYS = 7;
        const dueDate = trackingData?.dueDate
          ? new Date(trackingData.dueDate)
          : new Date(orderDate.getTime() + DEFAULT_DUE_DAYS * 24 * 60 * 60 * 1000);

        const salesOrder = await tx.salesOrder.create({
          data: {
            orderNumber: await nextDocumentNumber(tx, 'SO', 'SO'),
            quotationId: quotation.id,
            partyType: quotation.partyType,
            partyId: quotation.partyId,
            customerId: quotation.customerId,
            customerName: quotation.customerName,
            customerPhone: quotation.customerPhone,
            status: 'DRAFT',
            subTotal: quotation.subTotal,
            taxAmount: quotation.taxAmount,
            discountAmount: quotation.discountAmount,
            totalAmount: quotation.totalAmount,
            orderDate,
            dueDate,
            stateOfSupply: quotation.stateOfSupply,
            deliveryDate: trackingData?.deliveryDate ? new Date(trackingData.deliveryDate) : undefined,
            deliveryAddress: trackingData?.deliveryAddress || undefined,
            trackingNumber: trackingData?.trackingNumber || undefined,
            courierName: trackingData?.courierName || undefined,
            notes: quotation.notes,
            createdBy,
            items: {
              create: quotation.items.map((item) => ({
                productId: item.productId,
                productName: item.productName,
                quantity: item.quantity,
                unit: item.unit,
                rate: item.rate,
                discountPercent: item.discountPercent || 0,
                discountAmount: item.discountAmount || 0,
                taxPercent: item.taxPercent,
                taxAmount: item.taxAmount,
                totalAmount: item.totalAmount,
              })),
            },
          },
          include: { items: true },
        });

        await tx.quotation.update({
          where: { id: quotationId },
          data: { status: 'CONVERTED', convertedOrderId: salesOrder.id },
        });

        return {
          success: true,
          estimate: {
            id: quotation.id,
            estimateNo: quotation.quotationNumber,
            status: 'CONVERTED'
          },
          salesOrder
        };
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const quotationNow = await prisma.quotation.findUnique({ where: { id: quotationId } });
        if (quotationNow?.convertedOrderId) {
          const existing = await prisma.salesOrder.findUnique({ where: { id: quotationNow.convertedOrderId }, include: { items: true } });
          if (existing) {
            return {
              success: true,
              estimate: { id: quotationNow.id, estimateNo: quotationNow.quotationNumber, status: 'CONVERTED' },
              salesOrder: existing
            };
          }
        }
      }
      throw err;
    }
  }

  static async convertQuotationToSale(
    quotationId: string,
    createdBy: string,
    payload?: { franchiseId?: string; paymentType?: string; notes?: string }
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
        const quotation = await tx.quotation.findUnique({
          where: { id: quotationId },
          include: { items: true }
        });
        if (!quotation) throw new Error('Estimate not found.');

        if (quotation.status === 'CONVERTED' || quotation.convertedInvoiceId || quotation.convertedOrderId) {
          throw new Error('This estimate has already been converted.');
        }

        let franchiseId = payload?.franchiseId;
        if (!franchiseId) {
          const hq = await FranchiseService.getHqFranchiseOrNull();
          franchiseId = hq?.id || '';
        }
        if (!franchiseId) {
          // No arbitrary franchise may stand in for HQ (see
          // convertProformaToInvoice's stricter check) — an unconfigured
          // HQ must fail loudly, not silently attribute the sale to
          // whichever franchise happens to be first in the table.
          throw new Error('No HQ franchise is configured (Franchise.isHQ). Set isHQ=true on exactly one franchise before converting an estimate to a Sale/Invoice.');
        }

        const invoiceNum = await nextDocumentNumber(tx, 'INV', 'INV');

        // Resolve a valid Product.id for each OrderItem (FK constraint on OrderItem.productId)
        const allProducts = await tx.product.findMany();
        const orderItemsData: Array<{ productId: string; quantity: number; unit: string; price: number; discountPct: number; taxAmount: number; totalAmount: number }> = [];

        for (const item of quotation.items) {
          let validProductId = item.productId || '';
          // Id/SKU only — a name-based match (or "just grab any product")
          // can silently attach the wrong size variant (e.g. APPAM 450g
          // resolving to APPAM 900g) or an unrelated product entirely.
          const productMatch = allProducts.find(p => p.id === validProductId || (p.sku && p.sku === item.productId));

          if (productMatch) {
            validProductId = productMatch.id;
          } else if (item.productId) {
            const invItem = await tx.inventoryItem.findUnique({ where: { id: item.productId } });
            const matchedBySku = invItem?.sku ? allProducts.find(p => p.sku === invItem.sku) : undefined;
            if (matchedBySku) {
              validProductId = matchedBySku.id;
            } else {
              // The client referenced a specific productId that resolves to
              // neither a real Product nor a matching InventoryItem SKU —
              // erroring here is safer than silently billing a different
              // product than what was actually quoted.
              throw new Error(`Cannot convert: line item "${item.productName}" references productId "${item.productId}", which does not match any known Product or InventoryItem SKU.`);
            }
          }

          if (!validProductId) {
            // No productId was ever provided — a genuine free-text/custom
            // line (e.g. a one-off service charge) with nothing to link to.
            const newProd = await tx.product.create({
              data: {
                name: item.productName || 'General Item',
                basePrice: item.rate,
                taxPercent: item.taxPercent || 0,
              }
            });
            validProductId = newProd.id;
          }

          orderItemsData.push({
            productId: validProductId,
            quantity: item.quantity,
            unit: item.unit || 'NONE',
            price: item.rate,
            discountPct: item.discountPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount,
          });
        }

        const order = await tx.order.create({
          data: {
            invoiceNum,
            partyType: quotation.partyType,
            partyId: quotation.partyId,
            customerId: quotation.customerId,
            franchiseId,
            orderType: 'DINE_IN',
            status: 'COMPLETED',
            subTotal: quotation.subTotal,
            taxAmount: quotation.taxAmount,
            discountAmount: quotation.discountAmount,
            totalAmount: quotation.totalAmount,
            paymentStatus: 'UNPAID',
            paymentType: payload?.paymentType || 'CASH',
            stateOfSupply: quotation.stateOfSupply,
            inventory_deducted: true,
            sourceQuotationId: quotation.id,
            orderItems: {
              create: orderItemsData
            }
          },
          include: { orderItems: true }
        });

        const invoice = await tx.invoice.create({
          data: {
            orderId: order.id,
            totalAmount: quotation.subTotal - quotation.discountAmount,
            taxAmount: quotation.taxAmount,
            finalAmount: quotation.totalAmount,
            status: 'PENDING',
            termsAndConditions: quotation.termsConditions || null,
            notes: quotation.notes || null,
          }
        });

        await tx.quotation.update({
          where: { id: quotationId },
          data: { status: 'CONVERTED', convertedInvoiceId: order.id },
        });

        return {
          success: true,
          estimate: {
            id: quotation.id,
            estimateNo: quotation.quotationNumber,
            status: 'CONVERTED'
          },
          sale: order,
          invoice
        };
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const quotationNow = await prisma.quotation.findUnique({ where: { id: quotationId } });
        if (quotationNow?.convertedInvoiceId) {
          const existing = await prisma.order.findUnique({ where: { id: quotationNow.convertedInvoiceId }, include: { orderItems: true } });
          if (existing) {
            return {
              success: true,
              estimate: { id: quotationNow.id, estimateNo: quotationNow.quotationNumber, status: 'CONVERTED' },
              sale: existing
            };
          }
        }
      }
      throw err;
    }
  }

  // Sales Order -> Sale Invoice (Tax Invoice).
  static async convertSalesOrderToSale(
    salesOrderId: string,
    createdBy: string,
    payload?: { franchiseId?: string; paymentType?: string; notes?: string }
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
        const salesOrder = await tx.salesOrder.findUnique({
          where: { id: salesOrderId },
          include: { items: true }
        });
        if (!salesOrder) throw new Error('Sales Order not found.');
        if (salesOrder.status === 'DELIVERED' || (salesOrder.status as string) === 'CLOSED' || (salesOrder.status as string) === 'CONVERTED') {
          throw new Error('This Sales Order has already been converted.');
        }

        let franchiseId = payload?.franchiseId;
        if (!franchiseId) {
          const hq = await FranchiseService.getHqFranchiseOrNull();
          franchiseId = hq?.id || '';
        }
        if (!franchiseId) {
          // No arbitrary franchise may stand in for HQ (see
          // convertProformaToInvoice's stricter check) — an unconfigured
          // HQ must fail loudly, not silently attribute the sale to
          // whichever franchise happens to be first in the table.
          throw new Error('No HQ franchise is configured (Franchise.isHQ). Set isHQ=true on exactly one franchise before converting a Sales Order to a Sale/Invoice.');
        }

        const invoiceNum = await nextDocumentNumber(tx, 'INV', 'INV');
        const allProducts = await tx.product.findMany();
        const orderItemsData: Array<{ productId: string; quantity: number; unit: string; price: number; discountPct: number; taxAmount: number; totalAmount: number }> = [];

        for (const item of salesOrder.items) {
          let validProductId = item.productId || '';
          // Id/SKU only — see convertQuotationToSale for why a name-based
          // or "first product" fallback is a variant-cross-contamination
          // risk (e.g. APPAM 450g silently resolving to APPAM 900g).
          const productMatch = allProducts.find(p => p.id === validProductId || (p.sku && p.sku === item.productId));
          if (productMatch) {
            validProductId = productMatch.id;
          } else if (item.productId) {
            throw new Error(`Cannot convert: line item "${item.productName}" references productId "${item.productId}", which does not match any known Product/SKU.`);
          }
          if (!validProductId) {
            // No productId was ever provided — a genuine free-text/custom line.
            const newProd = await tx.product.create({
              data: {
                name: item.productName || 'General Item',
                basePrice: item.rate,
                taxPercent: item.taxPercent || 0,
              }
            });
            validProductId = newProd.id;
          }

          orderItemsData.push({
            productId: validProductId,
            quantity: item.quantity,
            unit: item.unit || 'NONE',
            price: item.rate,
            discountPct: item.discountPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount,
          });
        }

        const order = await tx.order.create({
          data: {
            invoiceNum,
            partyType: salesOrder.partyType || 'CUSTOMER',
            partyId: salesOrder.partyId,
            customerId: salesOrder.customerId,
            franchiseId,
            orderType: 'DINE_IN',
            status: 'COMPLETED',
            subTotal: salesOrder.subTotal,
            taxAmount: salesOrder.taxAmount,
            discountAmount: salesOrder.discountAmount,
            totalAmount: salesOrder.totalAmount,
            paymentStatus: 'UNPAID',
            paymentType: payload?.paymentType || 'CASH',
            stateOfSupply: salesOrder.stateOfSupply,
            inventory_deducted: true,
            orderItems: {
              create: orderItemsData
            }
          },
          include: { orderItems: true }
        });

        const invoice = await tx.invoice.create({
          data: {
            orderId: order.id,
            totalAmount: salesOrder.subTotal - salesOrder.discountAmount,
            taxAmount: salesOrder.taxAmount,
            finalAmount: salesOrder.totalAmount,
            status: 'PENDING',
            notes: salesOrder.notes || null,
          }
        });

        await tx.salesOrder.update({
          where: { id: salesOrderId },
          data: { status: 'DELIVERED' },
        });

        return {
          success: true,
          salesOrder: {
            id: salesOrder.id,
            orderNo: salesOrder.orderNumber,
            status: 'DELIVERED'
          },
          sale: order,
          invoice
        };
      });
    } catch (err: any) {
      throw err;
    }
  }

  // Sales Order -> Proforma Invoice.
  static async convertSalesOrderToProforma(salesOrderId: string, createdBy: string) {
    try {
      return await prisma.$transaction(async (tx) => {
      const salesOrder = await tx.salesOrder.findUnique({ where: { id: salesOrderId }, include: { items: true } });
      if (!salesOrder) throw new Error('Sales Order not found.');
      if (salesOrder.proformaInvoiceId) {
        const existing = await tx.proformaInvoice.findUnique({ where: { id: salesOrder.proformaInvoiceId }, include: { items: true } });
        if (existing) return existing;
      }
      if (salesOrder.status !== 'CONFIRMED') {
        throw new Error(`Only a CONFIRMED Sales Order can generate a Proforma Invoice (current status: ${salesOrder.status}).`);
      }

      const proforma = await tx.proformaInvoice.create({
        data: {
          proformaNumber: await nextDocumentNumber(tx, 'PI', 'PI'),
          sourceSalesOrderId: salesOrder.id,
          partyType: salesOrder.partyType,
          partyId: salesOrder.partyId,
          customerId: salesOrder.customerId,
          customerName: salesOrder.customerName,
          customerPhone: salesOrder.customerPhone,
          stateOfSupply: salesOrder.stateOfSupply || undefined,
          status: 'DRAFT',
          subTotal: salesOrder.subTotal,
          taxAmount: salesOrder.taxAmount,
          discountAmount: salesOrder.discountAmount,
          totalAmount: salesOrder.totalAmount,
          notes: salesOrder.notes,
          createdBy,
          items: {
            create: salesOrder.items.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              discountPercent: item.discountPercent || 0,
              discountAmount: item.discountAmount || 0,
              taxPercent: item.taxPercent,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { items: true },
      });

      // DRAFT -> CONFIRMED -> PROCESSING is the intended lifecycle: this is
      // the one meaningful transition point ("this order's Proforma now
      // exists, fulfillment is underway") — previously PROCESSING was only
      // ever set two hops downstream (in convertProformaToInvoice, when the
      // Proforma became a Tax Invoice), which left it looking like an
      // unexplained, disconnected status in the Sales Order list.
      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { proformaInvoiceId: proforma.id, status: 'PROCESSING' },
      });

      return proforma;
      });
    } catch (err: any) {
      // True concurrent double-click/multi-tab race backstop — the DB-level
      // @unique on SalesOrder.proformaInvoiceId is what actually stops a
      // second row from persisting; return the winner's row instead of
      // erroring.
      if (err?.code === 'P2002') {
        const salesOrderNow = await prisma.salesOrder.findUnique({ where: { id: salesOrderId } });
        if (salesOrderNow?.proformaInvoiceId) {
          const existing = await prisma.proformaInvoice.findUnique({ where: { id: salesOrderNow.proformaInvoiceId }, include: { items: true } });
          if (existing) return existing;
        }
      }
      throw err;
    }
  }

  // Proforma Invoice -> Tax Invoice (Order + Invoice).
  static async convertProformaToInvoice(proformaInvoiceId: string, createdBy: string) {
    const proforma = await prisma.proformaInvoice.findUnique({ where: { id: proformaInvoiceId }, include: { items: true } });
    if (!proforma) throw new Error('Proforma Invoice not found.');
    if (proforma.convertedInvoiceId) {
      const existing = await prisma.order.findUnique({ where: { id: proforma.convertedInvoiceId }, include: { orderItems: true, invoice: true } });
      if (existing) return existing;
    }
    if (proforma.status === 'CANCELLED') {
      throw new Error('Cannot convert a cancelled Proforma Invoice.');
    }

    const missingProduct = proforma.items.find(i => !i.productId);
    if (missingProduct) {
      throw new Error(`Item "${missingProduct.productName}" is missing a valid Product ID. Custom items without an inventory mapping cannot be converted to a Tax Invoice.`);
    }

    // The full source chain, when this Proforma came from a Sales Order
    // that itself came from an Estimate — kept for traceability even though
    // Order only has direct FKs to the immediate parent (proforma) and the
    // original Estimate (sourceQuotationId), not the Sales Order itself.
    const sourceSalesOrder = proforma.sourceSalesOrderId
      ? await prisma.salesOrder.findUnique({ where: { id: proforma.sourceSalesOrderId } })
      : null;

    // "First active franchise" is not a valid definition of HQ — the Tax
    // Invoice this creates must be owned by the real HQ franchise, not an
    // arbitrary branch that happened to be created first.
    const hq = await FranchiseService.getHqFranchiseOrNull();
    if (!hq) throw new Error('No HQ franchise is configured (Franchise.isHQ). Set isHQ=true on exactly one franchise before converting to a Tax Invoice.');
    const franchiseId = hq.id;

    try {
      return await prisma.$transaction(async (tx) => {
      // Ensure all items have a corresponding Product row since OrderItem
      // requires a hard relation to Product in the schema. Proforma items
      // carry an InventoryItem ID (not a Product ID) whenever the frontend
      // picked from the InventoryItem catalog, and InventoryItem sync
      // (see syncProductFromInventoryItem) already auto-creates a Product
      // for that SKU under its own generated ID — so resolve by SKU before
      // ever creating, or this collides with that existing Product's
      // @unique sku the moment one already exists (which, for any synced
      // Finished/Semi-Finished item, is effectively always).
      const resolvedProductIds = new Map<string, string>(); // item.productId (as sent) -> real Product.id
      for (const item of proforma.items) {
        if (!item.productId) continue;
        let existingProduct = await tx.product.findUnique({ where: { id: item.productId } });
        if (!existingProduct) {
          const invItem = await tx.inventoryItem.findUnique({ where: { id: item.productId } });
          if (!invItem) {
            throw new Error(`Item "${item.productName}" is missing a valid mapped Product or InventoryItem.`);
          }
          existingProduct = await tx.product.findUnique({ where: { sku: invItem.sku } });
          if (!existingProduct) {
            // Seed from the channel this Proforma was actually priced
            // under, not unconditionally the customer price — a
            // Dealer/Franchise Proforma converting here would otherwise
            // seed a brand-new Product's basePrice from the wrong channel.
            const channelBasePrice =
              proforma.partyType === 'DEALER' ? invItem.dealerPrice :
              proforma.partyType === 'FRANCHISE' ? invItem.franchisePrice :
              invItem.customerPrice;
            existingProduct = await tx.product.create({
              data: {
                id: invItem.id, // Keep exact same ID so the FK succeeds
                name: invItem.name,
                sku: invItem.sku,
                basePrice: (channelBasePrice && channelBasePrice > 0) ? channelBasePrice : (invItem.basePrice || 0),
                productType: 'FINISHED_GOOD',
                category: invItem.category,
                taxPercent: invItem.gstRate || 5,
                hsnCode: invItem.hsnCode,
                isActive: true,
                isVeg: true,
                is_menu_item: false
              }
            });
          }
        }
        resolvedProductIds.set(item.productId, existingProduct.id);
      }

      const newOrder = await tx.order.create({
        data: {
          invoiceNum: await nextDocumentNumber(tx, 'INV', 'INV'),
          partyType: proforma.partyType || 'CUSTOMER',
          partyId: proforma.partyId,
          customerId: proforma.customerId,
          customerName: proforma.customerName,
          franchiseId: franchiseId!,
          stateOfSupply: proforma.stateOfSupply || undefined,
          orderType: 'TAX_INVOICE',
          status: 'PENDING',
          paymentStatus: 'UNPAID',
          subTotal: proforma.subTotal,
          taxAmount: proforma.taxAmount,
          discountAmount: proforma.discountAmount,
          totalAmount: proforma.totalAmount,
          sourceQuotationId: sourceSalesOrder?.quotationId || undefined,
          sourceProformaInvoiceId: proforma.id,
          orderItems: {
            create: proforma.items.map((item) => ({
              productId: resolvedProductIds.get(item.productId!)!,
              quantity: item.quantity,
              unit: item.unit || 'NONE',
              price: item.rate,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { orderItems: true },
      });

      // Initial payment state is always zero — a Tax Invoice never carries
      // money forward from the Estimate/Proforma stage (see money rules:
      // no cash/bank movement before this point). 'UNPAID' regardless of
      // whatever total is owed; Customer Payments is the only thing
      // allowed to move this status (see FinanceService.createPayment).
      await tx.invoice.create({
        data: {
          orderId: newOrder.id,
          totalAmount: proforma.subTotal,
          taxAmount: proforma.taxAmount,
          finalAmount: proforma.totalAmount,
          status: 'UNPAID',
          description: `Generated from Proforma Invoice ${proforma.proformaNumber}`,
          notes: proforma.notes,
        },
      });

      await tx.proformaInvoice.update({
        where: { id: proformaInvoiceId },
        data: { status: 'CONVERTED', convertedInvoiceId: newOrder.id },
      });

      // sourceSalesOrder.status is already 'PROCESSING' by this point — set
      // at Proforma-creation time in convertSalesOrderToProforma, the actual
      // causal moment for that transition (see comment there).

      return newOrder;
      });
    } catch (err: any) {
      // True concurrent double-click/multi-tab race: two requests both
      // passed the `if (proforma.convertedInvoiceId)` check above before
      // either committed. The DB-level @unique on convertedInvoiceId is the
      // hard backstop — the loser hits P2002 here instead of creating a
      // second Tax Invoice; return the winner's row instead of erroring.
      if (err?.code === 'P2002') {
        const proformaNow = await prisma.proformaInvoice.findUnique({ where: { id: proformaInvoiceId } });
        if (proformaNow?.convertedInvoiceId) {
          const existing = await prisma.order.findUnique({ where: { id: proformaNow.convertedInvoiceId }, include: { orderItems: true, invoice: true } });
          if (existing) return existing;
        }
      }
      throw err;
    }
  }

  // Proforma Invoice -> Sales Order.
  static async convertProformaToSalesOrder(proformaInvoiceId: string, createdBy: string) {
    const proforma = await prisma.proformaInvoice.findUnique({ where: { id: proformaInvoiceId }, include: { items: true } });
    if (!proforma) throw new Error('Proforma Invoice not found.');
    if (proforma.status === 'CANCELLED') {
      throw new Error('Cannot convert a cancelled Proforma Invoice.');
    }

    const existingSO = await prisma.salesOrder.findFirst({
      where: { proformaInvoiceId: proforma.id }
    });
    if (existingSO) {
      return { success: true, salesOrder: existingSO };
    }

    return prisma.$transaction(async (tx) => {
      const salesOrder = await tx.salesOrder.create({
        data: {
          orderNumber: await nextDocumentNumber(tx, 'SO', 'SO'),
          partyType: proforma.partyType || 'CUSTOMER',
          partyId: proforma.partyId,
          customerId: proforma.customerId,
          customerName: proforma.customerName,
          customerPhone: proforma.customerPhone,
          stateOfSupply: proforma.stateOfSupply,
          status: 'CONFIRMED',
          subTotal: proforma.subTotal,
          taxAmount: proforma.taxAmount,
          discountAmount: proforma.discountAmount,
          totalAmount: proforma.totalAmount,
          notes: proforma.notes,
          proformaInvoiceId: proforma.id,
          items: {
            create: proforma.items.map(it => ({
              productId: it.productId,
              productName: it.productName,
              quantity: it.quantity,
              unit: it.unit || 'NONE',
              rate: it.rate,
              discountPercent: it.discountPercent || 0,
              discountAmount: it.discountAmount || 0,
              taxPercent: it.taxPercent || 0,
              taxAmount: it.taxAmount || 0,
              totalAmount: it.totalAmount
            }))
          }
        },
        include: { items: true }
      });

      await tx.proformaInvoice.update({
        where: { id: proforma.id },
        data: { status: 'CONVERTED' }
      });

      return { success: true, salesOrder };
    });
  }

  static async createProformaInvoice(data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    stateOfSupply?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    paymentTerms?: string;
    notes?: string;
    createdBy?: string;
    proformaNumber?: string;
    status?: any;
  }) {
    const discount = data.discountAmount || 0;
    const partyType = data.partyType || 'CUSTOMER';
    // ProformaInvoice, like Quotation, has no franchise scope of its own —
    // resolve against HQ-scoped InventoryItems.
    const pricedItems = await applyAuthoritativePricing(prisma, data.items, null, partyType);
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(pricedItems, discount);
    const customerId = partyType === 'CUSTOMER' ? data.customerId : undefined;
    const customerName = partyType === 'CUSTOMER' ? await resolveCustomerName(customerId, data.customerName) : (data.customerName || undefined);

    return prisma.$transaction(async (tx) => tx.proformaInvoice.create({
      data: {
        proformaNumber: data.proformaNumber || await nextDocumentNumber(tx, 'PI', 'PI'),
        partyType: partyType as any,
        partyId: data.partyId,
        customerId,
        customerName,
        customerPhone: data.customerPhone,
        stateOfSupply: data.stateOfSupply || undefined,
        status: data.status || 'DRAFT',
        subTotal,
        taxAmount,
        // A forged/negative document discount can't exceed the bill or
        // drive the total negative — same clamp as calculateTotals' own
        // per-line bound, applied here since this document-level discount
        // is layered on top of calculateTotals' result rather than fed
        // through it.
        discountAmount: Math.max(0, Math.min(discount, totalAmount)),
        totalAmount: Math.max(0, totalAmount - Math.max(0, Math.min(discount, totalAmount))),
        paymentTerms: data.paymentTerms,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            discountPercent: item.discountPercent || item.discountPct || 0,
            discountAmount: item.discountAmount || 0,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount,
          })),
        },
      },
      include: { items: true, customer: true },
    }));
  }

  static async updateProformaInvoice(id: string, data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    stateOfSupply?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    paymentTerms?: string;
    notes?: string;
    status?: any;
  }) {
    const existing = await prisma.proformaInvoice.findUnique({ where: { id } });
    if (!existing) throw new Error('Proforma Invoice not found');
    if (existing.status !== 'DRAFT') throw new Error(`Cannot update Proforma Invoice in ${existing.status} status`);

    const discount = data.discountAmount || 0;
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items, discount);
    const partyType = data.partyType || existing.partyType || 'CUSTOMER';
    const customerId = partyType === 'CUSTOMER' ? (data.customerId || existing.customerId) : undefined;
    const customerName = partyType === 'CUSTOMER' ? await resolveCustomerName(customerId || undefined, data.customerName) : (data.customerName || undefined);

    // deleteMany-then-create replaces the item set in two separate writes —
    // under the default READ COMMITTED isolation, two concurrent updates to
    // the same Proforma (e.g. a double-clicked Back/Save button with no
    // client-side re-entrancy guard) can each pass the deleteMany before
    // either commits its create, leaving every line item duplicated even
    // though the submitted payload only ever had one copy each. Serializable
    // isolation makes Postgres abort the loser with a retryable conflict
    // instead of silently interleaving the two — the frontend's existing
    // catch/toast surfaces that as "failed to save", which is correct: the
    // save didn't happen, rather than happening twice.
    return prisma.$transaction(async (tx) => {
      await tx.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: id } });

      return tx.proformaInvoice.update({
        where: { id },
        data: {
          partyType: partyType as any,
          partyId: data.partyId !== undefined ? data.partyId : existing.partyId,
          customerId,
          customerName,
          customerPhone: data.customerPhone !== undefined ? data.customerPhone : existing.customerPhone,
          status: data.status || existing.status,
          subTotal,
          taxAmount,
          discountAmount: Math.max(0, Math.min(discount, totalAmount)),
          totalAmount: Math.max(0, totalAmount - Math.max(0, Math.min(discount, totalAmount))),
          paymentTerms: data.paymentTerms !== undefined ? data.paymentTerms : existing.paymentTerms,
          stateOfSupply: data.stateOfSupply !== undefined ? (data.stateOfSupply || null) : (existing as any).stateOfSupply,
          notes: data.notes !== undefined ? data.notes : existing.notes,
          items: {
            create: computed.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              discountPercent: item.discountPercent || item.discountPct || 0,
              discountAmount: item.discountAmount || 0,
              taxPercent: item.taxPercent || 0,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { items: true, customer: true },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  static async updateProformaStatus(id: string, status: any) {
    const existing = await prisma.proformaInvoice.findUnique({ where: { id } });
    if (!existing) throw new Error('Proforma Invoice not found');
    
    return prisma.proformaInvoice.update({
      where: { id },
      data: { status },
      include: { items: true, customer: true },
    });
  }

  static async getProformaInvoices(filters: {
    status?: string;
    customerId?: string;
    search?: string;
    fromDate?: string;
    toDate?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const where: any = {};
    if (filters.status && filters.status !== 'ALL') where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.fromDate || filters.toDate || filters.startDate || filters.endDate) {
      const startStr = (filters.fromDate || filters.startDate) as string;
      const endStr = (filters.toDate || filters.endDate) as string;
      const createdAtFilter: any = {};
      if (startStr) {
        createdAtFilter.gte = new Date(startStr.includes('T') ? startStr : `${startStr}T00:00:00.000`);
      }
      if (endStr) {
        createdAtFilter.lte = new Date(endStr.includes('T') ? endStr : `${endStr}T23:59:59.999`);
      }
      where.createdAt = createdAtFilter;
    }
    if (filters.search && filters.search.trim()) {
      const s = filters.search.trim();
      where.OR = [
        { proformaNumber: { contains: s, mode: 'insensitive' } },
        { customerName: { contains: s, mode: 'insensitive' } },
        { customer: { name: { contains: s, mode: 'insensitive' } } }
      ];
    }
    const results = await prisma.proformaInvoice.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' },
    });

    const soIds = results.map((r: any) => r.sourceSalesOrderId).filter(Boolean) as string[];
    const convertedInvIds = results.map((r: any) => r.convertedInvoiceId).filter(Boolean) as string[];

    let soMap = new Map<string, string>();
    if (soIds.length > 0) {
      const salesOrders = await prisma.salesOrder.findMany({
        where: { id: { in: soIds } },
        select: { id: true, orderNumber: true }
      });
      soMap = new Map(salesOrders.map(so => [so.id, so.orderNumber]));
    }

    let invMap = new Map<string, string>();
    if (convertedInvIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { id: { in: convertedInvIds } },
        select: { id: true, invoiceNum: true }
      });
      invMap = new Map(orders.map(o => [o.id, o.invoiceNum || o.id]));
    }

    return results.map((r: any) => ({
      ...r,
      sourceSalesOrderNumber: r.sourceSalesOrderId ? soMap.get(r.sourceSalesOrderId) : undefined,
      convertedInvoiceNumber: r.convertedInvoiceId ? invMap.get(r.convertedInvoiceId) : undefined
    }));
  }

  static async getProformaInvoiceById(id: string) {
    const proforma = await prisma.proformaInvoice.findUnique({
      where: { id },
      include: { customer: true, items: true },
    });

    if (proforma?.sourceSalesOrderId) {
      const so = await prisma.salesOrder.findUnique({
        where: { id: proforma.sourceSalesOrderId },
        select: { orderNumber: true }
      });
      if (so) {
        (proforma as any).sourceSalesOrderNumber = so.orderNumber;
      }
    }

    return proforma;
  }

  // ─── Sales Orders ────────────────────────────────────────────────────────────

  static async getSalesOrders(filters: { status?: string; customerId?: string; search?: string; startDate?: string; endDate?: string }) {
    const where: any = {};
    if (filters.status && filters.status !== 'ALL') {
      if (filters.status === 'OPEN') {
        where.status = { in: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED'] };
      } else if (filters.status === 'CLOSED') {
        where.status = 'DELIVERED';
      } else {
        where.status = filters.status as any;
      }
    }
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {
        ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
        ...(filters.endDate ? { lte: new Date(filters.endDate) } : {})
      };
    }
    if (filters.search) {
      where.OR = [
        { orderNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    const orders = await prisma.salesOrder.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });

    const completedOrders = orders.filter(o => o.status === 'DELIVERED' || (o.status as string) === 'CLOSED' || (o.status as string) === 'CONVERTED');

    if (completedOrders.length === 0) return orders;

    const proformaIds = completedOrders.map(o => o.proformaInvoiceId).filter(Boolean) as string[];
    const quotationIds = completedOrders.map(o => o.quotationId).filter(Boolean) as string[];
    const customerIds = completedOrders.map(o => o.customerId).filter(Boolean) as string[];

    const [proformas, quotations, allSaleOrders] = await Promise.all([
      proformaIds.length ? prisma.proformaInvoice.findMany({ where: { id: { in: proformaIds } } }) : [],
      quotationIds.length ? prisma.quotation.findMany({ where: { id: { in: quotationIds } } }) : [],
      customerIds.length ? prisma.order.findMany({
        where: { customerId: { in: customerIds } },
        select: { id: true, invoiceNum: true, customerId: true, totalAmount: true, createdAt: true },
        orderBy: { createdAt: 'desc' }
      }) : []
    ]);

    const proformaMap = new Map<string, any>();
    for (const p of proformas) proformaMap.set(p.id, p);

    const quotationMap = new Map<string, any>();
    for (const q of quotations) quotationMap.set(q.id, q);

    const saleOrdersByCustomer = new Map<string, any[]>();

    for (const sale of allSaleOrders) {
      if (sale.customerId) {
        const list = saleOrdersByCustomer.get(sale.customerId) || [];
        list.push(sale);
        saleOrdersByCustomer.set(sale.customerId, list);
      }
    }

    return orders.map(so => {
      let convertedInvoiceId: string | null = null;
      let convertedInvoiceNumber: string | null = null;

      if (so.proformaInvoiceId && proformaMap.has(so.proformaInvoiceId)) {
        const prof = proformaMap.get(so.proformaInvoiceId);
        if (prof?.convertedInvoiceId) {
          const inv = allSaleOrders.find(s => s.id === prof.convertedInvoiceId);
          if (inv) {
            convertedInvoiceId = inv.id;
            convertedInvoiceNumber = inv.invoiceNum;
          }
        }
      }

      if (!convertedInvoiceNumber && so.quotationId && quotationMap.has(so.quotationId)) {
        const quot = quotationMap.get(so.quotationId);
        if (quot?.convertedInvoiceId) {
          const inv = allSaleOrders.find(s => s.id === quot.convertedInvoiceId);
          if (inv) {
            convertedInvoiceId = inv.id;
            convertedInvoiceNumber = inv.invoiceNum;
          }
        }
      }

      if (!convertedInvoiceNumber && (so.status === 'DELIVERED' || (so.status as string) === 'CLOSED' || (so.status as string) === 'CONVERTED') && so.customerId) {
        const customerSales = saleOrdersByCustomer.get(so.customerId) || [];
        const match = customerSales.find(s => Math.abs(s.totalAmount - so.totalAmount) < 0.05);
        if (match) {
          convertedInvoiceId = match.id;
          convertedInvoiceNumber = match.invoiceNum;
        } else if (customerSales.length > 0) {
          convertedInvoiceId = customerSales[0].id;
          convertedInvoiceNumber = customerSales[0].invoiceNum;
        }
      }

      return {
        ...so,
        convertedInvoiceId,
        convertedInvoiceNumber
      };
    });
  }

  static async getSalesOrderById(id: string) {
    const order = await prisma.salesOrder.findUnique({
      where: { id },
      include: { customer: true, items: true, returns: true }
    });
    if (order?.quotationId) {
      const quotation = await prisma.quotation.findUnique({ where: { id: order.quotationId } });
      return { ...order, quotation };
    }
    return order;
  }

  static async createSalesOrder(data: {
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    stateOfSupply?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    deliveryDate?: string;
    deliveryAddress?: string;
    orderDate?: string;
    dueDate?: string;
    notes?: string;
    createdBy?: string;
    idempotencyKey?: string;
  }) {
    // Unlike convertQuotationToSalesOrder (deduped against its source
    // Estimate) this is the direct-create path with no source document to
    // key off — a retry/double-click/API re-entry with the same key must
    // return the already-created SalesOrder instead of posting a second
    // one. Mirrors FinanceService.createPayment's idempotencyKey handling.
    if (data.idempotencyKey) {
      const existing = await prisma.salesOrder.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return existing;
    }

    const discount = data.discountAmount || 0;
    // Direct Sales Order creation has no Dealer/Franchise selector in the
    // UI today (only conversion from Estimate/Proforma carries partyType)
    // — resolve against the Customer channel only, matching current
    // capability rather than inventing a party mechanism that doesn't
    // exist here.
    const pricedItems = await applyAuthoritativePricing(prisma, data.items, null, 'CUSTOMER');
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(pricedItems, discount);

    try {
      return await prisma.$transaction(async (tx) => tx.salesOrder.create({
      data: {
        orderNumber: await nextDocumentNumber(tx, 'SO', 'SO'),
        idempotencyKey: data.idempotencyKey || undefined,
        customerId: data.customerId,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        stateOfSupply: data.stateOfSupply || undefined,
        subTotal,
        taxAmount,
        discountAmount: Math.max(0, Math.min(discount, totalAmount)),
        totalAmount: Math.max(0, totalAmount - Math.max(0, Math.min(discount, totalAmount))),
        orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined,
        deliveryAddress: data.deliveryAddress,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            discountPercent: item.discountPercent || item.discountPct || 0,
            discountAmount: item.discountAmount || 0,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { customer: true, items: true }
      }));
    } catch (err: any) {
      // True concurrent double-click race: two requests both passed the
      // idempotencyKey check above before either committed. The @unique
      // constraint is the hard backstop — return the winner's row.
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.salesOrder.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  static async updateSalesOrder(id: string, data: any) {
    // proformaInvoiceId is a duplicate-prevention marker only the atomic
    // convertSalesOrderToProforma() transaction is allowed to set — a
    // generic PATCH must never let a client fake "a Proforma already
    // exists" (or clear a real one) directly. items is handled separately
    // below (nested create, not a raw array), so it must not be spread
    // as-is into Prisma's `data` — that's what used to crash this call.
    const {
      proformaInvoiceId,
      items,
      _rawState,
      rawState,
      selectedCustomer,
      customerSearch,
      customerPhone,
      termsText,
      description,
      roundOffEnabled,
      paymentType,
      priceMode,
      taxLabel,
      customer,
      id: _id,
      createdAt,
      updatedAt,
      ...safeData
    } = data;

    // subTotal/taxAmount/discountAmount/totalAmount are deliberately NOT
    // whitelisted here — a bare PATCH with no `items` must never be able to
    // overwrite the stored financial totals directly. They're only ever
    // set below, as a byproduct of recomputing from `items` via
    // calculateTotals.
    const validKeys = [
      'orderNumber',
      'quotationId',
      'idempotencyKey',
      'partyType',
      'partyId',
      'customerId',
      'customerName',
      'customerPhone',
      'status',
      'orderDate',
      'dueDate',
      'stateOfSupply',
      'deliveryDate',
      'deliveryAddress',
      'trackingNumber',
      'courierName',
      'notes',
      'createdBy',
      'paymentStatus',
    ];

    const cleanSafeData: any = {};
    for (const key of validKeys) {
      if (key in safeData && safeData[key] !== undefined) {
        cleanSafeData[key] = safeData[key];
      }
    }

    const updateData: any = {
      ...cleanSafeData,
      status: cleanSafeData.status ? (cleanSafeData.status === 'CLOSED' ? 'DELIVERED' : cleanSafeData.status) : undefined,
      deliveryDate: cleanSafeData.deliveryDate ? new Date(cleanSafeData.deliveryDate) : undefined,
      orderDate: cleanSafeData.orderDate ? new Date(cleanSafeData.orderDate) : undefined,
      dueDate: cleanSafeData.dueDate ? new Date(cleanSafeData.dueDate) : undefined
    };

    return prisma.$transaction(async (tx) => {
      if (items) {
        const discount = data.discountAmount || 0;
        const { computed, subTotal, taxAmount, totalDiscount, totalAmount } = calculateTotals(items as any[], discount);

        updateData.subTotal = subTotal;
        updateData.taxAmount = taxAmount;
        // Server-computed (clamped) discount, not the raw client figure.
        updateData.discountAmount = totalDiscount;
        updateData.totalAmount = totalAmount;

        // Same replace-all-items pattern as updateQuotation/updateProformaInvoice:
        // the frontend never sends SalesOrderItem.id, so there's nothing to
        // upsert/sync against — delete and recreate inside the transaction.
        await tx.salesOrderItem.deleteMany({ where: { salesOrderId: id } });

        updateData.items = {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            discountPercent: item.discountPercent || item.discountPct || 0,
            discountAmount: item.discountAmount || 0,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        };
      }

      return tx.salesOrder.update({
        where: { id },
        data: updateData,
        include: { items: true }
      });
    });
  }

  static async recordPayment(orderId: string, data: { accountId: string; method: string; amount: number; createdBy?: string }) {
    const { FinanceService } = require('../finance/finance.service');
    
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new Error('Sales Order not found');

      const payment = await FinanceService.createPayment({
        tx,
        amount: data.amount,
        flow: 'IN',
        status: 'PAID',
        sourceAccount: data.accountId,
        method: data.method,
        sourceModule: 'POS', // Use POS for all sales-related inflows for now
        linkedDocType: 'INVOICE',
        linkedDocId: order.id,
        entity: order.customerName || 'Customer',
        createdBy: data.createdBy
      });

      await tx.salesOrder.update({
        where: { id: orderId },
        data: { paymentStatus: 'PAID' }
      });

      return payment;
    });
  }

  // ─── Return Orders (RMA) ─────────────────────────────────────────────────────

  static async getReturnOrders(filters: {
    status?: string;
    customerId?: string;
    dealerId?: string;
    franchiseId?: string;
    operatingFranchiseId?: string;
    source?: 'FRANCHISE' | 'DEALER' | 'BUSINESS' | 'POS';
    search?: string;
  }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.dealerId) where.dealerId = filters.dealerId;
    if (filters.franchiseId) where.franchiseId = filters.franchiseId;

    if (filters.operatingFranchiseId) {
      where.posOrder = {
        franchiseId: filters.operatingFranchiseId,
        NOT: { partyType: 'FRANCHISE' }
      };
    }

    if (filters.source === 'FRANCHISE') {
      where.franchiseId = { not: null };
    } else if (filters.source === 'DEALER') {
      where.dealerId = { not: null };
    } else if (filters.source === 'BUSINESS') {
      where.customerId = { not: null };
    } else if (filters.source === 'POS') {
      where.posOrderId = { not: null };
    }

    if (filters.search) {
      where.OR = [
        { returnNumber: { contains: filters.search, mode: 'insensitive' } },
        { reason: { contains: filters.search, mode: 'insensitive' } },
        { posOrder: { invoiceNum: { contains: filters.search, mode: 'insensitive' } } },
        { posOrder: { customerName: { contains: filters.search, mode: 'insensitive' } } },
        { customer: { name: { contains: filters.search, mode: 'insensitive' } } },
        { dealer: { name: { contains: filters.search, mode: 'insensitive' } } }
      ];
    }
    return prisma.returnOrder.findMany({
      where,
      include: {
        customer: true,
        dealer: true,
        salesOrder: true,
        franchise: true,
        franchiseOrder: true,
        posOrder: {
          include: {
            orderItems: { include: { product: true } },
            customer: true,
            franchise: true
          }
        },
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  // ── Phase 3 helpers: inventory-cost reversal for Sales/POS Returns ───────
  // These are the only new pieces of state-derivation this phase needs — no
  // second FIFO ledger. The original sale's own StockMovement rows (written
  // by InventoryService.recordMovement/depleteBatchesFIFO — untouched,
  // authoritative) already carry exact layer provenance; these helpers only
  // ever REPLAY that existing ordering, never reimplement or reorder it.

  // Serializes concurrent createReturnOrder calls against the SAME original
  // document. Without this, two concurrent requests can both read the same
  // "already returned" total (the pre-existing over-return guard AND this
  // phase's FIFO-layer skip-count both depend on it) before either commits
  // its own ReturnItem rows, letting combined returns exceed what was
  // actually sold/dispatched/transferred. Mirrors depleteBatchesFIFO's own
  // SELECT ... FOR UPDATE precedent (inventory.service.ts) and
  // recordRefund's existing `SELECT id FROM "ReturnOrder" ... FOR UPDATE`
  // pattern in this same file.
  private static async _lockOriginalDocumentForReturn(tx: any, data: { posOrderId?: string; salesOrderId?: string; franchiseOrderId?: string }) {
    if (data.posOrderId) {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${data.posOrderId} FOR UPDATE`;
    } else if (data.salesOrderId) {
      await tx.$queryRaw`SELECT id FROM "SalesOrder" WHERE id = ${data.salesOrderId} FOR UPDATE`;
    } else if (data.franchiseOrderId) {
      await tx.$queryRaw`SELECT id FROM "FranchiseOrder" WHERE id = ${data.franchiseOrderId} FOR UPDATE`;
    }
  }

  // Phase 3A: the Delivery-Challan-return equivalent of
  // _lockOriginalDocumentForReturn above — a completely separate model
  // (DeliveryChallan, not Order/SalesOrder/FranchiseOrder), so kept as its
  // own small helper rather than overloading that one. Serializes concurrent
  // createDeliveryChallanReturn calls against the SAME challan: without
  // this, two concurrent requests can both read the same "previously
  // returned" total for a challan line (see previouslyReturned below) before
  // either commits its own DeliveryChallanReturnItem rows, letting combined
  // returns exceed what was actually dispatched on that line.
  private static async _lockDeliveryChallanForReturn(tx: any, challanId: string) {
    await tx.$queryRaw`SELECT id FROM "DeliveryChallan" WHERE id = ${challanId} FOR UPDATE`;
  }

  // Resolves WHERE the original sale's real FIFO consumption (if any) was
  // recorded: the referenceType/referenceId StockMovement rows were written
  // under, and the franchise scope (a real Franchise.id, or null meaning
  // none/HQ-not-applicable) whose InventoryItem to look them up against.
  //   - posOrderId  -> referenceType 'ORDER' (POS checkout AND any Group-B
  //     conversion-created Order alike — a conversion Order simply has no
  //     matching rows, which correctly falls out as Case C below, without
  //     needing to special-case document sub-type here).
  //   - franchiseOrderId -> referenceType 'FRANCHISE_ORDER' (the TRANSFER_IN
  //     side, landed directly on the receiving franchise's own InventoryItem
  //     — same scope the return itself restores into, see
  //     restoreStockForReturnOrder).
  //   - salesOrderId -> a SalesOrder itself never deducts inventory (Group
  //     B — convertSalesOrderToSale calls zero inventory functions), but a
  //     DeliveryChallan dispatched FOR this SalesOrder (DeliveryChallan.
  //     salesOrderId) does, under referenceType 'DELIVERY_CHALLAN' /
  //     referenceId = that challan's id, scoped to the challan's own
  //     sourceFranchiseId (the dispatching warehouse) — see
  //     dispatchChallanStock. A SalesOrder with no linked DC (the Group-B
  //     conversion path) naturally resolves to no refs at all -> Case C.
  // NOTE on the returned scope value: this is the FINAL, ready-to-use
  // InventoryItem.franchiseId filter value — NOT necessarily a raw
  // Franchise.id needing a further FranchiseService.toInventoryScopeId
  // conversion. Each branch below matches whatever convention the REAL
  // deduction code for that document type actually used when it wrote the
  // InventoryItem row being looked up, which is not uniform across the
  // codebase:
  //   - POS checkout (pos.service.ts) converts via toInventoryScopeId
  //     (HQ -> null) before resolving its InventoryItem, so this does too.
  //   - franchise-order.service.ts's TRANSFER_IN resolves its InventoryItem
  //     by the RAW `order.franchiseId` (no conversion) — harmless in
  //     practice since a FranchiseOrder's franchise is always a real
  //     (non-HQ) franchise, where toInventoryScopeId is a no-op anyway, but
  //     matched exactly here rather than assumed.
  //   - dispatchChallanStock resolves its InventoryItem by the RAW
  //     `challan.sourceFranchiseId || HQ.id` — critically NOT converted, so
  //     an HQ-sourced DC's stock actually lives under `franchiseId: hq.id`,
  //     NOT `franchiseId: null`. Converting here would silently look up the
  //     wrong (or no) InventoryItem for every HQ-dispatched DC.
  private static async _resolveReturnProvenanceRefs(tx: any, data: { posOrderId?: string; salesOrderId?: string; franchiseOrderId?: string }): Promise<{ refs: Array<{ referenceType: string; referenceId: string }>; scopeFranchiseId: string | null }> {
    if (data.posOrderId) {
      const po = await tx.order.findUnique({ where: { id: data.posOrderId }, select: { franchiseId: true } });
      const scopeFranchiseId = po?.franchiseId ? await FranchiseService.toInventoryScopeId(tx, po.franchiseId) : null;
      return { refs: [{ referenceType: 'ORDER', referenceId: data.posOrderId }], scopeFranchiseId };
    }
    if (data.franchiseOrderId) {
      const fo = await tx.franchiseOrder.findUnique({ where: { id: data.franchiseOrderId }, select: { franchiseId: true } });
      return { refs: [{ referenceType: 'FRANCHISE_ORDER', referenceId: data.franchiseOrderId }], scopeFranchiseId: fo?.franchiseId || null };
    }
    if (data.salesOrderId) {
      const challans = await tx.deliveryChallan.findMany({ where: { salesOrderId: data.salesOrderId }, select: { id: true, sourceFranchiseId: true } });
      if (!challans.length) return { refs: [], scopeFranchiseId: null };
      const hq = await FranchiseService.getHqFranchiseOrNull(tx);
      return {
        refs: challans.map((c: any) => ({ referenceType: 'DELIVERY_CHALLAN', referenceId: c.id })),
        scopeFranchiseId: challans[0].sourceFranchiseId || hq?.id || null,
      };
    }
    return { refs: [], scopeFranchiseId: null };
  }

  // Item resolution for a return line, given the scope to look inside —
  // identical matching precedence (SKU, then name) used by
  // restoreStockForReturnOrder for the actual physical restock, factored
  // out so provenance-lookup (creation time) and restoration (approval
  // time) can never resolve to two different InventoryItem rows for the
  // same line.
  private static async _resolveInventoryItemForReturnLine(tx: any, scopeFranchiseId: string | null, item: { productId?: string | null; productName?: string | null }): Promise<any> {
    let invItem: any = null;
    if (item.productId) {
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (product?.sku) {
        invItem = await tx.inventoryItem.findFirst({ where: { sku: product.sku, franchiseId: scopeFranchiseId } });
      }
      if (!invItem && product?.name) {
        invItem = await tx.inventoryItem.findFirst({ where: { name: { equals: product.name, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });
      }
    }
    if (!invItem && item.productName) {
      invItem = await tx.inventoryItem.findFirst({ where: { name: { equals: item.productName, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });
    }
    return invItem;
  }

  // The restoration-side scope fallback (franchiseId party -> posOrder's
  // operating branch -> Customer's/Dealer's own home franchise) — factored
  // out of restoreStockForReturnOrder so it stays in exactly one place.
  private static async _resolveReturnRestoreScopeFranchiseId(tx: any, returnOrder: any): Promise<string | null> {
    let scopeFranchiseId = returnOrder.posOrder?.franchiseId || returnOrder.franchiseId || null;
    if (!scopeFranchiseId && returnOrder.customerId) {
      const cust = await tx.customer.findUnique({ where: { id: returnOrder.customerId }, select: { franchiseId: true } });
      scopeFranchiseId = cust?.franchiseId || null;
    }
    if (!scopeFranchiseId && returnOrder.dealerId) {
      const deal = await tx.dealer.findUnique({ where: { id: returnOrder.dealerId }, select: { franchiseId: true } });
      scopeFranchiseId = deal?.franchiseId || null;
    }
    return scopeFranchiseId;
  }

  // The core FIFO-return-allocation algorithm (design doc step 1-5): given
  // the original sale's StockMovement rows for this exact item+reference,
  // reconstruct their ordered layer list exactly as depleteBatchesFIFO
  // wrote it, skip whatever prior returns on this line already consumed
  // (cumulatively, in the same order — a deterministic replay that needs no
  // separate "remaining" ledger), then allocate THIS return's quantity to
  // the next layers in order.
  private static async _computeReturnFifoAllocation(tx: any, params: {
    itemId: string;
    refs: Array<{ referenceType: string; referenceId: string }>;
    alreadyReturnedQty: number;
    returnQty: number;
  }): Promise<{ provenance: 'EXACT' | 'RECONSTRUCTED' | 'PROVENANCE_UNAVAILABLE'; allocation: Array<{ batchId: string | null; qty: number; unitCost: number; totalCost: number }> | null; costReversal: number | null }> {
    if (!params.refs.length) {
      return { provenance: 'PROVENANCE_UNAVAILABLE', allocation: null, costReversal: null };
    }

    // Every matching outbound (or, for FRANCHISE_ORDER, inbound TRANSFER_IN)
    // movement for this exact item+reference, oldest first — depleteBatchesFIFO
    // itself only ever runs within ONE recordMovement call, but a single
    // logical sale/dispatch/transfer can span several recordMovement calls
    // (e.g. HQ->Franchise TRANSFER_IN is written once per source lot) — this
    // concatenates all of them, in the order they were actually written.
    const movements = await tx.stockMovement.findMany({
      where: {
        itemId: params.itemId,
        OR: params.refs.map(r => ({ referenceType: r.referenceType, referenceId: r.referenceId })),
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!movements.length) {
      return { provenance: 'PROVENANCE_UNAVAILABLE', allocation: null, costReversal: null };
    }

    type Layer = { batchId: string | null; qty: number; unitCost: number; exact: boolean };
    const layers: Layer[] = [];

    for (const mv of movements) {
      const qty = Math.abs(mv.quantity || 0);
      if (qty <= 0.0000001) continue;

      const breakdown = Array.isArray(mv.consumptionBreakdown) ? (mv.consumptionBreakdown as any[]) : null;
      if (breakdown && breakdown.length) {
        // Multi-lot movement — already FIFO-ordered by depleteBatchesFIFO.
        let covered = 0;
        for (const b of breakdown) {
          const bQty = Number(b.qty) || 0;
          if (bQty <= 0) continue;
          layers.push({ batchId: b.batchId || null, qty: bQty, unitCost: Number(b.unitCost) || 0, exact: true });
          covered += bQty;
        }
        const shortfall = qty - covered;
        if (shortfall > 0.0001) {
          // The movement covered more than its recorded breakdown accounts
          // for (a legacy/partial-tracking gap) — the remainder still has
          // SOME historical unit cost on the row itself, just not a real
          // batch to reattribute it to. Reconstructed, not fabricated.
          layers.push({ batchId: null, qty: shortfall, unitCost: Number(mv.unitCost) || 0, exact: false });
        }
      } else if (mv.batchId) {
        // Single-lot movement (outbound with exactly one batch consumed, or
        // an inbound TRANSFER_IN's own receiveAtCost lot).
        layers.push({ batchId: mv.batchId, qty, unitCost: Number(mv.unitCost) || 0, exact: true });
      } else if (mv.unitCost != null) {
        // No batch identity at all (e.g. the item had zero tracked batches
        // at sale time, so recordMovement fell back to the item's
        // moving-average costPrice AS IT WAS AT THAT MOMENT — still a real
        // historical figure, just not layer-exact).
        layers.push({ batchId: null, qty, unitCost: Number(mv.unitCost) || 0, exact: false });
      }
      // A row with neither batchId nor consumptionBreakdown nor unitCost
      // contributes no usable layer at all — genuinely pre-existing/
      // malformed legacy data; simply skipped (does not fabricate a cost).
    }

    if (!layers.length) {
      return { provenance: 'PROVENANCE_UNAVAILABLE', allocation: null, costReversal: null };
    }

    let toSkip = params.alreadyReturnedQty;
    let toTake = params.returnQty;
    const allocation: Array<{ batchId: string | null; qty: number; unitCost: number; totalCost: number }> = [];
    let anyInexact = false;

    for (const layer of layers) {
      if (toTake <= 0.0000001) break;
      let layerQty = layer.qty;
      if (toSkip > 0.0000001) {
        const skipHere = Math.min(toSkip, layerQty);
        layerQty -= skipHere;
        toSkip -= skipHere;
      }
      if (layerQty <= 0.0000001) continue;
      const takeHere = Math.min(layerQty, toTake);
      if (takeHere > 0.0000001) {
        allocation.push({ batchId: layer.batchId, qty: takeHere, unitCost: layer.unitCost, totalCost: Math.round(takeHere * layer.unitCost * 100) / 100 });
        if (!layer.exact) anyInexact = true;
        toTake -= takeHere;
      }
    }

    if (!allocation.length) {
      return { provenance: 'PROVENANCE_UNAVAILABLE', allocation: null, costReversal: null };
    }

    const costReversal = Math.round(allocation.reduce((s, a) => s + a.totalCost, 0) * 100) / 100;
    // toTake > 0 here means even the tracked layers ran out before covering
    // the full return quantity (a historical shortfall) — still record
    // whatever WAS traceable rather than fabricating the rest.
    const provenance: 'EXACT' | 'RECONSTRUCTED' = (anyInexact || toTake > 0.0001) ? 'RECONSTRUCTED' : 'EXACT';

    return { provenance, allocation, costReversal };
  }

  static async createReturnOrder(data: {
    salesOrderId?: string;
    franchiseOrderId?: string;
    posOrderId?: string;
    customerId?: string;
    dealerId?: string;
    franchiseId?: string;
    reason: string;
    status?: 'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED';
    items: Array<{ productId?: string; productName: string; quantity: number; rate: number; condition?: string; discountAmount?: number; taxAmount?: number }>;
    refundMethod?: string;
    idempotencyKey?: string;
  }) {
    if (data.idempotencyKey) {
      const existing = await prisma.returnOrder.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
        include: { customer: true, dealer: true, franchise: true, salesOrder: true, franchiseOrder: true, posOrder: true, items: true }
      });
      if (existing) return existing;
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Resolve Authoritative Party & Relationships from the linked order.
      // Party identity (who the return is FOR: Customer/Dealer/Franchise)
      // must never be confused with Order.franchiseId, which is the
      // OPERATING branch that processed the sale — nearly every Order has
      // one regardless of who bought it, so blindly copying it here used to
      // mislabel every POS-sourced Customer/Dealer return as a Franchise
      // return. The correct party signal is Order.partyType/partyId.
      let resolvedCustomerId: string | null = null;
      let resolvedDealerId: string | null = null;
      let resolvedFranchiseId: string | null = data.franchiseId || null;

      if (data.posOrderId) {
        const po = await tx.order.findUnique({ where: { id: data.posOrderId } });
        if (po) {
          if (po.partyType === 'DEALER' && po.partyId) {
            resolvedDealerId = po.partyId;
          } else if (po.partyType === 'FRANCHISE' && po.partyId) {
            resolvedFranchiseId = po.partyId;
          } else if (po.customerId && !/walk[-_ ]?in/i.test(po.customerId)) {
            const cust = await tx.customer.findUnique({ where: { id: po.customerId } });
            resolvedCustomerId = cust ? cust.id : null;
          }
        }
      } else if (data.salesOrderId) {
        const so = await tx.salesOrder.findUnique({ where: { id: data.salesOrderId } });
        if (so) {
          if (so.partyType === 'DEALER' && so.partyId) {
            resolvedDealerId = so.partyId;
          } else if (so.partyType === 'FRANCHISE' && so.partyId) {
            resolvedFranchiseId = so.partyId;
          } else if (so.customerId) {
            const cust = await tx.customer.findUnique({ where: { id: so.customerId } });
            resolvedCustomerId = cust ? cust.id : null;
          }
        }
      } else if (data.franchiseOrderId) {
        const fo = await tx.franchiseOrder.findUnique({ where: { id: data.franchiseOrderId } });
        if (fo && fo.franchiseId) {
          resolvedFranchiseId = fo.franchiseId;
        }
      } else if (data.dealerId) {
        const dealer = await tx.dealer.findUnique({ where: { id: data.dealerId } });
        resolvedDealerId = dealer ? dealer.id : null;
      } else if (data.customerId && !/walk[-_ ]?in/i.test(data.customerId)) {
        const cust = await tx.customer.findUnique({ where: { id: data.customerId } });
        resolvedCustomerId = cust ? cust.id : null;
      }

      // 2. Resolve the original sale line-by-line (server-side, never trusting
      // data.items[].rate) and validate return quantities against the
      // original order + prior returns. originalLineMap carries everything
      // needed to reverse discount/GST for each returned line using the
      // unified formula below — it deliberately does NOT need to know
      // whether the source Order came from POS checkout (tax computed on
      // gross) or a Sales-chain conversion (tax computed on taxable): it
      // only ever scales the ORIGINAL persisted tax amount proportionally,
      // never recomputes it from today's rates.
      type OriginalLine = {
        price: number;    // gross unit rate actually charged on the original line
        quantity: number; // original quantity sold on this line
        discountPct: number; // % discount already recorded on this line (0 for FranchiseOrderItem, which has no discount concept)
        taxAmountFull: number; // actual persisted tax charged for the FULL original line (0 for FranchiseOrderItem lines, apportioned instead — see apportionedTax)
        apportionedLeftoverDiscount?: number; // POS-only: full-line share of the order-level "leftover" (manual/ad-hoc) discount not captured by discountPct
        apportionedTax?: number; // FranchiseOrder-only: full-line share of FranchiseOrder.taxAmount, apportioned by gross-value weight
      };
      const originalLineMap = new Map<string, OriginalLine>();
      let buyerState: string | null = null;
      let sellerFranchiseIdForGst: string | null = resolvedFranchiseId;
      // Phase 3 (inventory-cost reversal — completely independent of the
      // refund/GST fields computed below): how much of each line was
      // already returned by PRIOR non-rejected returns against this same
      // original document, and which original StockMovement reference(s)
      // this document's real FIFO consumption (if any) was recorded under.
      // Populated inside the block below (when there IS a linked document),
      // left empty/null otherwise — a standalone/manual return has no
      // original consumption to trace, so every line on it is Case C.
      let previouslyReturned: Record<string, number> = {};
      let provenanceRefs: Array<{ referenceType: string; referenceId: string }> = [];
      let provenanceScopeFranchiseId: string | null = null;

      if (data.posOrderId || data.salesOrderId || data.franchiseOrderId) {
        // Phase 3: lock the original document FIRST, before reading any
        // prior-returns total — see _lockOriginalDocumentForReturn. This is
        // what actually makes concurrent partial returns against the same
        // sale safe (both the pre-existing over-return guard below AND the
        // new FIFO cost-allocation skip-count depend on seeing every
        // already-committed prior return, never a stale concurrent read).
        await SalesService._lockOriginalDocumentForReturn(tx, data);

        const provenance = await SalesService._resolveReturnProvenanceRefs(tx, data);
        provenanceRefs = provenance.refs;
        provenanceScopeFranchiseId = provenance.scopeFranchiseId;

        const priorReturns = await tx.returnOrder.findMany({
          where: {
            ...(data.posOrderId ? { posOrderId: data.posOrderId } : {}),
            ...(data.salesOrderId ? { salesOrderId: data.salesOrderId } : {}),
            ...(data.franchiseOrderId ? { franchiseOrderId: data.franchiseOrderId } : {}),
            status: { not: 'REJECTED' }
          },
          include: { items: true }
        });

        for (const pr of priorReturns) {
          for (const it of pr.items) {
            const key = it.productId || it.productName;
            previouslyReturned[key] = (previouslyReturned[key] || 0) + it.quantity;
          }
        }

        let originalItems: Array<{ productId?: string; productName?: string; quantity: number }> = [];

        if (data.posOrderId) {
          const po = await tx.order.findUnique({ where: { id: data.posOrderId }, include: { orderItems: { include: { product: true } } } });
          if (po) {
            originalItems = po.orderItems.map((oi: any) => ({ productId: oi.productId, productName: oi.product?.name, quantity: oi.quantity }));
            buyerState = po.stateOfSupply || null;
            sellerFranchiseIdForGst = resolvedFranchiseId || po.franchiseId || null;

            // Leftover bill-level discount: the cashier's ad-hoc manualDiscount
            // (see pos.service.ts checkout()) has no per-line home in the
            // schema — it only survives in Order.discountAmount, blended with
            // the per-line channel discount that DOES now populate
            // OrderItem.discountPct. Whatever of Order.discountAmount isn't
            // already accounted for by summing discountPct*price*quantity
            // across lines is that ad-hoc portion; apportion it by gross-value
            // weight, mirroring calculateTotals()'s identical apportionment
            // pattern for document-level discounts.
            const orderTotalGross = po.orderItems.reduce((s: number, oi: any) => s + (oi.price || 0) * (oi.quantity || 0), 0);
            const sumLineLevelDiscount = po.orderItems.reduce((s: number, oi: any) => s + (oi.price || 0) * (oi.quantity || 0) * ((oi.discountPct || 0) / 100), 0);
            const leftoverDiscount = Math.max(0, (po.discountAmount || 0) - sumLineLevelDiscount);

            for (const oi of po.orderItems) {
              const key = oi.productId || oi.product?.name;
              if (!key) continue;
              const lineGross = (oi.price || 0) * (oi.quantity || 0);
              const apportionedLeftoverDiscount = orderTotalGross > 0 ? leftoverDiscount * (lineGross / orderTotalGross) : 0;
              originalLineMap.set(String(key), {
                price: oi.price || 0,
                quantity: oi.quantity || 0,
                discountPct: oi.discountPct || 0,
                taxAmountFull: oi.taxAmount || 0,
                apportionedLeftoverDiscount
              });
            }
          }
        } else if (data.salesOrderId) {
          const so = await tx.salesOrder.findUnique({ where: { id: data.salesOrderId }, include: { items: true } });
          if (so) {
            originalItems = so.items.map((si: any) => ({ productId: si.productId, productName: si.productName, quantity: si.quantity }));
            buyerState = so.stateOfSupply || null;
            for (const si of so.items) {
              const key = si.productId || si.productName;
              if (!key) continue;
              originalLineMap.set(String(key), {
                price: si.rate || 0,
                quantity: si.quantity || 0,
                discountPct: si.discountPercent || 0,
                taxAmountFull: si.taxAmount || 0
              });
            }
          }
        } else if (data.franchiseOrderId) {
          const fo = await tx.franchiseOrder.findUnique({ where: { id: data.franchiseOrderId }, include: { items: { include: { product: true } } } });
          if (fo) {
            originalItems = fo.items.map((fi: any) => ({ productId: fi.productId, productName: fi.product?.name, quantity: fi.quantity }));
            sellerFranchiseIdForGst = resolvedFranchiseId || fo.franchiseId || null;
            // FranchiseOrder has no discount concept and no per-line tax
            // field — apportion the order-level taxAmount across lines by
            // gross-value weight, same pattern as the POS leftover-discount
            // apportionment above.
            const orderSubtotal = fo.subtotal && fo.subtotal > 0
              ? fo.subtotal
              : fo.items.reduce((s: number, fi: any) => s + (fi.unitPrice || 0) * (fi.quantity || 0), 0);
            for (const fi of fo.items) {
              const key = fi.productId || fi.product?.name;
              if (!key) continue;
              const lineGross = (fi.unitPrice || 0) * (fi.quantity || 0);
              const apportionedTax = orderSubtotal > 0 ? (fo.taxAmount || 0) * (lineGross / orderSubtotal) : 0;
              originalLineMap.set(String(key), {
                price: fi.unitPrice || 0,
                quantity: fi.quantity || 0,
                discountPct: 0,
                taxAmountFull: 0,
                apportionedTax
              });
            }
          }
        }

        for (const item of data.items) {
          if (item.quantity <= 0) {
            throw new Error(`Return quantity for ${item.productName} must be greater than zero.`);
          }
          const orig = originalItems.find(o => (item.productId && o.productId === item.productId) || (item.productName && o.productName === item.productName));
          if (orig) {
            const key = item.productId || item.productName;
            const already = previouslyReturned[key] || 0;
            const returnable = orig.quantity - already;
            if (item.quantity > returnable + 0.001) {
              throw new Error(`Cannot return ${item.quantity} units of ${item.productName}. Original sold: ${orig.quantity}, already returned: ${already}, maximum returnable: ${returnable}.`);
            }
          }
        }
      }

      // 3. Apply the unified per-line reversal formula. For every returned
      // line that matches a resolved original line (by productId, falling
      // back to productName — the SAME matching used for quantity validation
      // above), the client-submitted `rate` is ignored entirely and every
      // figure is derived from the ORIGINAL persisted price/discount/tax —
      // this is the P0 fix: no client-forged rate, discount, or GST can ever
      // reach refundAmount or the GSTR-1 credit-note figures.
      //   grossReversal    = price * q
      //   discountReversal = grossReversal * (discountPct/100)  [+ apportioned leftover/manual discount, POS only]
      //   taxReversal      = taxAmountFull * (q/quantity)        [or apportioned FranchiseOrder tax * (q/quantity)]
      //   taxableReversal  = grossReversal - discountReversal
      //   totalReversal    = taxableReversal + taxReversal
      // A line with no resolvable original (no linked order at all, OR this
      // product genuinely isn't on the linked order — e.g. a free-text
      // return) falls back to the pre-existing manual behavior: the client's
      // rate is trusted for gross only, and discount/tax reversal is 0
      // unless the client explicitly supplies them. This path is for
      // standalone/manual returns not tied to a recorded sale and is
      // intentionally out of scope for the P0 fix.
      const { splitGstAmount, resolveSellerState } = require('../../utils/gst-tax.util');

      // Phase 3: the InventoryItem provenance-lookup scope, already resolved
      // to its final ready-to-filter-with value by
      // _resolveReturnProvenanceRefs (see that method's own comment — the
      // conversion convention differs by document type and is NOT uniform,
      // so it is applied there, per-branch, not here). This is the SALE-SIDE
      // scope (where the original outbound movement was actually recorded),
      // which is NOT always the same as the return's own restoration scope
      // (see restoreStockForReturnOrder's franchiseId/customer/dealer
      // fallback chain) — e.g. a franchise-party POS sale processed at HQ
      // deducts HQ's own InventoryItem, while the return restores into the
      // franchise's. InventoryService.restoreToBatches handles that
      // divergence safely at restore time; this is only for FINDING the
      // right original StockMovement rows to replay.
      const provenanceInvScopeId = provenanceScopeFranchiseId;

      let refundAmount = 0;
      let totalTaxableValue = 0;
      let totalTaxAmount = 0;
      const returnItemsData: any[] = [];
      for (const item of data.items) {
        const key = item.productId || item.productName;
        const orig = key ? originalLineMap.get(String(key)) : undefined;

        let rate: number;
        let discountReversal = 0;
        let taxReversal = 0;

        if (orig) {
          // Defensive only — should not normally happen given the matching
          // above already resolved this same record; a missing price/
          // quantity here would mean a data-integrity problem on the linked
          // order, not a legitimate return scenario, so this rejects rather
          // than silently falling back to the client's numbers.
          if (orig.price == null || !(orig.quantity > 0)) {
            throw new Error(`Unable to resolve original sale pricing for "${item.productName}" — data integrity issue on the linked order.`);
          }
          rate = orig.price;
          const fraction = item.quantity / orig.quantity;
          const grossReversal = rate * item.quantity;
          discountReversal = grossReversal * (orig.discountPct / 100);
          if (orig.apportionedLeftoverDiscount) {
            discountReversal += orig.apportionedLeftoverDiscount * fraction;
          }
          taxReversal = orig.apportionedTax !== undefined
            ? orig.apportionedTax * fraction
            : orig.taxAmountFull * fraction;
        } else {
          rate = item.rate;
          discountReversal = Math.max(0, Number(item.discountAmount) || 0);
          taxReversal = Math.max(0, Number(item.taxAmount) || 0);
        }

        const grossReversal = rate * item.quantity;
        discountReversal = Math.max(0, Math.min(discountReversal, grossReversal));
        const taxableReversal = Math.round((grossReversal - discountReversal) * 100) / 100;
        taxReversal = Math.round(Math.max(0, taxReversal) * 100) / 100;
        const totalReversal = Math.round((taxableReversal + taxReversal) * 100) / 100;
        const gstRateForItem = taxableReversal > 0 ? Number(((taxReversal / taxableReversal) * 100).toFixed(2)) : 0;

        refundAmount += totalReversal;
        totalTaxableValue += taxableReversal;
        totalTaxAmount += taxReversal;

        // Phase 3: cost-reversal computation — completely independent of
        // every refund/GST figure computed above (different source: the
        // ORIGINAL StockMovement's own FIFO provenance, never
        // refundAmount/rate/discount/tax). Computed exactly ONCE, here at
        // creation time, never re-derived on approval (see updateReturnOrder
        // / restoreStockForReturnOrder, which only ever READ what's
        // persisted below). Client-submitted cost/batch fields (if any were
        // sent) are never read anywhere in this block — only item.quantity
        // (already validated above) and item.productId/productName feed in.
        let costAllocation: any = null;
        let costReversal: number | null = null;
        let costProvenance: string = 'PROVENANCE_UNAVAILABLE';

        if (provenanceRefs.length) {
          const provInvItem = await SalesService._resolveInventoryItemForReturnLine(tx, provenanceInvScopeId, item);
          if (provInvItem) {
            const alreadyReturnedForLine = previouslyReturned[key || ''] || 0;
            const result = await SalesService._computeReturnFifoAllocation(tx, {
              itemId: provInvItem.id,
              refs: provenanceRefs,
              alreadyReturnedQty: alreadyReturnedForLine,
              returnQty: item.quantity,
            });
            costProvenance = result.provenance;
            costAllocation = result.allocation;
            costReversal = result.costReversal;
          }
        }

        returnItemsData.push({
          productId: item.productId || null,
          productName: item.productName,
          quantity: item.quantity,
          rate,
          discountAmount: Math.round(discountReversal * 100) / 100,
          taxableValue: taxableReversal,
          gstRate: gstRateForItem,
          taxAmount: taxReversal,
          totalAmount: totalReversal,
          condition: item.condition,
          costAllocation,
          costReversal,
          costProvenance
        });
      }

      refundAmount = Math.round(refundAmount * 100) / 100;
      totalTaxableValue = Math.round(totalTaxableValue * 100) / 100;
      totalTaxAmount = Math.round(totalTaxAmount * 100) / 100;
      const overallGstRate = totalTaxableValue > 0 ? Number(((totalTaxAmount / totalTaxableValue) * 100).toFixed(2)) : 0;

      // GST split (CGST/SGST vs IGST) is established HERE, at creation, and
      // never recalculated later — PENDING -> APPROVED must not change the
      // financial basis. Uses the same resolveSellerState/buyer-state
      // resolution that used to live in updateReturnOrder's backfill.
      const sellerState = await resolveSellerState(sellerFranchiseIdForGst);
      const gstSplit = splitGstAmount(totalTaxAmount, buyerState, sellerState);

      const returnNumber = await generateReturnNumber();
      const initialStatus = data.status || 'PENDING';

      const returnOrder = await tx.returnOrder.create({
        data: {
          returnNumber,
          salesOrderId: data.salesOrderId || null,
          franchiseOrderId: data.franchiseOrderId || null,
          posOrderId: data.posOrderId || null,
          customerId: resolvedCustomerId,
          dealerId: resolvedDealerId,
          franchiseId: resolvedFranchiseId,
          reason: data.reason,
          refundAmount,
          taxableValue: totalTaxableValue,
          gstRate: overallGstRate,
          cgst: gstSplit.cgst,
          sgst: gstSplit.sgst,
          igst: gstSplit.igst,
          taxAmount: totalTaxAmount,
          refundMethod: data.refundMethod,
          status: initialStatus as any,
          idempotencyKey: data.idempotencyKey || undefined,
          items: { create: returnItemsData }
        },
        include: { customer: true, dealer: true, franchise: true, salesOrder: true, franchiseOrder: true, posOrder: true, items: true }
      });

      // If created directly in APPROVED or COMPLETED status, restore stock immediately
      if (initialStatus === 'APPROVED' || initialStatus === 'COMPLETED') {
        await SalesService.restoreStockForReturnOrder(tx, returnOrder, 'SYSTEM');
      }

      return returnOrder;
    });
  }

  // Internal helper to restore returned stock into inventory
  static async restoreStockForReturnOrder(tx: any, returnOrder: any, userId: string = 'system') {
    const { FranchiseService } = require('../franchise/franchise.service');
    const { InventoryService } = require('../inventory/inventory.service');
    const { RecallService } = require('../production/recall.service');

    // Phase 3 idempotency guard: this must physically restore stock/reverse
    // cost exactly ONCE per ReturnOrder, no matter how many times this
    // function (or updateReturnOrder, which calls it) is invoked — a
    // duplicate/retried approval call must be a safe no-op, not a second
    // restock. updateReturnOrder's own PENDING-only status guard already
    // prevents this in normal API use, but this function is the actual
    // safety boundary: it must hold even when called directly twice.
    // Two independent first-call signals, because a recall-affected line
    // (see recordRecallAffectedReturn below) writes its StockMovement under
    // referenceType 'RECALL' + the recall's own id — NOT 'SALES_RETURN' +
    // this returnOrder's id — so a return whose lines are ALL recall hits
    // would otherwise leave no 'SALES_RETURN'-referenced row for the first
    // check to find. ReturnItem.recallId (set on first call, right below)
    // covers that case without touching recordRecallAffectedReturn itself.
    const alreadyRestored = await tx.stockMovement.findFirst({
      where: { referenceType: 'SALES_RETURN', referenceId: returnOrder.id },
      select: { id: true }
    });
    const alreadyRecallProcessed = Array.isArray(returnOrder.items) && returnOrder.items.some((it: any) => it.recallId);
    if (alreadyRestored || alreadyRecallProcessed) return;

    // Fallback chain: franchiseId party -> posOrder's operating branch -> the
    // Customer's/Dealer's own home franchise. A ReturnOrder sourced only
    // from a SalesOrder (salesOrderId set, no posOrderId, no franchiseId
    // party) has NEITHER of the first two — SalesOrder itself carries no
    // franchiseId column at all (confirmed: prisma/schema.prisma SalesOrder
    // model) — so without this fallback FranchiseService.toInventoryScopeId
    // below was called with a null id and threw. Customer/Dealer both carry
    // a direct, authoritative franchiseId (their home branch), and
    // returnOrder.customerId/dealerId are already resolved correctly by the
    // party-classification logic in createReturnOrder above — safe to use
    // directly here.
    const scopeFranchiseId = await SalesService._resolveReturnRestoreScopeFranchiseId(tx, returnOrder);
    const targetScopeId = await FranchiseService.toInventoryScopeId(tx, scopeFranchiseId);

    // The reference the ORIGINAL sale's outbound StockMovement(s) were
    // recorded under — needed to look up which InventoryBatch lot(s) this
    // return actually traces back to. A ReturnOrder with no linked
    // posOrder/franchiseOrder (e.g. a free-form return) has nothing to look
    // up here, so recall detection is skipped for it exactly as before this
    // change — there is no schema link to trace in that case.
    let saleRef: { referenceType: string; referenceId: string } | null = null;
    if (returnOrder.posOrderId) saleRef = { referenceType: 'ORDER', referenceId: returnOrder.posOrderId };
    else if (returnOrder.franchiseOrderId) saleRef = { referenceType: 'FRANCHISE_ORDER', referenceId: returnOrder.franchiseOrderId };

    for (const item of returnOrder.items) {
      const cond = (item.condition || 'GOOD').toUpperCase();
      let invItem: any = null;

      if (item.productId) {
        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (product?.sku) {
          invItem = await tx.inventoryItem.findFirst({
            where: { sku: product.sku, franchiseId: targetScopeId }
          });
        }
        if (!invItem && product?.name) {
          invItem = await tx.inventoryItem.findFirst({
            where: { name: { equals: product.name, mode: 'insensitive' }, franchiseId: targetScopeId }
          });
        }
      }
      if (!invItem && item.productName) {
        invItem = await tx.inventoryItem.findFirst({
          where: { name: { equals: item.productName, mode: 'insensitive' }, franchiseId: targetScopeId }
        });
      }

      if (invItem) {
        // Recall override: regardless of what condition was submitted
        // (including "GOOD"), a return that traces back to a recalled
        // ProductBatch must never become normal saleable stock. Checked
        // before the GOOD/non-GOOD branch below so it can never be bypassed
        // by selecting GOOD.
        const recallHit = saleRef
          ? await RecallService.findRecallForSoldItem(tx, { ...saleRef, inventoryItemId: invItem.id })
          : null;

        if (recallHit) {
          await RecallService.recordRecallAffectedReturn(tx, {
            recallId: recallHit.recallId,
            productBatchId: recallHit.productBatchId,
            allRecalledProductBatchIds: recallHit.allRecalledProductBatchIds,
            inventoryItemId: invItem.id,
            quantity: item.quantity,
            userId,
            source: 'SALES_RETURN',
            sourceId: returnOrder.id,
            note: `Sales Return ${returnOrder.returnNumber}: ${item.quantity} ${item.productName} traced to a recalled batch — quarantined regardless of submitted condition ("${cond}")`,
          });
          await tx.returnItem.update({ where: { id: item.id }, data: { recallId: recallHit.recallId } });
          continue;
        }

        if (cond === 'GOOD') {
          // Phase 3: Case A/B lines (item.costProvenance EXACT/RECONSTRUCTED,
          // computed ONCE at createReturnOrder time — see
          // SalesService._computeReturnFifoAllocation) restore at the
          // ORIGINAL FIFO layer cost(s) persisted on item.costAllocation,
          // crediting back into the SAME original InventoryBatch row(s) by
          // id when they still exist (InventoryService.restoreToBatches
          // handles the id-based increment / genuinely-gone fallback).
          // Never the item's CURRENT costPrice.
          const hasFifoAllocation = (item.costProvenance === 'EXACT' || item.costProvenance === 'RECONSTRUCTED')
            && Array.isArray(item.costAllocation) && item.costAllocation.length > 0;

          if (hasFifoAllocation) {
            await InventoryService.restoreToBatches(tx, {
              itemId: invItem.id,
              allocation: item.costAllocation,
              movementType: 'SALES_RETURN_IN',
              referenceType: 'SALES_RETURN',
              referenceId: returnOrder.id,
              note: `Sales Return ${returnOrder.returnNumber}: +${item.quantity} ${item.productName} (FIFO cost restored: ₹${item.costReversal ?? 0}, provenance ${item.costProvenance})`,
              userId,
            });
          } else {
            // Case C (or a Case A/B line with, unexpectedly, no InventoryItem
            // resolvable at restore time) — no historical layer cost to
            // restore into. Falls back to today's pre-existing behavior
            // (new batch at the item's CURRENT costPrice via receiveAtCost,
            // or a plain stockIn with no batch at all), just relabeled
            // SALES_RETURN_IN instead of PURCHASE_IN for consistency. The
            // Case C marker itself (item.costProvenance) is what makes this
            // auditable — never silent.
            const sourceProductBatchId = saleRef
              ? await RecallService.resolveSingleSourceProductBatchId(tx, { ...saleRef, inventoryItemId: invItem.id })
              : null;
            if (sourceProductBatchId) {
              await InventoryService.recordMovement(tx, {
                itemId: invItem.id,
                type: 'SALES_RETURN_IN',
                quantity: item.quantity,
                referenceType: 'SALES_RETURN',
                referenceId: returnOrder.id,
                note: `Sales Return ${returnOrder.returnNumber}: +${item.quantity} ${item.productName} (cost provenance unavailable — restored at current cost)`,
                userId,
                receiveAtCost: {
                  unitCost: invItem.costPrice || 0,
                  batchNumber: `${invItem.sku || invItem.name}-RETURN`,
                  productBatchId: sourceProductBatchId,
                },
              });
            } else {
              await InventoryService.stockIn({
                itemId: invItem.id,
                quantity: item.quantity,
                type: 'SALES_RETURN_IN',
                referenceType: 'SALES_RETURN',
                referenceId: returnOrder.id,
                note: `Sales Return ${returnOrder.returnNumber}: +${item.quantity} ${item.productName} (cost provenance unavailable — restored at current cost)`,
                userId
              }, tx);
            }
          }
        } else {
          await tx.stockMovement.create({
            data: {
              itemId: invItem.id,
              movementType: 'RETURN_QUARANTINE_IN',
              quantity: item.quantity,
              baseQty: 0,
              referenceType: 'SALES_RETURN',
              referenceId: returnOrder.id,
              note: `Sales Return ${returnOrder.returnNumber} (${cond}): +${item.quantity} ${item.productName} (quarantine)`,
              createdBy: userId
            }
          });
        }
      }
    }
  }

  static async updateReturnOrder(id: string, data: { status?: string; approvedBy?: string }) {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.returnOrder.findUnique({
        where: { id },
        include: {
          items: true,
          posOrder: { select: { stateOfSupply: true, franchiseId: true } },
          salesOrder: { select: { stateOfSupply: true } },
          franchiseOrder: true
        }
      });

      if (!existing) throw new Error('Return Order not found');

      const updateData: any = {
        status: data.status as any,
        approvedBy: data.approvedBy,
        approvedAt: data.status === 'APPROVED' ? new Date() : undefined
      };

      // When transitioning from PENDING to APPROVED or COMPLETED, restore stock.
      // The financial basis (refundAmount/taxableValue/gstRate/cgst/sgst/
      // igst/taxAmount) is established once, at createReturnOrder time, from
      // the original sale's persisted figures — it must never be
      // recalculated here from today's Product Master tax rate. The GST
      // backfill that used to live in this block (taxableValue =
      // existing.refundAmount, a flat 5%-or-today's-taxPercent guess) has
      // been removed for exactly that reason: PENDING -> APPROVED must not
      // change the financial basis.
      if ((data.status === 'APPROVED' || data.status === 'COMPLETED') && existing.status !== 'APPROVED' && existing.status !== 'COMPLETED') {
        await SalesService.restoreStockForReturnOrder(tx, existing, data.approvedBy || 'SYSTEM');
      }

      return tx.returnOrder.update({
        where: { id },
        data: updateData,
        include: { customer: true, franchise: true, salesOrder: true, franchiseOrder: true, posOrder: true, items: true }
      });
    });
  }

  // Computes the same "due" figure FinanceService.getPartyReceivables uses
  // (Order.totalAmount - Σ non-cancelled Payment.paidAmount, including
  // multi-invoice PaymentAllocation rows) for ONE specific Order — reuses
  // FinanceService's own private summing helper (bracket-access: TS
  // `private` is compile-time only) rather than re-deriving the formula, so
  // this can never silently drift from what getPartyReceivables reports as
  // outstanding.
  static async _computeOrderDue(tx: any, orderId: string): Promise<{ due: number; order: any }> {
    const { FinanceService } = require('../finance/finance.service');
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        totalAmount: true,
        payments: { select: { id: true, paidAmount: true, isCancelled: true, status: true } },
        invoice: { select: { allocations: { select: { amount: true, payment: { select: { id: true, invoiceId: true, status: true, isCancelled: true } } } } } }
      }
    });
    if (!order) return { due: 0, order: null };
    const paid = (FinanceService as any).sumOrderPaidWithAllocations(
      order.payments,
      order.invoice?.allocations,
      (p: any) => !p.isCancelled && p.status !== 'CANCELLED'
    );
    const due = Math.max(0, (order.totalAmount || 0) - paid);
    return { due, order };
  }

  // Credit Ledger refund for a Customer party. Always writes exactly one
  // CustomerLedger CREDIT row (referenceType RETURN, full refundAmount) —
  // this is the durable "customer was credited" record regardless of
  // whether any of it could be applied to a real outstanding balance.
  //
  // IF the return traces to a genuinely unpaid/partially-paid original
  // Order (only posOrderId-linked returns can — SalesOrder has no Payment/
  // Invoice relation in the schema at all, so a salesOrderId-only return has
  // no due to apply against and always takes the ledger-only branch), we
  // ALSO create a Payment (flow IN) against that Order so
  // FinanceService.getPartyReceivables' live due calculation actually
  // reflects the reduced balance, per the architecture doc's explicit
  // warning that outstanding is NOT ledger-sourced.
  //
  // That applied Payment is deliberately created with status: 'SUCCESS'
  // rather than 'PAID', and WITHOUT entityType: 'CUSTOMER'. Two reasons,
  // both verified against createPayment's actual code (finance.service.ts):
  //   1. createPayment moves the linked Account's REAL balance for ANY
  //      status:'PAID' payment regardless of flow (see the unconditional
  //      `if (account && status === 'PAID') AccountService.adjustBalance`
  //      step). A Credit Ledger refund involves NO real cash — using
  //      status:'PAID' here would silently inflate a real Cash/Bank
  //      account's balance for money that never moved. status:'SUCCESS' is
  //      not invented for this purpose — it's already an equally-valid
  //      "not cancelled" Payment status elsewhere in this codebase (see
  //      finance.service.ts's own getDealerLedger-equivalent filter
  //      `status === 'PAID' || status === 'SUCCESS'`, and
  //      franchise-order.service.ts's direct tx.payment.create calls), and
  //      getPartyReceivables' isValid filter is `status !== 'CANCELLED'`
  //      (not `=== 'PAID'`), so this Payment is correctly counted as
  //      reducing due without moving real money.
  //   2. Omitting entityType: 'CUSTOMER' on THIS call skips createPayment's
  //      own automatic CustomerLedger write (section 5a) — without this we
  //      would get a SECOND CustomerLedger row (referenceType PAYMENT) for
  //      the same refund event, double-counting the credit. Our single
  //      manual 'RETURN' row below is the only ledger entry for this event.
  // Known gap (documented, not silently glossed over): because the applied
  // Payment is intentionally not status:'PAID', it does not flip
  // Invoice.status/Order.paymentStatus to PAID/PARTIAL the way a real cash
  // receipt would (that recompute is itself gated on status==='PAID').
  // Every current POS checkout pays in full at checkout (pos.service.ts),
  // so a genuinely-unpaid linked Order is already an edge case; this is
  // flagged as a Phase 3 follow-up rather than solved here by inventing a
  // second payment-creation path, which is explicitly out of scope.
  static async _applyCustomerCreditLedgerRefund(tx: any, ret: any, createdBy?: string) {
    const { FinanceService } = require('../finance/finance.service');

    let appliedAmount = 0;
    let appliedPayment: any = null;

    if (ret.posOrderId) {
      const { due } = await SalesService._computeOrderDue(tx, ret.posOrderId);
      appliedAmount = Math.round(Math.min(ret.refundAmount, due) * 100) / 100;
      if (appliedAmount > 0.01) {
        appliedPayment = await FinanceService.createPayment({
          tx,
          amount: appliedAmount,
          flow: 'IN',
          status: 'SUCCESS', // non-cash credit application — see comment above
          sourceModule: 'POS',
          linkedDocType: 'DIRECT',
          linkedDocId: ret.id,
          orderId: ret.posOrderId,
          entityId: ret.customerId,
          entity: 'Customer Credit Ledger (return applied to unpaid order)',
          method: 'CASH',
          franchiseId: ret.posOrder?.franchiseId || undefined,
          idempotencyKey: `RETURN_REFUND_${ret.id}_APPLY`,
          createdBy
        });
      }
    }
    // ret.salesOrderId-only returns: SalesOrder has no Payment/Invoice
    // relation in the schema, so there is no "unpaid order" this credit can
    // be applied against — always ledger-only for that case (see class
    // comment above).

    const note = appliedAmount > 0.01
      ? `Return #${ret.returnNumber} credited to customer ledger (₹${appliedAmount.toFixed(2)} of ₹${ret.refundAmount.toFixed(2)} applied to reduce the outstanding balance on the original order)`
      : `Return #${ret.returnNumber} credited to customer ledger`;

    const ledgerEntry = await tx.customerLedger.create({
      data: {
        customerId: ret.customerId,
        type: 'CREDIT',
        amount: ret.refundAmount,
        paymentMode: 'CASH',
        referenceType: 'RETURN',
        referenceId: ret.id,
        note
      }
    });

    return { ledgerEntry, appliedPayment, appliedToOutstanding: appliedAmount };
  }

  // Dealer Credit Ledger refund. Dealer has NO ledger table and NO
  // outstandingAmount column in the schema (confirmed: prisma/schema.prisma
  // Dealer model only has openingBalance/creditLimit) — the ONLY existing
  // mechanism that can represent "this dealer was credited" is applying a
  // Payment against a genuinely unpaid original Order, exactly like the
  // Customer path above. If there is no such unpaid order, there is
  // nothing to record this against — reject clearly rather than silently
  // doing nothing or inventing a new ledger.
  static async _applyDealerCreditLedgerRefund(tx: any, ret: any, createdBy?: string) {
    const { FinanceService } = require('../finance/finance.service');

    if (!ret.posOrderId) {
      throw new Error('Credit Ledger refund is not supported for this Dealer return: there is no linked order to apply the credit to, and Dealers have no standalone ledger/outstanding-balance mechanism in this system.');
    }
    const { due } = await SalesService._computeOrderDue(tx, ret.posOrderId);
    const appliedAmount = Math.round(Math.min(ret.refundAmount, due) * 100) / 100;
    if (appliedAmount <= 0.01) {
      throw new Error('Credit Ledger refund is not supported for this Dealer return: the original order has no outstanding balance to apply the credit to, and Dealers have no standalone ledger/outstanding-balance mechanism in this system.');
    }

    const appliedPayment = await FinanceService.createPayment({
      tx,
      amount: appliedAmount,
      flow: 'IN',
      status: 'SUCCESS', // non-cash credit application — see Customer path comment above
      sourceModule: 'POS',
      linkedDocType: 'DIRECT',
      linkedDocId: ret.id,
      orderId: ret.posOrderId,
      entityType: 'DEALER',
      entityId: ret.dealerId,
      entity: 'Dealer Credit Ledger (return applied to unpaid order)',
      method: 'CASH',
      franchiseId: ret.posOrder?.franchiseId || undefined,
      idempotencyKey: `RETURN_REFUND_${ret.id}_APPLY`,
      createdBy
    });

    return { ledgerEntry: null, appliedPayment, appliedToOutstanding: appliedAmount };
  }

  // Franchise Credit Ledger refund. Franchise DOES have a direct
  // outstandingAmount column + FranchiseLedger table, unlike Dealer — mirror
  // finance.service.ts's own CREDIT-reduces-outstanding pattern exactly
  // (e.g. the "Payment to HQ" block in franchise-order.service.ts): CREDIT
  // type, amount = refundAmount, newOutstanding = outstandingAmount -
  // refundAmount, floored at 0 (a return can't put a franchise into a
  // negative "owes less than zero" state via this path), balanceAfter
  // written alongside the Franchise.outstandingAmount update in the same
  // transaction. FranchiseLedgerRefType.RETURN exists in the schema
  // specifically for this.
  static async _applyFranchiseCreditLedgerRefund(tx: any, ret: any) {
    const franchise = await tx.franchise.findUnique({ where: { id: ret.franchiseId }, select: { outstandingAmount: true } });
    const currentOutstanding = franchise?.outstandingAmount || 0;
    const newOutstanding = Math.max(0, currentOutstanding - ret.refundAmount);

    const ledgerEntry = await tx.franchiseLedger.create({
      data: {
        franchiseId: ret.franchiseId,
        type: 'CREDIT',
        amount: ret.refundAmount,
        balanceAfter: newOutstanding,
        referenceType: 'RETURN',
        referenceId: ret.id,
        note: `Return #${ret.returnNumber} credited to franchise ledger`
      }
    });

    await tx.franchise.update({
      where: { id: ret.franchiseId },
      data: { outstandingAmount: newOutstanding }
    });

    return { ledgerEntry, appliedPayment: null, appliedToOutstanding: ret.refundAmount };
  }

  // Phase 2: the single entry point that actually moves money/ledger/state
  // for an approved return, reading ONLY ret.refundAmount (already correct,
  // computed once at createReturnOrder time by Phase 1 — never recomputed,
  // never client-trusted here). Wrapped in one transaction so a failure
  // anywhere (insufficient funds, an unsupported Dealer Credit Ledger
  // request, etc.) leaves NO Payment/ledger row and the ReturnOrder still
  // APPROVED, never a half-applied refund.
  static async recordRefund(returnId: string, data: { refundMethod?: string; accountId?: string; method?: string; createdBy?: string }) {
    const { FinanceService } = require('../finance/finance.service');

    return prisma.$transaction(async (tx) => {
      // Row-level lock FIRST, before any read of `status` — this is what
      // actually makes two concurrent refund requests for the same return
      // safe, not just the idempotencyKey below. A second concurrent
      // transaction's SELECT ... FOR UPDATE blocks here until the first
      // transaction commits or rolls back, so by the time it proceeds it is
      // guaranteed to see the FIRST transaction's final status (COMPLETED
      // on success), never a stale APPROVED read. The idempotencyKey passed
      // to createPayment below is a second, independent backstop
      // specifically for the cash/bank path (a unique-constraint collision
      // if this lock were ever bypassed, e.g. a raw SQL update elsewhere).
      await tx.$queryRaw`SELECT id FROM "ReturnOrder" WHERE id = ${returnId} FOR UPDATE`;

      const ret = await tx.returnOrder.findUnique({
        where: { id: returnId },
        include: { 
          items: true, 
          customer: true, 
          dealer: true, 
          franchise: true, 
          posOrder: { include: { payments: true } }, 
          salesOrder: true, 
          franchiseOrder: true 
        }
      });
      if (!ret) throw new Error('Return Order not found');
      if (ret.status === 'COMPLETED') throw new Error('This return has already been refunded.');
      if (ret.status !== 'APPROVED') throw new Error(`Only approved returns can be refunded (current status: ${ret.status}).`);

      // Ensure refundAmount strictly includes GST from the original sale invoice
      let finalRefundAmount = Number(ret.refundAmount) || 0;
      const taxable = Number(ret.taxableValue) || 0;
      const tax = Number(ret.taxAmount) || 0;
      if (tax > 0 && Math.abs(finalRefundAmount - taxable) < 0.01) {
        finalRefundAmount = Math.round((taxable + tax) * 100) / 100;
      }

      const idempotencyKey = `RETURN_REFUND_${returnId}`;
      const refundMethod = (data.refundMethod || ret.refundMethod || 'Original Method').trim();
      const isCreditLedger = refundMethod === 'Credit Ledger';

      const partyLabel = ret.customerId ? 'Customer Refund' : ret.dealerId ? 'Dealer Refund' : ret.franchiseId ? 'Franchise Refund' : 'Sales Refund';
      const entityType = ret.customerId ? 'CUSTOMER' : ret.dealerId ? 'DEALER' : ret.franchiseId ? 'FRANCHISE' : undefined;
      const entityId = ret.customerId || ret.dealerId || ret.franchiseId || undefined;

      let payment: any = null;
      let ledger: any = null;

      if (isCreditLedger) {
        // Credit Ledger path — see the three _apply*CreditLedgerRefund helpers above
        const retForCredit = { ...ret, refundAmount: finalRefundAmount };
        if (ret.customerId) {
          ledger = await SalesService._applyCustomerCreditLedgerRefund(tx, retForCredit, data.createdBy);
        } else if (ret.dealerId) {
          ledger = await SalesService._applyDealerCreditLedgerRefund(tx, retForCredit, data.createdBy);
        } else if (ret.franchiseId) {
          ledger = await SalesService._applyFranchiseCreditLedgerRefund(tx, retForCredit);
        } else {
          throw new Error('Credit Ledger refund requires a Customer, Dealer, or Franchise party on this return.');
        }
      } else {
        // Cash / Bank / UPI path:
        // Settlement method was decided earlier in the sales/return flow.
        // Auto-resolve account and payment method if not explicitly passed by UI.
        let resolvedAccountId: string | undefined = data.accountId || undefined;
        let resolvedMethod: string | undefined = data.method || undefined;

        if (!resolvedAccountId) {
          // 1. Try to find the original payment account from the linked POS order
          const origPayment = ret.posOrder?.payments?.find((p: any) => p.accountId && p.status === 'PAID');
          if (origPayment && origPayment.accountId) {
            resolvedAccountId = origPayment.accountId;
            if (!resolvedMethod && origPayment.paymentMode) resolvedMethod = origPayment.paymentMode;
          }
        }

        // 2. If still no account, resolve the operating franchise's primary CASH or operating account
        const targetFranchiseId = ret.posOrder?.franchiseId || ret.franchiseId;
        if (!resolvedAccountId && targetFranchiseId) {
          const cashAcc = await tx.account.findFirst({
            where: { franchiseId: targetFranchiseId, type: 'CASH' }
          });
          if (cashAcc) {
            resolvedAccountId = cashAcc.id;
          } else {
            const anyAcc = await tx.account.findFirst({
              where: { franchiseId: targetFranchiseId }
            });
            if (anyAcc) resolvedAccountId = anyAcc.id;
          }
        }

        // 3. Fallback for Super Admin / HQ return
        if (!resolvedAccountId) {
          const hqCash = await tx.account.findFirst({
            where: { franchiseId: null, type: 'CASH' }
          }) || await tx.account.findFirst({
            where: { franchiseId: null }
          });
          if (hqCash) resolvedAccountId = hqCash.id;
        }

        if (!resolvedAccountId) {
          throw new Error('Unable to resolve a settlement account for this refund. Please ensure a payment account exists for your branch.');
        }

        if (!resolvedMethod) {
          resolvedMethod = ret.posOrder?.paymentType || 'CASH';
        }

        payment = await FinanceService.createPayment({
          tx,
          amount: finalRefundAmount,
          flow: 'OUT',
          status: 'PAID',
          sourceAccount: resolvedAccountId,
          method: resolvedMethod,
          sourceModule: 'POS',
          linkedDocType: 'DIRECT',
          linkedDocId: ret.id,
          entityType,
          entityId,
          entity: partyLabel,
          idempotencyKey,
          createdBy: data.createdBy
        });
      }

      const updated = await tx.returnOrder.update({
        where: { id: returnId },
        data: { 
          status: 'COMPLETED',
          refundAmount: finalRefundAmount
        },
        include: { items: true, customer: true, dealer: true, franchise: true }
      });

      return { returnOrder: updated, payment, ledger };
    });
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  static async getSalesAnalytics(filters: { dateFrom?: string; dateTo?: string }) {
    const where: any = {};
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {})
      };
    }

    const [orders, quotations, returns] = await Promise.all([
      prisma.salesOrder.findMany({ where, include: { items: true } }),
      prisma.quotation.findMany({ where }),
      prisma.returnOrder.findMany({ where })
    ]);

    const totalRevenue = orders.reduce((s, o) => s + o.totalAmount, 0);
    const totalReturns = returns.reduce((s, r) => s + r.refundAmount, 0);
    const conversionRate = quotations.length
      ? (quotations.filter((q) => q.status === 'CONVERTED').length / quotations.length) * 100
      : 0;

    return {
      totalOrders: orders.length,
      totalRevenue,
      totalQuotations: quotations.length,
      convertedQuotations: quotations.filter((q) => q.status === 'CONVERTED').length,
      conversionRate: Number(conversionRate.toFixed(1)),
      totalReturns: returns.length,
      totalReturnAmount: totalReturns,
      netRevenue: totalRevenue - totalReturns
    };
  }

  // ─── Delivery Challans ───────────────────────────────────────────────────────

  // A challan has exactly one destination — Customer, Dealer, or Franchise —
  // never more than one. Dealer is architecturally equivalent to Customer for
  // stock accounting (external party, no receiving ledger of its own) but is
  // a distinct master, so it gets its own column rather than overloading
  // customerId. Doesn't require exactly one (a DRAFT may have none yet,
  // matching existing Customer/Franchise behavior — the frontend enforces
  // "required" only once the challan actually goes IN_TRANSIT).
  private static assertSingleDestination(customerId?: string | null, dealerId?: string | null, franchiseId?: string | null) {
    const provided = [customerId, dealerId, franchiseId].filter(Boolean);
    if (provided.length > 1) {
      throw new Error('A delivery challan can only have one destination: Customer, Dealer, or Franchise.');
    }
  }

  static async getDeliveryChallans(filters: { customerId?: string; status?: string; search?: string; franchiseId?: string }) {
    // One-time safe migration: legacy rows stored status 'OPEN' before the IN_TRANSIT rename
    await prisma.deliveryChallan.updateMany({ where: { status: 'OPEN' }, data: { status: 'IN_TRANSIT' } });

    const where: any = {};
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status;
    if (filters.franchiseId) {
      const hq = await FranchiseService.getHqFranchiseOrNull();
      if (hq && hq.id === filters.franchiseId) {
        where.OR = [
          { sourceFranchiseId: filters.franchiseId },
          { sourceFranchiseId: null }
        ];
      } else {
        where.OR = [
          { sourceFranchiseId: filters.franchiseId },
          { franchiseId: filters.franchiseId }
        ];
      }
    }
    if (filters.search) {
      const searchOr = [
        { challanNumber: { contains: filters.search, mode: 'insensitive' } },
        { vehicleNo: { contains: filters.search, mode: 'insensitive' } }
      ];
      if (where.OR) {
        where.AND = [{ OR: searchOr }];
      } else {
        where.OR = searchOr;
      }
    }
    return prisma.deliveryChallan.findMany({
      where,
      include: { customer: true, dealer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getDeliveryChallanById(id: string) {
    return prisma.deliveryChallan.findUnique({
      where: { id },
      include: { customer: true, dealer: true, items: true, returns: { include: { items: true } } }
    });
  }

  // Invoice Qty vs Dispatch Qty (see schema comment on DeliveryChallan) —
  // sums quantity already committed to OTHER non-cancelled DCs against the
  // same source Tax Invoice, per product, so a second/third partial
  // dispatch can never push the cumulative total past what was invoiced.
  private static async getRemainingInvoiceQty(sourceInvoiceId: string, excludeChallanId?: string): Promise<Record<string, { invoiceQty: number; dispatchedQty: number; remaining: number }>> {
    const order = await prisma.order.findUnique({ where: { id: sourceInvoiceId }, include: { orderItems: true } });
    if (!order) throw new Error('Source Tax Invoice not found.');

    const otherChallans = await prisma.deliveryChallan.findMany({
      where: { sourceInvoiceId, status: { not: 'CANCELLED' }, ...(excludeChallanId ? { id: { not: excludeChallanId } } : {}) },
      include: { items: true }
    });

    const dispatchedByProduct: Record<string, number> = {};
    for (const dc of otherChallans) {
      for (const item of dc.items) {
        if (!item.productId) continue;
        dispatchedByProduct[item.productId] = (dispatchedByProduct[item.productId] || 0) + item.quantity;
      }
    }

    const result: Record<string, { invoiceQty: number; dispatchedQty: number; remaining: number }> = {};
    for (const oi of order.orderItems) {
      const dispatchedQty = dispatchedByProduct[oi.productId] || 0;
      result[oi.productId] = { invoiceQty: oi.quantity, dispatchedQty, remaining: Math.max(0, oi.quantity - dispatchedQty) };
    }
    return result;
  }

  static async createDeliveryChallan(data: {
    customerId?: string;
    dealerId?: string;
    salesOrderId?: string;
    sourceInvoiceId?: string;
    franchiseId?: string;
    sourceFranchiseId?: string;
    challanDate?: string;
    dueDate?: string;
    vehicleNo?: string;
    driverName?: string;
    stateOfSupply?: string;
    status?: string;
    notes?: string;
    termsConditions?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate?: number; taxPercent?: number; batchNumber?: string }>;
    idempotencyKey?: string;
  }, userId: string = 'system') {
    // A retry/double-click/API re-entry with the same key returns the
    // already-created Challan instead of posting a second one — the DC has
    // no source document to naturally dedup against (unlike Estimate->SO).
    if (data.idempotencyKey) {
      const existing = await prisma.deliveryChallan.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { customer: true, dealer: true, items: true } });
      if (existing) return existing;
    }

    SalesService.assertSingleDestination(data.customerId, data.dealerId, data.franchiseId);
    if (data.customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: data.customerId } });
      if (!customer) throw new Error('Selected customer not found.');
      const hq = await FranchiseService.getHqFranchiseOrNull();
      const isHqChallan = !data.sourceFranchiseId || (hq && hq.id === data.sourceFranchiseId);
      if (isHqChallan) {
        if (customer.franchiseId && hq && customer.franchiseId !== hq.id) {
          throw new Error(`Customer "${customer.name}" belongs to a branch franchise and cannot receive challans from HQ.`);
        }
      } else {
        if (customer.franchiseId !== data.sourceFranchiseId) {
          throw new Error(`Customer "${customer.name}" does not belong to this franchise.`);
        }
      }
    }
    if (data.dealerId) {
      const dealer = await prisma.dealer.findUnique({ where: { id: data.dealerId } });
      if (!dealer) throw new Error('Selected dealer not found.');
      if (dealer.status === 'INACTIVE') {
        throw new Error('Dealer is inactive. This operation is not allowed.');
      }
    }

    // Invoice Qty vs Dispatch Qty: only enforced going IN_TRANSIT (a DRAFT
    // is just a plan and may still change) and only for source-invoice-
    // linked challans (a DIRECT challan has no invoice qty to cap against).
    if (data.sourceInvoiceId && data.status === 'IN_TRANSIT') {
      const remaining = await SalesService.getRemainingInvoiceQty(data.sourceInvoiceId);
      for (const item of data.items) {
        if (!item.productId) continue;
        const r = remaining[item.productId];
        if (!r) continue; // item not on the source invoice — allow (e.g. a substitute), don't block
        if (item.quantity > r.remaining + 0.001) {
          throw new Error(`Cannot dispatch ${item.quantity} of "${item.productName}" — only ${r.remaining} remains undispatched (Invoice Qty ${r.invoiceQty}, already dispatched ${r.dispatchedQty}).`);
        }
      }
    }

    // DC's destination is mutually exclusive (assertSingleDestination
    // above) and directly determines the channel — no separate partyType
    // field needed here, unlike the abstract-party documents.
    const dcPartyType: 'CUSTOMER' | 'DEALER' | 'FRANCHISE' =
      data.dealerId ? 'DEALER' : data.franchiseId ? 'FRANCHISE' : 'CUSTOMER';
    const resolvedSourceFranchiseId = data.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id || null;
    const dcScopeFranchiseId = resolvedSourceFranchiseId
      ? await FranchiseService.toInventoryScopeId(prisma, resolvedSourceFranchiseId)
      : null;
    const pricedDcItems = await applyAuthoritativePricing(
      prisma,
      data.items.map((i) => ({ ...i, rate: i.rate || 0, taxPercent: i.taxPercent || 0 })),
      dcScopeFranchiseId,
      dcPartyType,
      false // Delivery Challan has no discount concept — see applyAuthoritativePricing
    );
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(pricedDcItems);

    try {
      return await prisma.$transaction(async (tx) => {
        const challanNumber = await nextDocumentNumber(tx, 'DC', 'DC');

        const newChallan = await tx.deliveryChallan.create({
          data: {
            challanNumber,
            idempotencyKey: data.idempotencyKey || undefined,
            customerId: data.customerId || null,
            dealerId: data.dealerId || null,
            salesOrderId: data.salesOrderId || null,
            sourceInvoiceId: data.sourceInvoiceId || null,
            franchiseId: data.franchiseId || null,
            sourceFranchiseId: data.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id || null,
            status: data.status || 'DRAFT',
            challanDate: data.challanDate ? new Date(data.challanDate) : new Date(),
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            vehicleNo: data.vehicleNo || null,
            driverName: data.driverName || null,
            stateOfSupply: data.stateOfSupply || null,
            notes: data.notes || null,
            termsConditions: data.termsConditions || null,
            subTotal,
            taxAmount,
            totalAmount,
            items: {
              create: computed.map((i) => ({
                productId: i.productId || null,
                productName: i.productName,
                batchNumber: (i as any).batchNumber || null,
                quantity: i.quantity,
                unit: i.unit || 'NONE',
                rate: i.rate,
                taxPercent: i.taxPercent || 0,
                taxAmount: i.taxAmount,
                totalAmount: i.totalAmount
              }))
            }
          },
          include: { customer: true, dealer: true, items: true }
        });

        // Delivery Challan is a dispatch/delivery document that can be created/saved even if current stock is 0.
        // Stock deduction happens when the challan is converted to a Sale Invoice.
        if (newChallan.status === 'IN_TRANSIT' && (data as any).deductStockOnDispatch) {
          await SalesService.dispatchChallanStock(newChallan, userId, tx);
        }

        return newChallan;
      });
    } catch (err: any) {
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.deliveryChallan.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { customer: true, dealer: true, items: true } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  static async updateDeliveryChallan(id: string, data: { status?: string; vehicleNo?: string; driverName?: string; notes?: string; customerId?: string | null; dealerId?: string | null; franchiseId?: string | null }, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      const currentChallan = await tx.deliveryChallan.findUnique({ where: { id }, include: { items: true } });
      if (!currentChallan) throw new Error('Delivery challan not found');

      // Legacy rows/clients may still send/hold 'OPEN' — treat it as IN_TRANSIT
      const currentStatus = currentChallan.status === 'OPEN' ? 'IN_TRANSIT' : currentChallan.status;
      if (data.status === 'OPEN') data.status = 'IN_TRANSIT';

      // Idempotent no-op: repeat "Dispatch"/"Mark Delivered" clicks land here
      // with the SAME target status as the current one — status validation
      // below would otherwise reject e.g. IN_TRANSIT -> IN_TRANSIT, but a
      // duplicate click must be a harmless no-op, not an error toast.
      if (data.status && data.status === currentStatus) {
        return tx.deliveryChallan.findUnique({ where: { id }, include: { customer: true, dealer: true, items: true } });
      }

      // Block moving away from CLOSED or CONVERTED once delivered
      if ((currentStatus === 'CLOSED' || currentStatus === 'CONVERTED') && data.status && data.status !== currentStatus) {
        throw new Error('Cannot change status of a closed delivery challan');
      }

      if ('customerId' in data || 'dealerId' in data || 'franchiseId' in data) {
        SalesService.assertSingleDestination(
          'customerId' in data ? data.customerId : currentChallan.customerId,
          'dealerId' in data ? data.dealerId : currentChallan.dealerId,
          'franchiseId' in data ? data.franchiseId : currentChallan.franchiseId
        );
        if (data.dealerId) {
          const dealer = await tx.dealer.findUnique({ where: { id: data.dealerId } });
          if (!dealer) throw new Error('Selected dealer not found.');
          if (dealer.status === 'INACTIVE') {
            throw new Error('Dealer is inactive. This operation is not allowed.');
          }
        }
      }

      // Invoice Qty vs Dispatch Qty guard also applies to Draft -> Dispatch
      // (createDeliveryChallan only checks it for a challan created
      // already-IN_TRANSIT — most challans start DRAFT then dispatch later).
      if (currentChallan.sourceInvoiceId && currentStatus === 'DRAFT' && data.status === 'IN_TRANSIT') {
        const remaining = await SalesService.getRemainingInvoiceQty(currentChallan.sourceInvoiceId, id);
        for (const item of currentChallan.items) {
          if (!item.productId) continue;
          const r = remaining[item.productId];
          if (!r) continue;
          if (item.quantity > r.remaining + 0.001) {
            throw new Error(`Cannot dispatch ${item.quantity} of "${item.productName}" — only ${r.remaining} remains undispatched (Invoice Qty ${r.invoiceQty}, already dispatched ${r.dispatchedQty}).`);
          }
        }
      }

      const updated = await tx.deliveryChallan.update({ where: { id }, data, include: { customer: true, dealer: true, items: true } });

      // Handle Stock Transitions
      // A Delivery Challan is a dispatch document; stock deduction occurs when converted to Sale Invoice.
      if (currentStatus === 'DRAFT' && updated.status === 'IN_TRANSIT' && (data as any).deductStockOnDispatch) {
        await SalesService.dispatchChallanStock(updated, userId, tx);
      } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CLOSED' && (data as any).receiveStockOnDelivered) {
        await SalesService.receiveChallanStock(updated, userId, tx);
      } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CANCELLED' && (data as any).deductStockOnDispatch) {
        await SalesService.reverseChallanStock(updated, userId, tx);
      }

      return updated;
    }, { timeout: 20000 });
  }

  // Explicit delivery confirmation — separate from a generic status PATCH so
  // receivedBy/deliveredAt/podReference are never left blank on a CLOSED
  // challan, and a repeat click is a safe no-op (already CLOSED -> return
  // as-is) rather than a second stock receipt.
  static async markChallanDelivered(id: string, data: { receivedBy?: string; deliveredAt?: string; podReference?: string }, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      const currentChallan = await tx.deliveryChallan.findUnique({ where: { id }, include: { items: true } });
      if (!currentChallan) throw new Error('Delivery challan not found');
      const currentStatus = currentChallan.status === 'OPEN' ? 'IN_TRANSIT' : currentChallan.status;

      if (currentStatus === 'CLOSED') {
        return tx.deliveryChallan.findUnique({ where: { id }, include: { customer: true, dealer: true, items: true } });
      }
      if (currentStatus !== 'IN_TRANSIT') {
        throw new Error(`Only an IN_TRANSIT delivery challan can be marked Delivered (current status: ${currentStatus}).`);
      }

      const updated = await tx.deliveryChallan.update({
        where: { id },
        data: {
          status: 'CLOSED',
          receivedBy: data.receivedBy || null,
          deliveredAt: data.deliveredAt ? new Date(data.deliveredAt) : new Date(),
          podReference: data.podReference || null,
        },
        include: { customer: true, dealer: true, items: true }
      });

      if ((data as any).receiveStockOnDelivered) {
        await SalesService.receiveChallanStock(updated, userId, tx);
      }
      return updated;
    }, { timeout: 20000 });
  }

  // Transit Stock — deliberately not its own table (see schema comment):
  // derived read of every IN_TRANSIT challan, exploded per item, with the
  // fields the Transit Stock view needs. "Warehouse" here is the source
  // franchise's primary warehouse — see InventoryService.computeWarehouseStock
  // for the same franchise<->warehouse attribution used for stock reports.
  // Real UOM source of truth, in priority order: the DC line's own unit (if
  // actually set to something other than the placeholder default) -> the
  // dispatching franchise's InventoryItem for that SKU -> "NONE" only if
  // truly nothing else is known. Fixes the "10 NONE" display bug, which
  // came from trusting DeliveryChallanItem.unit's schema default blindly.
  private static async resolveDisplayUnit(item: { unit: string; productId: string | null }, sourceFranchiseId: string | null): Promise<string> {
    if (item.unit && item.unit !== 'NONE') return item.unit;
    if (!item.productId) return (item.unit && item.unit !== 'NONE') ? item.unit : 'PCS';
    const product = await prisma.product.findUnique({ where: { id: item.productId }, select: { sku: true } });
    if (sourceFranchiseId && product?.sku) {
      const invItem = await prisma.inventoryItem.findFirst({ where: { franchiseId: sourceFranchiseId, sku: product.sku }, select: { unit: true } });
      if (invItem?.unit && invItem.unit !== 'NONE') return invItem.unit;
    }
    const recipe = await prisma.recipe.findFirst({ where: { productId: item.productId }, select: { yieldUnit: true } });
    if (recipe?.yieldUnit && recipe.yieldUnit !== 'NONE') return recipe.yieldUnit;
    return 'PCS';
  }

  private static resolvePartyType(dc: { customerId: string | null; dealerId: string | null; franchiseId: string | null }): string {
    return dc.customerId ? 'CUSTOMER' : dc.dealerId ? 'DEALER' : dc.franchiseId ? 'FRANCHISE' : 'UNKNOWN';
  }

  static async getTransitStock() {
    const challans = await prisma.deliveryChallan.findMany({
      where: { status: { in: ['IN_TRANSIT', 'OPEN'] } },
      include: { customer: true, dealer: true, items: true },
      orderBy: { challanDate: 'desc' }
    });

    const franchiseIds = [...new Set([
      ...challans.map(c => c.sourceFranchiseId),
      ...challans.map(c => c.franchiseId),
    ].filter(Boolean))] as string[];
    const franchises = franchiseIds.length
      ? await prisma.franchise.findMany({ where: { id: { in: franchiseIds } }, include: { primaryWarehouse: true } })
      : [];
    const franchiseById = new Map(franchises.map(f => [f.id, f]));

    const rows: any[] = [];
    for (const dc of challans) {
      const partyType = SalesService.resolvePartyType(dc);
      const partyName = dc.customer?.name || dc.dealer?.name || (dc.franchiseId ? franchiseById.get(dc.franchiseId)?.name : null) || null;
      const sourceFranchise = dc.sourceFranchiseId ? franchiseById.get(dc.sourceFranchiseId) : null;
      for (const item of dc.items) {
        rows.push({
          challanId: dc.id,
          challanNumber: dc.challanNumber,
          sourceDocument: dc.sourceInvoiceId ? 'SALES_INVOICE' : 'DIRECT',
          sourceInvoiceId: dc.sourceInvoiceId,
          salesOrderId: dc.salesOrderId,
          partyType,
          partyName,
          franchiseId: dc.franchiseId,
          sourceFranchiseId: dc.sourceFranchiseId,
          sourceWarehouseName: sourceFranchise?.primaryWarehouse?.name || sourceFranchise?.name || null,
          productId: item.productId,
          productName: item.productName,
          batchNumber: item.batchNumber,
          quantity: item.quantity,
          unit: await SalesService.resolveDisplayUnit(item, dc.sourceFranchiseId),
          dispatchDate: dc.challanDate,
          expectedDeliveryDate: dc.dueDate,
          vehicleNo: dc.vehicleNo,
          driverName: dc.driverName,
          status: 'IN_TRANSIT',
        });
      }
    }
    return rows;
  }

  // Dispatch Tracking — shipment-level (one row per Delivery Challan, not
  // per item, unlike Transit Stock which is quantity-level). Deliberately
  // NOT its own table: DeliveryChallan already carries every field this
  // view needs (status, vehicle, driver, dates, receivedBy/POD), so a
  // separate DispatchTracking model would just be a duplicate dispatch
  // record kept in sync by hand. "Dispatch ID" reuses the same DC-YYYY-N
  // sequence value under a DSP- prefix rather than minting a second
  // sequence for what is definitionally the same one-to-one shipment.
  static async getDispatchTracking(filters: { status?: string } = {}) {
    const challans = await prisma.deliveryChallan.findMany({
      where: filters.status ? { status: filters.status === 'OPEN' ? 'IN_TRANSIT' : filters.status } : undefined,
      include: { customer: true, dealer: true, items: true },
      orderBy: { challanDate: 'desc' }
    });

    const franchiseIds = [...new Set([
      ...challans.map(c => c.sourceFranchiseId),
      ...challans.map(c => c.franchiseId),
    ].filter(Boolean))] as string[];
    const franchises = franchiseIds.length
      ? await prisma.franchise.findMany({ where: { id: { in: franchiseIds } } })
      : [];
    const franchiseById = new Map(franchises.map(f => [f.id, f]));

    // sourceInvoiceId is an Order.id — resolve the human-readable invoice
    // number for the ones that have one, in a single batched query.
    const invoiceIds = [...new Set(challans.map(c => c.sourceInvoiceId).filter(Boolean))] as string[];
    const orders = invoiceIds.length
      ? await prisma.order.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNum: true } })
      : [];
    const invoiceNumById = new Map(orders.map(o => [o.id, o.invoiceNum]));

    return challans.map(dc => {
      const status = dc.status === 'OPEN' ? 'IN_TRANSIT' : dc.status;
      const dispatchId = dc.challanNumber.replace(/^DC-/, 'DSP-');
      const partyType = SalesService.resolvePartyType(dc);
      const partyName = dc.customer?.name || dc.dealer?.name || (dc.franchiseId ? franchiseById.get(dc.franchiseId)?.name : null) || null;
      return {
        dispatchId,
        challanId: dc.id,
        challanNumber: dc.challanNumber,
        sourceInvoiceId: dc.sourceInvoiceId,
        invoiceNumber: dc.sourceInvoiceId ? invoiceNumById.get(dc.sourceInvoiceId) || null : null,
        salesOrderId: dc.salesOrderId,
        partyType,
        partyName,
        vehicleNo: dc.vehicleNo,
        driverName: dc.driverName,
        dispatchDate: dc.challanDate,
        expectedDeliveryDate: dc.dueDate,
        deliveredAt: dc.deliveredAt,
        receivedBy: dc.receivedBy,
        podReference: dc.podReference,
        itemCount: dc.items.length,
        totalQty: dc.items.reduce((s, i) => s + i.quantity, 0),
        status,
      };
    });
  }

  // ─── Delivery Challan Returns ─────────────────────────────────────────────
  // Physical goods return only — never touches Payment/Invoice/Order (see
  // schema comment on DeliveryChallanReturn). Sections 22-31 of the dispatch
  // spec: original dispatched quantity is never edited; each return is its
  // own row, and cumulative returns can never exceed what was dispatched.

  static async getDeliveryChallanReturns(filters: { challanId?: string } = {}) {
    return prisma.deliveryChallanReturn.findMany({
      where: filters.challanId ? { challanId: filters.challanId } : undefined,
      include: { items: true, challan: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createDeliveryChallanReturn(data: {
    challanId: string;
    reason: string;
    otherReason?: string;
    items: Array<{ challanItemId: string; quantity: number }>;
    idempotencyKey?: string;
  }, userId: string = 'system') {
    if (data.idempotencyKey) {
      const existing = await prisma.deliveryChallanReturn.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { items: true } });
      if (existing) return existing;
    }
    if (!data.items.length) throw new Error('Select at least one item to return.');

    try {
      // Phase 3A concurrency fix: the read (challan status + previouslyReturned)
      // -> validate -> create sequence now all happens INSIDE one transaction,
      // behind a row lock on the parent DeliveryChallan
      // (_lockDeliveryChallanForReturn). Previously only the final `create`
      // was transactional — two concurrent calls could both read the same
      // previouslyReturned snapshot before either committed, both pass
      // validation, and together exceed the dispatched quantity.
      return await prisma.$transaction(async (tx) => {
        await SalesService._lockDeliveryChallanForReturn(tx, data.challanId);

        const challan = await tx.deliveryChallan.findUnique({ where: { id: data.challanId }, include: { items: true } });
        if (!challan) throw new Error('Delivery challan not found.');
        const status = challan.status === 'OPEN' ? 'IN_TRANSIT' : challan.status;
        if (status !== 'IN_TRANSIT' && status !== 'CLOSED') {
          throw new Error(`Cannot return goods from a challan that hasn't dispatched yet (current status: ${status}).`);
        }

        // Returnable = dispatched - sum of all previously returned qty for
        // that exact challan line (across every prior return, PENDING or
        // RECEIVED — a return already claims the qty the moment it's
        // raised). Now read under the DeliveryChallan row lock above.
        const priorReturnItems = await tx.deliveryChallanReturnItem.findMany({
          where: { challanItemId: { in: data.items.map(i => i.challanItemId) } }
        });
        const previouslyReturned: Record<string, number> = {};
        for (const ri of priorReturnItems) {
          previouslyReturned[ri.challanItemId] = (previouslyReturned[ri.challanItemId] || 0) + ri.quantity;
        }

        // Phase 3A: FIFO cost-reversal provenance scope — the exact same
        // sourceId convention dispatchChallanStock used when it wrote the
        // original outbound StockMovement rows this replays (see
        // dispatchChallanStock: RAW challan.sourceFranchiseId, or HQ's raw
        // id if null — never run through toInventoryScopeId).
        const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;

        const itemsToCreate: Array<{
          challanItemId: string; productId: string | null; productName: string; quantity: number; unit: string;
          costAllocation: any; costReversal: number | null; costProvenance: string;
        }> = [];
        for (const reqItem of data.items) {
          const dcItem = challan.items.find(i => i.id === reqItem.challanItemId);
          if (!dcItem) throw new Error('Return line does not match any item on this delivery challan.');
          const already = previouslyReturned[dcItem.id] || 0;
          const returnable = dcItem.quantity - already;
          if (reqItem.quantity <= 0) throw new Error(`Return quantity for "${dcItem.productName}" must be greater than zero.`);
          if (reqItem.quantity > returnable + 0.001) {
            throw new Error(`Cannot return ${reqItem.quantity} of "${dcItem.productName}" — Dispatched ${dcItem.quantity}, already returned ${already}, returnable ${returnable}.`);
          }

          // Phase 3A: compute the FIFO cost-reversal allocation exactly ONCE,
          // here, at the point that actually claims the quantity (mirrors
          // createReturnOrder's Phase 3 pattern — see that method's own
          // comment) — never recomputed at receive time. Computing it here,
          // under the same DeliveryChallan row lock used for the quantity
          // validation above, also means the FIFO layer skip-count can never
          // race the way it would if deferred to receive time (a separate,
          // later transaction with no lock over sibling returns on this same
          // line). Only dcItem.productId/reqItem.quantity (already validated
          // above) feed in — this endpoint doesn't even accept a client cost
          // field, so nothing forged can reach costAllocation/costReversal.
          let costAllocation: any = null;
          let costReversal: number | null = null;
          let costProvenance: string = 'PROVENANCE_UNAVAILABLE';
          if (sourceId && dcItem.productId) {
            const product = await tx.product.findUnique({ where: { id: dcItem.productId } });
            if (product?.sku) {
              const sourceItem = await tx.inventoryItem.findFirst({ where: { franchiseId: sourceId, sku: product.sku } });
              if (sourceItem) {
                const result = await SalesService._computeReturnFifoAllocation(tx, {
                  itemId: sourceItem.id,
                  refs: [{ referenceType: 'DELIVERY_CHALLAN', referenceId: challan.id }],
                  alreadyReturnedQty: already,
                  returnQty: reqItem.quantity,
                });
                costProvenance = result.provenance;
                costAllocation = result.allocation;
                costReversal = result.costReversal;
              }
            }
          }

          itemsToCreate.push({
            challanItemId: dcItem.id, productId: dcItem.productId, productName: dcItem.productName,
            quantity: reqItem.quantity, unit: dcItem.unit,
            costAllocation, costReversal, costProvenance
          });
        }

        const returnNumber = await nextDocumentNumber(tx, 'DCR', 'DCR');
        return tx.deliveryChallanReturn.create({
          data: {
            returnNumber,
            challanId: data.challanId,
            reason: data.reason,
            otherReason: data.otherReason || null,
            status: 'PENDING',
            createdBy: userId,
            idempotencyKey: data.idempotencyKey || undefined,
            items: { create: itemsToCreate }
          },
          include: { items: true }
        });
      }, { timeout: 20000 });
    } catch (err: any) {
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.deliveryChallanReturn.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { items: true } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // Warehouse receipt + condition check (sections 26-28). GOOD goes back
  // into real available stock via the normal stockIn path; DAMAGED/EXPIRED/
  // REJECTED/QUARANTINE get a zero-effect ledger row for traceability only
  // (see RETURN_QUARANTINE_IN on StockMovementType) — deliberately never
  // calls stockIn for those, so available stock is never silently inflated
  // by unusable goods.
  static async receiveDeliveryChallanReturn(returnId: string, itemConditions: Array<{ returnItemId: string; condition: 'GOOD' | 'DAMAGED' | 'EXPIRED' | 'REJECTED' | 'QUARANTINE' }>, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      // Phase 3A concurrency fix: lock this DeliveryChallanReturn row BEFORE
      // the idempotency status check below. Without this, two concurrent
      // (or duplicate/retried) receive calls for the SAME return could both
      // observe status still PENDING before either commits its own `status:
      // 'RECEIVED'` update, and both loop over itemConditions restoring
      // stock — double-applying the restock/cost-reversal.
      await tx.$queryRaw`SELECT id FROM "DeliveryChallanReturn" WHERE id = ${returnId} FOR UPDATE`;

      const ret = await tx.deliveryChallanReturn.findUnique({ where: { id: returnId }, include: { items: true, challan: true } });
      if (!ret) throw new Error('Return not found.');
      if (ret.status === 'RECEIVED') return tx.deliveryChallanReturn.findUnique({ where: { id: returnId }, include: { items: true } }); // idempotent no-op

      const sourceId = ret.challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;

      for (const cond of itemConditions) {
        const item = ret.items.find(i => i.id === cond.returnItemId);
        if (!item) continue;
        await tx.deliveryChallanReturnItem.update({ where: { id: item.id }, data: { condition: cond.condition } });
        if (!item.productId || !sourceId) continue;

        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (!product || !product.sku) continue;
        const sourceItem = await tx.inventoryItem.findFirst({ where: { franchiseId: sourceId, sku: product.sku } });
        if (!sourceItem) continue;

        // Recall override: same rule as restoreStockForReturnOrder — a
        // return that traces back to a recalled ProductBatch must never
        // become normal saleable stock, regardless of the condition
        // selected (including "GOOD"). The DC's own dispatch StockMovement
        // rows are tagged referenceType 'DELIVERY_CHALLAN' / referenceId =
        // challan id, so that's what this looks up against.
        const { RecallService } = require('../production/recall.service');
        const recallHit = await RecallService.findRecallForSoldItem(tx, {
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: ret.challan.id,
          inventoryItemId: sourceItem.id,
        });
        if (recallHit) {
          await RecallService.recordRecallAffectedReturn(tx, {
            recallId: recallHit.recallId,
            productBatchId: recallHit.productBatchId,
            allRecalledProductBatchIds: recallHit.allRecalledProductBatchIds,
            inventoryItemId: sourceItem.id,
            quantity: item.quantity,
            userId,
            source: 'DELIVERY_CHALLAN_RETURN',
            sourceId: ret.id,
            note: `DC Return ${ret.returnNumber} (DC ${ret.challan.challanNumber}): ${item.quantity} ${item.productName} traced to a recalled batch — quarantined regardless of submitted condition ("${cond.condition}")`,
          });
          await tx.deliveryChallanReturnItem.update({ where: { id: item.id }, data: { recallId: recallHit.recallId, condition: 'QUARANTINE' } });
          continue;
        }

        if (cond.condition === 'GOOD') {
          // Phase 3A: restore at the ORIGINAL FIFO layer cost persisted on
          // this item at createDeliveryChallanReturn time (item.costAllocation
          // / item.costProvenance / item.costReversal) — never recomputed
          // here, and never the item's CURRENT costPrice. Exactly mirrors
          // restoreStockForReturnOrder's Case A/B, reusing the same shared
          // helper (InventoryService.restoreToBatches) so returned quantity
          // credits back into the SAME original InventoryBatch row(s) by id
          // when they still exist. Replaces the old PURCHASE_IN-at-current-
          // cost mislabeling for this one restock path.
          const hasFifoAllocation = (item.costProvenance === 'EXACT' || item.costProvenance === 'RECONSTRUCTED')
            && Array.isArray(item.costAllocation) && (item.costAllocation as any[]).length > 0;

          if (hasFifoAllocation) {
            await InventoryService.restoreToBatches(tx, {
              itemId: sourceItem.id,
              allocation: item.costAllocation as any,
              movementType: 'SALES_RETURN_IN',
              referenceType: 'DELIVERY_CHALLAN_RETURN',
              referenceId: ret.id,
              note: `Received GOOD condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber}) — FIFO cost restored: ₹${item.costReversal ?? 0}, provenance ${item.costProvenance}`,
              userId,
            });
          } else {
            // PROVENANCE_UNAVAILABLE fallback (e.g. historical/legacy DC
            // dispatch with no matching outbound StockMovement, or one with
            // neither batchId nor consumptionBreakdown nor unitCost) — no
            // historical layer cost to restore into. Same pre-existing
            // behavior (new batch/plain stockIn at current cost), just
            // relabeled SALES_RETURN_IN instead of PURCHASE_IN so it's never
            // confused with a real purchase, and never fabricates a cost.
            const sourceProductBatchId = await RecallService.resolveSingleSourceProductBatchId(tx, {
              referenceType: 'DELIVERY_CHALLAN',
              referenceId: ret.challan.id,
              inventoryItemId: sourceItem.id,
            });
            if (sourceProductBatchId) {
              await InventoryService.recordMovement(tx, {
                itemId: sourceItem.id,
                type: 'SALES_RETURN_IN',
                quantity: item.quantity,
                referenceType: 'DELIVERY_CHALLAN_RETURN',
                referenceId: ret.id,
                note: `Received GOOD condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber}) — cost provenance unavailable, restored at current cost`,
                userId,
                receiveAtCost: {
                  unitCost: sourceItem.costPrice || 0,
                  batchNumber: `${sourceItem.sku || sourceItem.name}-RETURN`,
                  productBatchId: sourceProductBatchId,
                },
              });
            } else {
              await InventoryService.stockIn({
                itemId: sourceItem.id,
                quantity: item.quantity,
                type: 'SALES_RETURN_IN',
                referenceType: 'DELIVERY_CHALLAN_RETURN',
                referenceId: ret.id,
                note: `Received GOOD condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber}) — cost provenance unavailable, restored at current cost`,
                userId
              }, tx as any);
            }
          }
        } else {
          // Traceable, zero-effect-on-available-stock ledger entry — see
          // the RETURN_QUARANTINE_IN comment on the enum.
          await tx.stockMovement.create({
            data: {
              itemId: sourceItem.id,
              movementType: 'RETURN_QUARANTINE_IN',
              quantity: item.quantity,
              baseQty: 0,
              referenceType: 'DELIVERY_CHALLAN_RETURN',
              referenceId: ret.id,
              note: `Received ${cond.condition} condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber}) — not added to available stock`,
              createdBy: userId,
            }
          });
        }
      }

      return tx.deliveryChallanReturn.update({ where: { id: returnId }, data: { status: 'RECEIVED' }, include: { items: true } });
    }, { timeout: 20000 });
  }

  static async convertDeliveryChallanToSale(challanId: string, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      // ATOMIC CLAIM: Only one transaction can successfully change the status from CLOSED to CONVERTED.
      // This provides PostgreSQL MVCC row-locking to guarantee no duplicate conversions occur.
      const claimResult = await tx.deliveryChallan.updateMany({
        where: { id: challanId, status: 'CLOSED' },
        data: { status: 'CONVERTED' }
      });

      if (claimResult.count === 0) {
        throw new Error('Challan is not CLOSED or has already been converted.');
      }

      const challan = await tx.deliveryChallan.findUnique({
        where: { id: challanId },
        include: { items: true, returns: { include: { items: true } } }
      });
      if (!challan) throw new Error('Delivery challan not found');

      const allProducts = await tx.product.findMany({ select: { id: true, name: true, sku: true } });
      const fallbackProduct = allProducts.find(p => p.name.toLowerCase() === 'general item') || allProducts[0];

      let totalNetQty = 0;
      const orderItemsData: any[] = [];
      const itemsToCalculate: any[] = [];

      for (const item of challan.items) {
        let returnedQty = 0;
        for (const ret of challan.returns) {
          const retItem = ret.items.find(ri => ri.challanItemId === item.id);
          if (retItem) {
            returnedQty += retItem.quantity;
          }
        }
        
        const netQty = item.quantity - returnedQty;
        if (netQty < 0) throw new Error(`Net quantity for item ${item.productName} is less than zero.`);

        if (netQty > 0) {
          totalNetQty += netQty;
          itemsToCalculate.push({
            originalItem: item,
            quantity: netQty,
            rate: item.rate,
            taxPercent: item.taxPercent || 0,
            discountPct: 0
          });
        }
      }

      if (totalNetQty === 0) {
        throw new Error('Cannot convert to sale: net saleable quantity of all items is 0 due to full return.');
      }

      const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(itemsToCalculate);

      for (const compItem of computed) {
        const item = (compItem as any).originalItem;

        let validProductId = item.productId || '';
        // Id/SKU only — a name-based match (or "grab any product") is a
        // variant-cross-contamination risk (e.g. APPAM 450g silently
        // resolving to APPAM 900g); erroring is safer than guessing.
        const productMatch = allProducts.find(p => p.id === validProductId || (p.sku && p.sku === item.productId));

        if (productMatch) {
          validProductId = productMatch.id;
        } else if (item.productId) {
          const invItem = await tx.inventoryItem.findUnique({ where: { id: item.productId } });
          const matchedBySku = invItem?.sku ? allProducts.find(p => p.sku === invItem.sku) : undefined;
          if (matchedBySku) {
            validProductId = matchedBySku.id;
          } else {
            throw new Error(`Cannot convert: line item "${item.productName}" references productId "${item.productId}", which does not match any known Product or InventoryItem SKU.`);
          }
        }

        if (!validProductId) {
          // No productId was ever provided — a genuine free-text/custom
          // line — reuse the existing "General Item" product if one
          // exists, otherwise create a dedicated one for this line.
          if (fallbackProduct) {
            validProductId = fallbackProduct.id;
          } else {
            const newProd = await tx.product.create({
              data: {
                name: item.productName || 'General Item',
                basePrice: item.rate,
                taxPercent: item.taxPercent || 0,
              }
            });
            validProductId = newProd.id;
            allProducts.push({ id: newProd.id, name: newProd.name, sku: null }); // update cache for loop
          }
        }

        orderItemsData.push({
          productId: validProductId,
          quantity: compItem.quantity,
          unit: item.unit || 'NONE',
          price: item.rate,
          discountPct: 0,
          taxAmount: compItem.taxAmount,
          totalAmount: compItem.totalAmount,
        });
      }

      const invoiceNum = await nextDocumentNumber(tx, 'INV', 'INV');
      const sellerFranchiseId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull(tx))?.id;
      const scopeFranchiseId = sellerFranchiseId ? await FranchiseService.toInventoryScopeId(tx, sellerFranchiseId) : null;
      const hq = await FranchiseService.getHqFranchiseOrNull(tx);
      const isHqSeller = !scopeFranchiseId || (hq && hq.id === scopeFranchiseId);
      const sellerInventoryScope = isHqSeller
        ? { OR: [{ franchiseId: null }, ...(hq ? [{ franchiseId: hq.id }] : [])] }
        : { franchiseId: scopeFranchiseId };

      // Real-time stock validation for all net converted items before invoice creation
      const itemsToDeduct: Array<{
        inventoryItem: any;
        requiredBaseQty: number;
        orderItemQty: number;
        unitId?: string;
        product: any;
      }> = [];

      for (const itemData of orderItemsData) {
        if (!itemData.productId) continue;
        const prod = allProducts.find(p => p.id === itemData.productId);
        let invItem: any = null;
        if (prod?.sku) {
          invItem = await tx.inventoryItem.findFirst({
            where: {
              sku: prod.sku,
              ...sellerInventoryScope
            },
            include: { baseUnit: true }
          });
        }

        const baseCurrentStock = invItem?.currentStock ?? 0;
        let reservedQty = 0;
        let blockedQty = 0;

        if (invItem) {
          // Deduct active franchise order reservations
          const activeReservationSum = await tx.inventoryReservationAllocation.aggregate({
            where: {
              inventoryItemId: invItem.id,
              reservation: { status: 'ACTIVE' }
            },
            _sum: {
              reservedQty: true,
              consumedQty: true,
              releasedQty: true
            }
          });
          reservedQty = Math.max(0,
            (activeReservationSum._sum.reservedQty || 0) -
            (activeReservationSum._sum.consumedQty || 0) -
            (activeReservationSum._sum.releasedQty || 0)
          );

          // Deduct non-sellable (blocked, returned, rejected, hold, expired) batch stock
          const quarantinedBatchSum = await tx.inventoryBatch.aggregate({
            where: {
              inventoryItemId: invItem.id,
              currentQty: { gt: 0 },
              status: { in: ['BLOCKED', 'RETURNED', 'REJECTED', 'QC_HOLD', 'EXPIRED'] }
            },
            _sum: { currentQty: true }
          });
          blockedQty = quarantinedBatchSum._sum.currentQty || 0;
        }

        const availableStock = Math.max(0, baseCurrentStock - reservedQty - blockedQty);
        let conversionResult = { requiredBaseQty: itemData.quantity, unitId: undefined };
        let unitLabel = itemData.unit || 'Units';

        if (invItem) {
          conversionResult = await InventoryService.convertUnitToBase(invItem.id, itemData.unit || 'NONE', itemData.quantity, tx);
          unitLabel = (invItem.baseUnit as any)?.shortName || (invItem.baseUnit as any)?.name || invItem.unit || 'Units';
        }

        if (availableStock < conversionResult.requiredBaseQty) {
          const prodName = prod?.name || 'Item';
          const prodSku = prod?.sku || invItem?.sku || 'N/A';
          throw new Error(
            `Insufficient stock for "${prodName}" (SKU: ${prodSku}). Available: ${availableStock} ${unitLabel}, Required: ${conversionResult.requiredBaseQty} ${unitLabel}. Sale conversion blocked.`
          );
        }

        if (invItem) {
          itemsToDeduct.push({
            inventoryItem: invItem,
            requiredBaseQty: conversionResult.requiredBaseQty,
            orderItemQty: itemData.quantity,
            unitId: conversionResult.unitId,
            product: prod || { name: invItem.name, sku: invItem.sku }
          });
        }
      }

      const order = await tx.order.create({
        data: {
          invoiceNum,
          partyType: challan.dealerId ? 'DEALER' : 'CUSTOMER',
          partyId: challan.dealerId || challan.customerId,
          customerId: challan.customerId,
          franchiseId: sellerFranchiseId,
          orderType: 'DINE_IN',
          status: 'COMPLETED',
          subTotal,
          taxAmount,
          discountAmount: 0,
          totalAmount,
          paymentStatus: 'UNPAID',
          paymentType: 'CASH',
          stateOfSupply: challan.stateOfSupply,
          inventory_deducted: true,
          orderItems: {
            create: orderItemsData
          }
        },
        include: { orderItems: true }
      });

      const invoice = await tx.invoice.create({
        data: {
          orderId: order.id,
          totalAmount: subTotal,
          taxAmount,
          finalAmount: totalAmount,
          status: 'PENDING',
          termsAndConditions: challan.termsConditions,
          notes: challan.notes
        }
      });

      // Deduct inventory once for the completed sale
      for (const ded of itemsToDeduct) {
        await InventoryService.recordMovement(tx, {
          itemId: ded.inventoryItem.id,
          type: 'SALES_OUT',
          quantity: -ded.orderItemQty,
          baseQty: -ded.requiredBaseQty,
          transactionUnit: ded.unitId,
          referenceType: 'ORDER',
          referenceId: order.id,
          note: `Sale auto-deduction for Invoice ${invoiceNum} (Product: ${ded.product.name})`
        });
      }

      const updatedChallan = await tx.deliveryChallan.update({
        where: { id: challanId },
        data: {
          convertedOrderId: order.id,
          convertedInvoiceId: invoice.id
        }
      });

      return {
        success: true,
        challan: updatedChallan,
        sale: order,
        invoice
      };
    }, { timeout: 20000 });
  }

  // --- Helper Stock Movement methods for DC ---

  private static async dispatchChallanStock(challan: any, userId: string, tx: any = prisma) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to dispatch from
    for (const item of challan.items) {
      if (!item.productId) continue;

      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      const hq = await FranchiseService.getHqFranchiseOrNull();
      const isHqSource = !sourceId || (hq && hq.id === sourceId);
      const sourceItem = await tx.inventoryItem.findFirst({
        where: {
          sku: product.sku,
          ...(isHqSource ? { OR: [{ franchiseId: sourceId }, { franchiseId: null }] } : { franchiseId: sourceId })
        }
      });

      if (sourceItem) {
        await InventoryService.stockOut({
          itemId: sourceItem.id,
          quantity: item.quantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: challan.id,
          note: `Dispatched DC ${challan.challanNumber}`,
          userId,
        }, tx as any);
      }
    }
  }

  private static async receiveChallanStock(challan: any, userId: string, tx: any = prisma) {
    if (!challan.franchiseId) return; // if sent to customer/dealer directly, no receipt stock to handle (see section 21)

    for (const item of challan.items) {
      if (!item.productId) continue;
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      let targetItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: challan.franchiseId, sku: product.sku }
      });

      if (!targetItem) {
        targetItem = await tx.inventoryItem.create({
          data: {
            franchiseId: challan.franchiseId,
            sku: product.sku,
            name: product.name,
            unit: item.unit || 'NONE',
            category: 'FINISHED_GOOD',
            currentStock: 0,
            minimumStock: 0
          }
        });
      }

      await InventoryService.stockIn({
        itemId: targetItem.id,
        quantity: item.quantity,
        referenceType: 'DELIVERY_CHALLAN',
        referenceId: challan.id,
        note: `Received DC ${challan.challanNumber}`,
        userId
      }, tx as any);
    }
  }

  private static async reverseChallanStock(challan: any, userId: string, tx: any = prisma) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to reverse against
    for (const item of challan.items) {
      if (!item.productId) continue;

      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      const sourceItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: sourceId, sku: product.sku }
      });

      if (sourceItem) {
        await InventoryService.stockIn({
          itemId: sourceItem.id,
          quantity: item.quantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: challan.id,
          note: `Reversed DC ${challan.challanNumber}`,
          userId
        }, tx as any);
      }
    }
  }
}
