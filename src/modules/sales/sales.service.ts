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

function calculateTotals<T extends { quantity: number; rate: number; taxPercent?: number }>(items: T[]) {
  let subTotal = 0;
  let taxAmount = 0;
  const computed = items.map((item) => {
    const lineTotal = item.quantity * item.rate;
    const lineTax = (lineTotal * (item.taxPercent || 0)) / 100;
    subTotal += lineTotal;
    taxAmount += lineTax;
    return { ...item, taxAmount: lineTax, totalAmount: lineTotal + lineTax };
  });
  return { computed, subTotal, taxAmount, totalAmount: subTotal + taxAmount };
}

export class SalesService {
  // ─── Quotations ──────────────────────────────────────────────────────────────

  static async getQuotations(filters: { status?: string; customerId?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.search) {
      where.OR = [
        { quotationNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    const quotations = await prisma.quotation.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });

    // Estimate converts to a Sales Order now (convertedOrderId), not
    // straight to a Tax Invoice — convertedInvoiceId only gets set on a
    // Quotation via the old (now-unused) direct path and stays null for
    // every new conversion, so this resolves the Sales Order's number.
    const salesOrderIds = quotations.map(q => q.convertedOrderId).filter(Boolean) as string[];
    const salesOrderMap = salesOrderIds.length
      ? new Map((await prisma.salesOrder.findMany({ where: { id: { in: salesOrderIds } }, select: { id: true, orderNumber: true } })).map(o => [o.id, o.orderNumber]))
      : new Map<string, string>();
    return quotations.map(q => ({
      ...q,
      convertedOrderNumber: q.convertedOrderId ? salesOrderMap.get(q.convertedOrderId) || null : null
    }));
  }

  static async getQuotationById(id: string) {
    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
    if (quotation && quotation.convertedOrderId) {
      const salesOrder = await prisma.salesOrder.findUnique({
        where: { id: quotation.convertedOrderId },
        select: { orderNumber: true }
      });
      return {
        ...quotation,
        convertedOrderNumber: salesOrder?.orderNumber || null
      };
    }
    return quotation ? { ...quotation, convertedOrderNumber: null } : null;
  }

  static async createQuotation(data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    validUntil?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    termsConditions?: string;
    notes?: string;
    createdBy?: string;
    quotationNumber?: string;
    status?: string;
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;
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
        status: (data.status as any) || undefined,
        subTotal,
        taxAmount,
        discountAmount: discount,
        totalAmount: totalAmount - discount,
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
    status?: string;
    notes?: string;
    termsConditions?: string;
    validUntil?: string;
    items?: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    quotationNumber?: string;
    trackingNumber?: string;
    courierName?: string;
  }) {
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
      validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
      quotationNumber: data.quotationNumber,
      trackingNumber: data.trackingNumber,
      courierName: data.courierName
    };

    return prisma.$transaction(async (tx) => {
      if (data.items) {
        const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
        const discount = data.discountAmount || 0;
        
        updateData.subTotal = subTotal;
        updateData.taxAmount = taxAmount;
        updateData.discountAmount = discount;
        updateData.totalAmount = totalAmount - discount;

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
    trackingData?: { trackingNumber?: string; courierName?: string; deliveryDate?: string; deliveryAddress?: string; }
  ) {
    return prisma.$transaction(async (tx) => {
      const quotation = await tx.quotation.findUnique({ where: { id: quotationId }, include: { items: true } });
      if (!quotation) throw new Error('Estimate not found.');
      if (quotation.status !== 'SENT') {
        if (quotation.status === 'CONVERTED' && quotation.convertedOrderId) {
          // Already converted — not an error, the caller (controller) turns
          // this into "return the existing Sales Order" so a duplicate
          // click never creates a second one.
          const existing = await tx.salesOrder.findUnique({ where: { id: quotation.convertedOrderId }, include: { items: true } });
          if (existing) return existing;
        }
        throw new Error(`Only an Estimate with status SENT can be converted to a Sales Order (current status: ${quotation.status}).`);
      }

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

      return salesOrder;
    });
  }

  // Sales Order -> Proforma Invoice.
  static async convertSalesOrderToProforma(salesOrderId: string, createdBy: string) {
    return prisma.$transaction(async (tx) => {
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
          customerId: salesOrder.customerId,
          customerName: salesOrder.customerName,
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
              taxPercent: item.taxPercent,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { items: true },
      });

      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { proformaInvoiceId: proforma.id },
      });

      return proforma;
    });
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

    let franchiseId: string | undefined;
    const hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
    if (hq) franchiseId = hq.id;
    else {
      const first = await prisma.franchise.findFirst({ where: { status: 'ACTIVE' } });
      if (first) franchiseId = first.id;
      else throw new Error('No active franchise found to assign the invoice.');
    }

    return prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          invoiceNum: await nextDocumentNumber(tx, 'INV', 'INV'),
          customerId: proforma.customerId,
          franchiseId: franchiseId!,
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
              productId: item.productId!,
              quantity: item.quantity,
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

      if (sourceSalesOrder) {
        await tx.salesOrder.update({
          where: { id: sourceSalesOrder.id },
          data: { status: 'PROCESSING' },
        });
      }

      return newOrder;
    });
  }

  static async getProformaInvoices(filters: { status?: string; customerId?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.search) {
      where.OR = [
        { proformaNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    return prisma.proformaInvoice.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  static async getProformaInvoiceById(id: string) {
    return prisma.proformaInvoice.findUnique({
      where: { id },
      include: { customer: true, items: true },
    });
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
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    deliveryDate?: string;
    deliveryAddress?: string;
    notes?: string;
    createdBy?: string;
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;

    return prisma.$transaction(async (tx) => tx.salesOrder.create({
      data: {
        orderNumber: await nextDocumentNumber(tx, 'SO', 'SO'),
        customerId: data.customerId,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        subTotal,
        taxAmount,
        discountAmount: discount,
        totalAmount: totalAmount - discount,
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
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { customer: true, items: true }
    }));
  }

  static async updateSalesOrder(id: string, data: any) {
    // proformaInvoiceId is a duplicate-prevention marker only the atomic
    // convertSalesOrderToProforma() transaction is allowed to set — a
    // generic PATCH must never let a client fake "a Proforma already
    // exists" (or clear a real one) directly.
    const { proformaInvoiceId, ...safeData } = data;
    return prisma.salesOrder.update({
      where: { id },
      data: {
        ...safeData,
        status: data.status as any,
        deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined
      },
      include: { items: true }
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
  }) {
    const refundAmount = data.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);

    return prisma.returnOrder.create({
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
      include: { customer: true, franchise: true, posOrder: true, items: true }
    });
  }

  static async updateReturnOrder(id: string, data: { status?: string; approvedBy?: string }) {
    return prisma.returnOrder.update({
      where: { id },
      data: {
        status: data.status as any,
        approvedBy: data.approvedBy,
        approvedAt: data.status === 'APPROVED' ? new Date() : undefined
      }
    });
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
      include: { customer: true, dealer: true, items: true }
    });
  }

  static async createDeliveryChallan(data: {
    customerId?: string;
    dealerId?: string;
    salesOrderId?: string;
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
  }, userId: string = 'system') {
    SalesService.assertSingleDestination(data.customerId, data.dealerId, data.franchiseId);
    if (data.dealerId) {
      const dealer = await prisma.dealer.findUnique({ where: { id: data.dealerId } });
      if (!dealer) throw new Error('Selected dealer not found.');
    }

    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(
      data.items.map((i) => ({ ...i, rate: i.rate || 0, taxPercent: i.taxPercent || 0 }))
    );

    // Generate sequential challan number from DB count
    const count = await prisma.deliveryChallan.count();
    const challanNumber = `DC-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;

    const newChallan = await prisma.deliveryChallan.create({
      data: {
        challanNumber,
        customerId: data.customerId || null,
        dealerId: data.dealerId || null,
        salesOrderId: data.salesOrderId || null,
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
      await SalesService.dispatchChallanStock(newChallan, userId);
    }

    return newChallan;
  }

  static async updateDeliveryChallan(id: string, data: { status?: string; vehicleNo?: string; driverName?: string; notes?: string; customerId?: string | null; dealerId?: string | null; franchiseId?: string | null }, userId: string = 'system') {
    const currentChallan = await prisma.deliveryChallan.findUnique({ where: { id }, include: { items: true } });
    if (!currentChallan) throw new Error('Delivery challan not found');

    // Legacy rows/clients may still send/hold 'OPEN' — treat it as IN_TRANSIT
    const currentStatus = currentChallan.status === 'OPEN' ? 'IN_TRANSIT' : currentChallan.status;
    if (data.status === 'OPEN') data.status = 'IN_TRANSIT';

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
        const dealer = await prisma.dealer.findUnique({ where: { id: data.dealerId } });
        if (!dealer) throw new Error('Selected dealer not found.');
      }
    }

    const updated = await prisma.deliveryChallan.update({ where: { id }, data, include: { customer: true, dealer: true, items: true } });

    // Handle Stock Transitions
    if (currentStatus === 'DRAFT' && updated.status === 'IN_TRANSIT') {
      await SalesService.dispatchChallanStock(updated, userId);
    } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CLOSED') {
      await SalesService.receiveChallanStock(updated, userId);
    } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CANCELLED') {
      await SalesService.reverseChallanStock(updated, userId);
    }

    return updated;
  }

  // --- Helper Stock Movement methods for DC ---
  
  private static async dispatchChallanStock(challan: any, userId: string) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to dispatch from
    for (const item of challan.items) {
      if (!item.productId) continue;
      
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;
      
      const sourceItem = await prisma.inventoryItem.findFirst({
        where: { franchiseId: sourceId, sku: product.sku }
      });
      
      if (sourceItem) {
        await InventoryService.stockOut({
          itemId: sourceItem.id,
          quantity: item.quantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: challan.id,
          note: `Dispatched DC ${challan.challanNumber}`,
          userId
        }, prisma as any);
      }
    }
  }

  private static async receiveChallanStock(challan: any, userId: string) {
    if (!challan.franchiseId) return; // if sent to customer directly, no receipt stock to handle

    for (const item of challan.items) {
      if (!item.productId) continue;
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      let targetItem = await prisma.inventoryItem.findFirst({
        where: { franchiseId: challan.franchiseId, sku: product.sku }
      });

      if (!targetItem) {
        targetItem = await prisma.inventoryItem.create({
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
      }, prisma as any);
    }
  }

  private static async reverseChallanStock(challan: any, userId: string) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to reverse against
    for (const item of challan.items) {
      if (!item.productId) continue;
      
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;
      
      const sourceItem = await prisma.inventoryItem.findFirst({
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
        }, prisma as any);
      }
    }
  }
}
