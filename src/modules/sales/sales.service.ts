import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';

// Number generators are DB-count-based (not in-memory counters) so they can't
// collide against their @unique DB columns after a server restart.
async function generateQuotationNumber() {
  const year = new Date().getFullYear();
  const count = await prisma.quotation.count({ where: { createdAt: { gte: new Date(year, 0, 1) } } });
  return `QT-${year}-${(count + 1).toString().padStart(5, '0')}`;
}

async function generateSalesOrderNumber() {
  const year = new Date().getFullYear();
  const count = await prisma.salesOrder.count({ where: { createdAt: { gte: new Date(year, 0, 1) } } });
  return `SO-${year}-${(count + 1).toString().padStart(5, '0')}`;
}

async function generateReturnNumber() {
  const count = await prisma.returnOrder.count();
  return `SR${(count + 1).toString().padStart(10, '0')}`;
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

    const orderIds = quotations.map(q => q.convertedOrderId).filter(Boolean) as string[];
    if (orderIds.length > 0) {
      const orders = await prisma.salesOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, orderNumber: true }
      });
      const orderMap = new Map(orders.map(o => [o.id, o.orderNumber]));
      return quotations.map(q => ({
        ...q,
        convertedOrderNumber: q.convertedOrderId ? orderMap.get(q.convertedOrderId) : null
      }));
    }
    return quotations.map(q => ({ ...q, convertedOrderNumber: null }));
  }

  static async getQuotationById(id: string) {
    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
    if (quotation && quotation.convertedOrderId) {
      const order = await prisma.salesOrder.findUnique({
        where: { id: quotation.convertedOrderId },
        select: { orderNumber: true }
      });
      return {
        ...quotation,
        convertedOrderNumber: order?.orderNumber || null
      };
    }
    return quotation ? { ...quotation, convertedOrderNumber: null } : null;
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
    quotationNumber?: string;
    status?: string;
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;

    return prisma.quotation.create({
      data: {
        quotationNumber: data.quotationNumber || await generateQuotationNumber(),
        customerId: data.customerId,
        customerName: data.customerName,
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
    });
  }

  static async updateQuotation(id: string, data: {
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
    const updateData: any = {
      customerId: data.customerId,
      customerName: data.customerName,
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

  static async convertQuotationToOrder(
    quotationId: string,
    createdBy?: string,
    trackingData?: {
      trackingNumber?: string;
      courierName?: string;
      deliveryDate?: string;
      deliveryAddress?: string;
    }
  ) {
    const quotation = await prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { items: true }
    });
    if (!quotation) throw new Error('Quotation not found');

    const salesOrder = await prisma.salesOrder.create({
      data: {
        orderNumber: await generateSalesOrderNumber(),
        quotationId,
        customerId: quotation.customerId,
        customerName: quotation.customerName,
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
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { items: true }
    });

    await prisma.quotation.update({
      where: { id: quotationId },
      data: {
        status: 'CONVERTED',
        convertedOrderId: salesOrder.id,
        trackingNumber: trackingData?.trackingNumber || undefined,
        courierName: trackingData?.courierName || undefined
      }
    });

    return salesOrder;
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
        orderNumber: await generateSalesOrderNumber(),
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

  static async updateSalesOrder(id: string, data: any) {
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

  static async getDeliveryChallans(filters: { customerId?: string; status?: string; search?: string }) {
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
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getDeliveryChallanById(id: string) {
    return prisma.deliveryChallan.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
  }

  static async createDeliveryChallan(data: {
    customerId?: string;
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
        salesOrderId: data.salesOrderId || null,
        franchiseId: data.franchiseId || null,
        sourceFranchiseId: data.sourceFranchiseId || 'hq-001',
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
      include: { customer: true, items: true }
    });

    if (newChallan.status === 'OPEN') {
      await SalesService.dispatchChallanStock(newChallan, userId);
    }

    return newChallan;
  }

  static async updateDeliveryChallan(id: string, data: { status?: string; vehicleNo?: string; driverName?: string; notes?: string }, userId: string = 'system') {
    const currentChallan = await prisma.deliveryChallan.findUnique({ where: { id }, include: { items: true } });
    if (!currentChallan) throw new Error('Delivery challan not found');

    // Block moving away from CLOSED once delivered
    if (currentChallan.status === 'CLOSED' && data.status && data.status !== 'CLOSED') {
      throw new Error('Cannot change status of a closed delivery challan');
    }

    const updated = await prisma.deliveryChallan.update({ where: { id }, data, include: { items: true } });

    // Handle Stock Transitions
    if (currentChallan.status === 'DRAFT' && updated.status === 'OPEN') {
      await SalesService.dispatchChallanStock(updated, userId);
    } else if (currentChallan.status === 'OPEN' && updated.status === 'CLOSED') {
      await SalesService.receiveChallanStock(updated, userId);
    } else if (currentChallan.status === 'OPEN' && updated.status === 'CANCELLED') {
      await SalesService.reverseChallanStock(updated, userId);
    }

    return updated;
  }

  // --- Helper Stock Movement methods for DC ---
  
  private static async dispatchChallanStock(challan: any, userId: string) {
    const sourceId = challan.sourceFranchiseId || 'hq-001';
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
    const sourceId = challan.sourceFranchiseId || 'hq-001';
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
