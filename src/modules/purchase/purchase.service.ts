import prisma from '../../lib/prisma';

let rfqCounter = 1000;
let returnCounter = 1000;

function generateRFQNumber() {
  return `RFQ-${new Date().getFullYear()}-${String(++rfqCounter).padStart(5, '0')}`;
}

function generateReturnNumber() {
  return `PR-${new Date().getFullYear()}-${String(++returnCounter).padStart(5, '0')}`;
}

export class PurchaseService {
  // ─── RFQ ─────────────────────────────────────────────────────────────────────

  static async getRFQs(filters: { vendorId?: string; status?: string; search?: string }) {
    const where: any = {};
    if (filters.vendorId) where.vendorId = filters.vendorId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { rfqNumber: { contains: filters.search, mode: 'insensitive' } },
        { notes: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.purchaseRFQ.findMany({
      where,
      include: { vendor: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getRFQById(id: string) {
    return prisma.purchaseRFQ.findUnique({
      where: { id },
      include: { vendor: true, items: true }
    });
  }

  static async createRFQ(data: {
    vendorId: string;
    items: Array<{ itemName: string; quantity: number; unit: string; notes?: string }>;
    responseDeadline?: string;
    notes?: string;
    createdBy?: string;
  }) {
    return prisma.purchaseRFQ.create({
      data: {
        rfqNumber: generateRFQNumber(),
        vendorId: data.vendorId,
        responseDeadline: data.responseDeadline ? new Date(data.responseDeadline) : undefined,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: data.items.map((item) => ({
            itemName: item.itemName,
            quantity: item.quantity,
            unit: item.unit,
            notes: item.notes
          }))
        }
      },
      include: { vendor: true, items: true }
    });
  }

  static async updateRFQ(id: string, data: {
    status?: string;
    quotedAmount?: number;
    notes?: string;
    items?: Array<{ id?: string; itemName: string; quantity: number; unit: string; quotedRate?: number; notes?: string }>;
  }) {
    const updateData: any = {
      status: data.status as any,
      quotedAmount: data.quotedAmount,
      notes: data.notes
    };

    if (data.items) {
      await prisma.rFQItem.deleteMany({ where: { rfqId: id } });
      updateData.items = {
        create: data.items.map((item) => ({
          itemName: item.itemName,
          quantity: item.quantity,
          unit: item.unit,
          quotedRate: item.quotedRate,
          notes: item.notes
        }))
      };
    }

    return prisma.purchaseRFQ.update({
      where: { id },
      data: updateData,
      include: { vendor: true, items: true }
    });
  }

  static async convertRFQtoPO(rfqId: string) {
    const rfq = await prisma.purchaseRFQ.findUnique({
      where: { id: rfqId },
      include: { items: true }
    });
    if (!rfq) throw new Error('RFQ not found');

    const poItems = rfq.items.map((item) => ({
      itemName: item.itemName,
      quantity: item.quantity,
      unit: item.unit,
      rate: item.quotedRate || 0,
      totalAmount: item.quantity * (item.quotedRate || 0)
    }));

    const totalAmount = poItems.reduce((s, i) => s + i.totalAmount, 0);

    const po = await prisma.procurementOrder.create({
      data: {
        vendorId: rfq.vendorId,
        totalAmount,
        poItems: {
          create: poItems.map(item => ({
            itemName: item.itemName,
            quantity: item.quantity,
            price: item.rate,
            total: item.totalAmount
          }))
        }
      }
    });

    await prisma.purchaseRFQ.update({ where: { id: rfqId }, data: { status: 'CONVERTED' } });

    return po;
  }

  // ─── Purchase Returns ────────────────────────────────────────────────────────

  static async getPurchaseReturns(filters: { vendorId?: string; status?: string; search?: string }) {
    const where: any = {};
    if (filters.vendorId) where.vendorId = filters.vendorId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { returnNumber: { contains: filters.search, mode: 'insensitive' } },
        { reason: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.purchaseReturn.findMany({
      where,
      include: { vendor: true, procurementOrder: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createPurchaseReturn(data: {
    procurementOrderId?: string;
    vendorId: string;
    reason: string;
    items: Array<{ itemName: string; quantity: number; unit: string; rate: number }>;
  }) {
    const refundAmount = data.items.reduce((s, i) => s + i.quantity * i.rate, 0);

    return prisma.purchaseReturn.create({
      data: {
        returnNumber: generateReturnNumber(),
        procurementOrderId: data.procurementOrderId,
        vendorId: data.vendorId,
        reason: data.reason,
        refundAmount,
        items: {
          create: data.items.map((item) => ({
            itemName: item.itemName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            totalAmount: item.quantity * item.rate
          }))
        }
      },
      include: { vendor: true, items: true }
    });
  }

  static async updatePurchaseReturn(id: string, data: { status: string }) {
    return prisma.purchaseReturn.update({ where: { id }, data });
  }

  // ─── Purchase Requisition ─────────────────────────────────────────────────────
  // Reuses ProcurementOrder with status=PENDING as a requisition

  static async createRequisition(data: {
    vendorId: string;
    items: Array<{ itemName: string; quantity: number; unit: string; estimatedRate?: number }>;
    notes?: string;
  }) {
    const totalAmount = data.items.reduce((s, i) => s + i.quantity * (i.estimatedRate || 0), 0);

    return prisma.procurementOrder.create({
      data: {
        vendorId: data.vendorId,
        totalAmount,
        poItems: {
          create: data.items.map(item => ({
            itemName: item.itemName,
            quantity: item.quantity,
            price: item.estimatedRate || 0,
            total: item.quantity * (item.estimatedRate || 0)
          }))
        },
        status: 'PENDING'
      },
      include: { vendor: true }
    });
  }
}
