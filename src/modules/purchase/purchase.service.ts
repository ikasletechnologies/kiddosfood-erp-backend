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
  // ─── RFQ (New Enterprise Structure) ──────────────────────────────────────────

  static async getRFQs(filters: { status?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { rfqNumber: { contains: filters.search, mode: 'insensitive' } },
        { notes: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.requestForQuotation.findMany({
      where,
      include: { 
         purchaseRequest: true,
         quotations: { include: { vendor: true, items: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getRFQById(id: string) {
    return prisma.requestForQuotation.findUnique({
      where: { id },
      include: { 
         purchaseRequest: true,
         quotations: { include: { vendor: true, items: true } }
      }
    });
  }

  static async createRFQ(data: {
    purchaseRequestId?: string;
    deadline?: string;
    notes?: string;
    createdBy?: string;
  }) {
    return prisma.requestForQuotation.create({
      data: {
        rfqNumber: generateRFQNumber(),
        purchaseRequestId: data.purchaseRequestId,
        deadline: data.deadline ? new Date(data.deadline) : undefined,
        notes: data.notes,
        createdBy: data.createdBy,
        status: 'OPEN'
      }
    });
  }

  static async addVendorQuotation(rfqId: string, data: {
     vendorId: string;
     validUntil?: string;
     notes?: string;
     items: Array<{ itemName: string; quantity: number; unit: string; quotedRate: number; notes?: string }>;
  }) {
     const totalAmount = data.items.reduce((s, i) => s + i.quantity * i.quotedRate, 0);

     return prisma.vendorQuotation.create({
        data: {
           rfqId,
           vendorId: data.vendorId,
           totalAmount,
           validUntil: data.validUntil ? new Date(data.validUntil) : null,
           notes: data.notes,
           status: 'PENDING',
           items: {
              create: data.items.map(item => ({
                 itemName: item.itemName,
                 quantity: item.quantity,
                 unit: item.unit,
                 quotedRate: item.quotedRate,
                 notes: item.notes
              }))
           }
        },
        include: { vendor: true, items: true }
     });
  }

  static async updateRFQ(id: string, data: {
    status?: string;
    notes?: string;
  }) {
    return prisma.requestForQuotation.update({
      where: { id },
      data: { status: data.status as any, notes: data.notes }
    });
  }

  static async convertQuotationToPO(quotationId: string) {
    const quote = await prisma.vendorQuotation.findUnique({
      where: { id: quotationId },
      include: { items: true, rfq: true }
    });
    if (!quote) throw new Error('Quotation not found');

    const poItems = quote.items.map((item) => ({
      itemName: item.itemName,
      quantity: item.quantity,
      unit: item.unit,
      rate: item.quotedRate || 0,
      totalAmount: item.quantity * (item.quotedRate || 0)
    }));

    const po = await prisma.procurementOrder.create({
      data: {
        vendorId: rfq.vendorId,
        totalAmount,
        items: poItems
      }
    });

    await prisma.vendorQuotation.update({ where: { id: quotationId }, data: { status: 'ACCEPTED' } });
    await prisma.requestForQuotation.update({ where: { id: quote.rfqId }, data: { status: 'CLOSED' } });

    // Reject other quotes for this RFQ
    await prisma.vendorQuotation.updateMany({
       where: { rfqId: quote.rfqId, id: { not: quotationId } },
       data: { status: 'REJECTED' }
    });

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
    const { status } = data;
    
    return prisma.$transaction(async (tx) => {
      const existing = await tx.purchaseReturn.findUnique({
        where: { id },
        include: { items: true, vendor: true }
      });
      if (!existing) throw new Error('Purchase Return not found');
      if (existing.status === 'COMPLETED') throw new Error('Cannot update a completed return');

      // 1. If transitioning to APPROVED or COMPLETED, trigger Inventory and Financial adjustments
      if ((status === 'APPROVED' || status === 'COMPLETED') && existing.status === 'PENDING') {
        
        // A. Update Stock (Subtract)
        for (const item of existing.items) {
          // Find matching material by name (since returns can be ad-hoc or linked)
          const material = await tx.inventoryItem.findFirst({
            where: { name: { equals: item.itemName, mode: 'insensitive' } }
          });

          if (material) {
            await tx.inventoryItem.update({
              where: { id: material.id },
              data: { currentStock: { decrement: item.quantity } }
            });

            await tx.stockMovement.create({
              data: {
                itemId: material.id,
                movementType: 'PRODUCTION_OUT', // Using PRODUCTION_OUT as a proxy for stock reduction, or we could add a RETURN_OUT type
                quantity: -item.quantity,
                referenceType: 'PURCHASE_RETURN',
                referenceId: id,
                note: `Purchase Return ${existing.returnNumber} to ${existing.vendor.name}`
              }
            });
          }
        }

        // B. Update Vendor Ledger (Record Credit to reduce payable)
        const lastEntry = await tx.vendorLedger.findFirst({
          where: { vendorId: existing.vendorId },
          orderBy: { createdAt: 'desc' }
        });
        const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
        const nextBalance = currentBalance + (existing.refundAmount || 0);

        await tx.vendorLedger.create({
          data: {
            vendorId: existing.vendorId,
            type: 'CREDIT',
            amount: existing.refundAmount || 0,
            balanceAfterTransaction: nextBalance,
            sourceModule: 'PURCHASE',
            referenceType: 'RETURN',
            referenceId: id,
            note: `Purchase Return ${existing.returnNumber} — Liability Reduction`
          }
        });
      }

      return tx.purchaseReturn.update({
        where: { id },
        data: { status: status as any }
      });
    });
  }

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
        items: data.items,
        status: 'PENDING'
      },
      include: { vendor: true }
    });
  }
}
