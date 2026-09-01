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

    let discPct = (item.discountPercent !== undefined && item.discountPercent > 0)
      ? item.discountPercent
      : ((item.discountPct !== undefined && item.discountPct > 0) ? item.discountPct : 0);

    if (!hasExplicitItemDiscounts && documentDiscountAmount > 0 && totalGross > 0) {
      discAmt = Math.round((documentDiscountAmount * (gross / totalGross)) * 100) / 100;
      discPct = gross > 0 ? Math.round(((discAmt / gross) * 100) * 100) / 100 : 0;
    } else if (!discAmt && discPct > 0) {
      discAmt = Math.round((gross * discPct / 100) * 100) / 100;
    } else if (!discPct && gross > 0 && discAmt > 0) {
      discPct = Math.round(((discAmt / gross) * 100) * 100) / 100;
    }

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
  const grandTotal = Math.round((subTotal + taxAmount) * 100) / 100;

  return { computed, subTotal, taxAmount, totalDiscount, totalAmount: grandTotal };
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
    const { computed, subTotal, taxAmount, totalDiscount, totalAmount } = calculateTotals(data.items, discount);
    const roundOff = data.roundOffAmount || 0;
    const partyType = data.partyType || 'CUSTOMER';
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
        discountAmount: discount || totalDiscount,
        totalAmount: data.totalAmount !== undefined ? data.totalAmount : (totalAmount + roundOff),
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
        const discount = data.discountAmount !== undefined ? data.discountAmount : totalDiscount;
        const roundOff = data.roundOffAmount || 0;

        updateData.subTotal = subTotal;
        updateData.taxAmount = taxAmount;
        updateData.discountAmount = discount;
        updateData.totalAmount = (data as any).totalAmount !== undefined ? (data as any).totalAmount : (totalAmount + roundOff);

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
          const firstFranchise = await tx.franchise.findFirst();
          franchiseId = firstFranchise?.id || '';
        }
        if (!franchiseId) {
          throw new Error('A branch/franchise must be configured to convert an estimate to a Sale/Invoice.');
        }

        const invoiceNum = await nextDocumentNumber(tx, 'INV', 'INV');

        // Resolve a valid Product.id for each OrderItem (FK constraint on OrderItem.productId)
        const allProducts = await tx.product.findMany();
        const fallbackProduct = allProducts[0];
        const orderItemsData: Array<{ productId: string; quantity: number; unit: string; price: number; discountPct: number; taxAmount: number; totalAmount: number }> = [];

        for (const item of quotation.items) {
          let validProductId = item.productId || '';
          const productMatch = allProducts.find(p => p.id === validProductId || (p.sku && p.sku === item.productId) || p.name.toLowerCase() === item.productName?.toLowerCase());
          
          if (productMatch) {
            validProductId = productMatch.id;
          } else if (item.productId) {
            const invItem = await tx.inventoryItem.findUnique({ where: { id: item.productId } });
            if (invItem) {
              const matchedBySkuOrName = allProducts.find(p => (invItem.sku && p.sku === invItem.sku) || p.name.toLowerCase() === invItem.name.toLowerCase());
              if (matchedBySkuOrName) {
                validProductId = matchedBySkuOrName.id;
              }
            }
          }

          if (!validProductId || !allProducts.some(p => p.id === validProductId)) {
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
            }
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
        if (salesOrder.status === 'CLOSED' || salesOrder.status === 'CONVERTED') {
          throw new Error('This Sales Order has already been converted.');
        }

        let franchiseId = payload?.franchiseId;
        if (!franchiseId) {
          const hq = await FranchiseService.getHqFranchiseOrNull();
          franchiseId = hq?.id || '';
        }
        if (!franchiseId) {
          const firstFranchise = await tx.franchise.findFirst();
          franchiseId = firstFranchise?.id || '';
        }

        const invoiceNum = await nextDocumentNumber(tx, 'INV', 'INV');
        const allProducts = await tx.product.findMany();
        const fallbackProduct = allProducts[0];
        const orderItemsData: Array<{ productId: string; quantity: number; unit: string; price: number; discountPct: number; taxAmount: number; totalAmount: number }> = [];

        for (const item of salesOrder.items) {
          let validProductId = item.productId || '';
          const productMatch = allProducts.find(p => p.id === validProductId || (p.sku && p.sku === item.productId) || p.name.toLowerCase() === item.productName?.toLowerCase());
          if (productMatch) {
            validProductId = productMatch.id;
          }
          if (!validProductId || !allProducts.some(p => p.id === validProductId)) {
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
            }
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
          data: { status: 'CLOSED' },
        });

        return {
          success: true,
          salesOrder: {
            id: salesOrder.id,
            orderNo: salesOrder.orderNo,
            status: 'CLOSED'
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
            existingProduct = await tx.product.create({
              data: {
                id: invItem.id, // Keep exact same ID so the FK succeeds
                name: invItem.name,
                sku: invItem.sku,
                basePrice: invItem.customerPrice || invItem.basePrice || 0,
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
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items, discount);
    const partyType = data.partyType || 'CUSTOMER';
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
        discountAmount: discount,
        totalAmount: totalAmount - discount,
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
          discountAmount: discount,
          totalAmount: totalAmount - discount,
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
    let soMap = new Map<string, string>();
    if (soIds.length > 0) {
      const salesOrders = await prisma.salesOrder.findMany({
        where: { id: { in: soIds } },
        select: { id: true, orderNumber: true }
      });
      soMap = new Map(salesOrders.map(so => [so.id, so.orderNumber]));
    }

    return results.map((r: any) => ({
      ...r,
      sourceSalesOrderNumber: r.sourceSalesOrderId ? soMap.get(r.sourceSalesOrderId) : undefined
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
    return prisma.salesOrder.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
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
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items, discount);

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
        discountAmount: discount,
        totalAmount: totalAmount - discount,
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
    const { proformaInvoiceId, items, ...safeData } = data;

    const updateData: any = {
      ...safeData,
      status: data.status as any,
      deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined,
      // orderDate is set once at creation (direct-create or conversion)
      // and isn't meant to move afterward — only convert it through if a
      // caller explicitly sends one; dueDate stays freely editable.
      orderDate: data.orderDate ? new Date(data.orderDate) : undefined,
      dueDate: data.dueDate ? new Date(data.dueDate) : undefined
    };

    return prisma.$transaction(async (tx) => {
      if (items) {
        const discount = data.discountAmount || 0;
        const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(items as any[], discount);

        updateData.subTotal = subTotal;
        updateData.taxAmount = taxAmount;
        updateData.discountAmount = discount;
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

  static async getReturnOrders(filters: { status?: string; customerId?: string; franchiseId?: string; source?: 'FRANCHISE' | 'BUSINESS' | 'POS'; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.franchiseId) where.franchiseId = filters.franchiseId;

    if (filters.source === 'FRANCHISE') {
      where.franchiseId = { not: null };
    } else if (filters.source === 'BUSINESS') {
      where.customerId = { not: null };
    } else if (filters.source === 'POS') {
      where.posOrderId = { not: null };
    }

    if (filters.search) {
      where.OR = [
        { returnNumber: { contains: filters.search, mode: 'insensitive' } },
        { reason: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.returnOrder.findMany({
      where,
      include: { customer: true, salesOrder: true, franchise: true, franchiseOrder: true, posOrder: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createReturnOrder(data: {
    salesOrderId?: string;
    franchiseOrderId?: string;
    posOrderId?: string;
    customerId?: string;
    franchiseId?: string;
    reason: string;
    items: Array<{ productId?: string; productName: string; quantity: number; rate: number; condition?: string }>;
    refundMethod?: string;
    idempotencyKey?: string;
  }) {
    // Idempotency: a retry/double-click/API re-entry carrying the same key
    // must return the already-created return instead of posting a second
    // one — mirrors FinanceService.createPayment's idempotencyKey handling.
    if (data.idempotencyKey) {
      const existing = await prisma.returnOrder.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
        include: { customer: true, franchise: true, salesOrder: true, franchiseOrder: true, posOrder: true, items: true }
      });
      if (existing) return existing;
    }

    const refundAmount = data.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);

    try {
      return await prisma.returnOrder.create({
        data: {
          returnNumber: await generateReturnNumber(),
          salesOrderId: data.salesOrderId,
          franchiseOrderId: data.franchiseOrderId,
          posOrderId: data.posOrderId,
          customerId: data.customerId,
          franchiseId: data.franchiseId,
          reason: data.reason,
          refundAmount,
          refundMethod: data.refundMethod,
          idempotencyKey: data.idempotencyKey || undefined,
          items: {
            create: data.items.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              rate: item.rate,
              totalAmount: item.quantity * item.rate,
              condition: item.condition
            }))
          }
        },
        include: { customer: true, franchise: true, salesOrder: true, franchiseOrder: true, posOrder: true, items: true }
      });
    } catch (err: any) {
      // True concurrent race: two requests both passed the check above
      // before either committed, and the loser hit the idempotencyKey
      // unique constraint. Return the winner's row rather than failing a
      // legitimate retry.
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.returnOrder.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { customer: true, franchise: true, salesOrder: true, franchiseOrder: true, posOrder: true, items: true }
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  static async updateReturnOrder(id: string, data: { status?: string; approvedBy?: string }) {
    const updateData: any = {
      status: data.status as any,
      approvedBy: data.approvedBy,
      approvedAt: data.status === 'APPROVED' ? new Date() : undefined
    };

    // Backfill the GST breakdown only on approval — a PENDING return isn't
    // yet an "applicable" credit note and must not feed any GST report
    // (see the ReturnOrder schema comment). Approximated (not ledger-grade)
    // since ReturnItem carries no per-line tax of its own: taxableValue is
    // the refund total, gstRate is a quantity-weighted average of the
    // returned products' own rates, and the CGST/SGST vs IGST split reuses
    // the same canonical util and buyer/seller states as every other report.
    if (data.status === 'APPROVED') {
      const { splitGstAmount, resolveSellerState } = require('../../utils/gst-tax.util');
      const ret = await prisma.returnOrder.findUnique({
        where: { id },
        include: {
          items: true,
          posOrder: { select: { stateOfSupply: true, franchiseId: true } },
          salesOrder: { select: { stateOfSupply: true } }
        }
      });

      if (ret) {
        const buyerState = ret.posOrder?.stateOfSupply || ret.salesOrder?.stateOfSupply || null;
        const franchiseId = ret.franchiseId || ret.posOrder?.franchiseId || null;
        const sellerState = await resolveSellerState(franchiseId);

        const productIds = ret.items.map((i) => i.productId).filter(Boolean) as string[];
        const products = productIds.length
          ? await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, taxPercent: true } })
          : [];
        const rateMap = new Map(products.map((p) => [p.id, p.taxPercent]));

        const taxableValue = ret.refundAmount || 0;
        let weightedRateSum = 0;
        let weightTotal = 0;
        for (const item of ret.items) {
          const rate = item.productId && rateMap.has(item.productId) ? (rateMap.get(item.productId) as number) : 5;
          const lineValue = item.totalAmount || item.quantity * item.rate;
          weightedRateSum += rate * lineValue;
          weightTotal += lineValue;
        }
        const gstRate = weightTotal > 0 ? Number((weightedRateSum / weightTotal).toFixed(2)) : 0;
        const taxAmount = Number(((taxableValue * gstRate) / 100).toFixed(2));
        const split = splitGstAmount(taxAmount, buyerState, sellerState);

        updateData.taxableValue = taxableValue;
        updateData.gstRate = gstRate;
        updateData.cgst = split.cgst;
        updateData.sgst = split.sgst;
        updateData.igst = split.igst;
        updateData.taxAmount = taxAmount;
      }
    }

    return prisma.returnOrder.update({ where: { id }, data: updateData });
  }

  static async recordRefund(returnId: string, data: { accountId: string; method: string; createdBy?: string }) {
    const { FinanceService } = require('../finance/finance.service');

    return prisma.$transaction(async (tx) => {
      const ret = await tx.returnOrder.findUnique({ where: { id: returnId } });
      if (!ret) throw new Error('Return Order not found');
      if (ret.status !== 'APPROVED') throw new Error('Only approved returns can be refunded');

      const entity = ret.customerId ? 'Customer Refund' : (ret.franchiseId ? 'Franchise Refund' : 'Sales Refund');

      const payment = await FinanceService.createPayment({
        tx,
        amount: ret.refundAmount,
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: data.accountId,
        method: data.method,
        sourceModule: 'POS',
        linkedDocType: 'DIRECT',
        linkedDocId: ret.id,
        entity,
        createdBy: data.createdBy
      });

      await tx.returnOrder.update({
        where: { id: returnId },
        data: { status: 'COMPLETED' }
      });

      return payment;
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

  static async getDeliveryChallans(filters: { customerId?: string; status?: string; search?: string }) {
    // One-time safe migration: legacy rows stored status 'OPEN' before the IN_TRANSIT rename
    await prisma.deliveryChallan.updateMany({ where: { status: 'OPEN' }, data: { status: 'IN_TRANSIT' } });

    const where: any = {};
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { challanNumber: { contains: filters.search, mode: 'insensitive' } },
        { vehicleNo: { contains: filters.search, mode: 'insensitive' } }
      ];
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
    if (data.dealerId) {
      const dealer = await prisma.dealer.findUnique({ where: { id: data.dealerId } });
      if (!dealer) throw new Error('Selected dealer not found.');
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

    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(
      data.items.map((i) => ({ ...i, rate: i.rate || 0, taxPercent: i.taxPercent || 0 }))
    );

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

        if (newChallan.status === 'IN_TRANSIT') {
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

      // Block moving away from CLOSED once delivered
      if (currentStatus === 'CLOSED' && data.status && data.status !== 'CLOSED') {
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
      if (currentStatus === 'DRAFT' && updated.status === 'IN_TRANSIT') {
        await SalesService.dispatchChallanStock(updated, userId, tx);
      } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CLOSED') {
        await SalesService.receiveChallanStock(updated, userId, tx);
      } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CANCELLED') {
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

      await SalesService.receiveChallanStock(updated, userId, tx);
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

    const challan = await prisma.deliveryChallan.findUnique({ where: { id: data.challanId }, include: { items: true } });
    if (!challan) throw new Error('Delivery challan not found.');
    const status = challan.status === 'OPEN' ? 'IN_TRANSIT' : challan.status;
    if (status !== 'IN_TRANSIT' && status !== 'CLOSED') {
      throw new Error(`Cannot return goods from a challan that hasn't dispatched yet (current status: ${status}).`);
    }
    if (!data.items.length) throw new Error('Select at least one item to return.');

    // Returnable = dispatched - sum of all previously returned qty for that
    // exact challan line (across every prior return, PENDING or RECEIVED —
    // a return already claims the qty the moment it's raised).
    const priorReturnItems = await prisma.deliveryChallanReturnItem.findMany({
      where: { challanItemId: { in: data.items.map(i => i.challanItemId) } }
    });
    const previouslyReturned: Record<string, number> = {};
    for (const ri of priorReturnItems) {
      previouslyReturned[ri.challanItemId] = (previouslyReturned[ri.challanItemId] || 0) + ri.quantity;
    }

    const itemsToCreate: Array<{ challanItemId: string; productId: string | null; productName: string; quantity: number; unit: string }> = [];
    for (const reqItem of data.items) {
      const dcItem = challan.items.find(i => i.id === reqItem.challanItemId);
      if (!dcItem) throw new Error('Return line does not match any item on this delivery challan.');
      const already = previouslyReturned[dcItem.id] || 0;
      const returnable = dcItem.quantity - already;
      if (reqItem.quantity <= 0) throw new Error(`Return quantity for "${dcItem.productName}" must be greater than zero.`);
      if (reqItem.quantity > returnable + 0.001) {
        throw new Error(`Cannot return ${reqItem.quantity} of "${dcItem.productName}" — Dispatched ${dcItem.quantity}, already returned ${already}, returnable ${returnable}.`);
      }
      itemsToCreate.push({ challanItemId: dcItem.id, productId: dcItem.productId, productName: dcItem.productName, quantity: reqItem.quantity, unit: dcItem.unit });
    }

    try {
      return await prisma.$transaction(async (tx) => {
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
      });
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

        if (cond.condition === 'GOOD') {
          await InventoryService.stockIn({
            itemId: sourceItem.id,
            quantity: item.quantity,
            referenceType: 'DELIVERY_CHALLAN_RETURN',
            referenceId: ret.id,
            note: `Received GOOD condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber})`,
            userId
          }, tx as any);
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

  // --- Helper Stock Movement methods for DC ---

  private static async dispatchChallanStock(challan: any, userId: string, tx: any = prisma) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to dispatch from
    for (const item of challan.items) {
      if (!item.productId) continue;

      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      const sourceItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: sourceId, sku: product.sku }
      });

      if (sourceItem) {
        await InventoryService.stockOut({
          itemId: sourceItem.id,
          quantity: item.quantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: challan.id,
          note: `Dispatched DC ${challan.challanNumber}`,
          userId,
          // Backend-enforced availability check (section 12) — without
          // this, FIFO depletion silently under-fulfills past whatever
          // stock actually exists instead of rejecting the dispatch.
          strictFIFO: true,
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
