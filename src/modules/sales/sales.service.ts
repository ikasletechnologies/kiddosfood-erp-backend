import prisma from '../../lib/prisma';

let quotationCounter = 1000;
let salesOrderCounter = 1000;
let returnCounter = 1000;

function generateQuotationNumber() {
  return `QT-${new Date().getFullYear()}-${String(++quotationCounter).padStart(5, '0')}`;
}

function generateSalesOrderNumber() {
  return `SO-${new Date().getFullYear()}-${String(++salesOrderCounter).padStart(5, '0')}`;
}

function generateReturnNumber() {
  return `RMA-${new Date().getFullYear()}-${String(++returnCounter).padStart(5, '0')}`;
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
    return prisma.quotation.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getQuotationById(id: string) {
    return prisma.quotation.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
  }

  static async createQuotation(data: {
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
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;

    return prisma.quotation.create({
      data: {
        quotationNumber: generateQuotationNumber(),
        customerId: data.customerId,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
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
    });
  }

  static async updateQuotation(id: string, data: { status?: string; notes?: string; termsConditions?: string; validUntil?: string }) {
    return prisma.quotation.update({
      where: { id },
      data: {
        ...data,
        status: data.status as any,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined
      },
      include: { items: true }
    });
  }

  static async convertQuotationToOrder(quotationId: string, createdBy?: string) {
    const quotation = await prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { items: true }
    });
    if (!quotation) throw new Error('Quotation not found');

    const salesOrder = await prisma.salesOrder.create({
      data: {
        orderNumber: generateSalesOrderNumber(),
        quotationId,
        customerId: quotation.customerId,
        customerName: quotation.customerName,
        subTotal: quotation.subTotal,
        taxAmount: quotation.taxAmount,
        discountAmount: quotation.discountAmount,
        totalAmount: quotation.totalAmount,
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
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { items: true }
    });

    await prisma.quotation.update({
      where: { id: quotationId },
      data: { status: 'CONVERTED', convertedOrderId: salesOrder.id }
    });

    return salesOrder;
  }

  // ─── Sales Orders ────────────────────────────────────────────────────────────

  static async getSalesOrders(filters: { status?: string; customerId?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
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
    return prisma.salesOrder.findUnique({
      where: { id },
      include: { customer: true, items: true, returns: true }
    });
  }

  static async createSalesOrder(data: {
    customerId?: string;
    customerName?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    deliveryDate?: string;
    deliveryAddress?: string;
    notes?: string;
    createdBy?: string;
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;

    return prisma.salesOrder.create({
      data: {
        orderNumber: generateSalesOrderNumber(),
        customerId: data.customerId,
        customerName: data.customerName,
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
    });
  }

  static async updateSalesOrder(id: string, data: {
    status?: string;
    deliveryDate?: string;
    deliveryAddress?: string;
    notes?: string;
  }) {
    return prisma.salesOrder.update({
      where: { id },
      data: {
        ...data,
        status: data.status as any,
        deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined
      },
      include: { items: true }
    });
  }

  // ─── Return Orders (RMA) ─────────────────────────────────────────────────────

  static async getReturnOrders(filters: { status?: string; customerId?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.search) {
      where.OR = [
        { returnNumber: { contains: filters.search, mode: 'insensitive' } },
        { reason: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.returnOrder.findMany({
      where,
      include: { customer: true, salesOrder: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createReturnOrder(data: {
    salesOrderId?: string;
    customerId?: string;
    reason: string;
    items: Array<{ productId?: string; productName: string; quantity: number; rate: number; condition?: string }>;
    refundMethod?: string;
  }) {
    const refundAmount = data.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);

    return prisma.returnOrder.create({
      data: {
        returnNumber: generateReturnNumber(),
        salesOrderId: data.salesOrderId,
        customerId: data.customerId,
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
      include: { customer: true, items: true }
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
}
