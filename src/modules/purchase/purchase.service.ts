import prisma from '../../lib/prisma';
import { ProcurementService } from '../procurement/procurement.service';
import { InventoryService } from '../inventory/inventory.service';

async function generateRFQNumber() {
  const year = new Date().getFullYear();
  const count = await prisma.requestForQuotation.count({
    where: { createdAt: { gte: new Date(year, 0, 1) } }
  });
  return `RFQ-${year}-${(count + 1).toString().padStart(5, '0')}`;
}

async function generateReturnNumber() {
  const year = new Date().getFullYear();
  const count = await prisma.purchaseReturn.count({
    where: { createdAt: { gte: new Date(year, 0, 1) } }
  });
  return `PR-${year}-${(count + 1).toString().padStart(5, '0')}`;
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
        rfqNumber: await generateRFQNumber(),
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
      include: {
        items: true,
        rfq: { include: { purchaseRequest: { include: { items: { include: { inventoryItem: true } } } } } }
      }
    });
    if (!quote) throw new Error('Quotation not found');

    // VendorQuotationItem only stores a free-text itemName (it isn't linked to a
    // real InventoryItem), but a normal PO requires a real inventoryItemId on every
    // line so GST/costing can be computed. Resolve each quoted item to a real
    // InventoryItem: prefer a name match against the RFQ's linked Purchase Request
    // (if any), then fall back to a direct case-insensitive name match. If a line
    // can't be resolved, fail loudly instead of creating a PO with no real items —
    // that's what silently produced the previous broken (poNumber-less) PO.
    const prItemsByName = new Map(
      (quote.rfq?.purchaseRequest?.items || []).map((pi) => [pi.inventoryItem.name.toLowerCase(), pi.inventoryItem])
    );

    const resolvedItems = await Promise.all(
      quote.items.map(async (item) => {
        const key = item.itemName.trim().toLowerCase();
        let inventoryItem = prItemsByName.get(key);
        if (!inventoryItem) {
          inventoryItem = await prisma.inventoryItem.findFirst({
            where: { name: { equals: item.itemName, mode: 'insensitive' } }
          }) || undefined;
        }
        if (!inventoryItem) {
          throw new Error(
            `Cannot convert quotation to PO: "${item.itemName}" is not linked to any Inventory item. Add it to Inventory first, then retry.`
          );
        }
        return {
          inventoryItemId: inventoryItem.id,
          quantity: item.quantity,
          price: item.quotedRate || 0
        };
      })
    );

    // Delegate to the real PO-creation path so GST computation, poNumber
    // generation, and structured poItems all match a normally-created PO.
    const po = await ProcurementService.createPurchaseOrder({
      vendorId: quote.vendorId,
      status: 'PENDING_APPROVAL',
      notes: `Converted from Quotation (RFQ ${quote.rfq?.rfqNumber || quote.rfqId})`,
      items: resolvedItems
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
        returnNumber: await generateReturnNumber(),
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
            await InventoryService.recordMovement(tx, {
              itemId: material.id,
              type: 'RETURN_OUT',
              quantity: -item.quantity,
              referenceType: 'PURCHASE_RETURN',
              referenceId: id,
              note: `Purchase Return ${existing.returnNumber} to ${existing.vendor.name}`
            });
          }
        }

        // B. Update Vendor Ledger (DEBIT reduces what we owe the vendor).
        // NOTE: this must be a DEBIT, not a CREDIT — ProcurementService.getVendors()
        // only counts RETURN entries as liability-reducing when type === 'DEBIT'.
        // Posting a CREDIT here previously made an approved return *increase* the
        // vendor's computed payable balance instead of decreasing it.
        const lastEntry = await tx.vendorLedger.findFirst({
          where: { vendorId: existing.vendorId },
          orderBy: { createdAt: 'desc' }
        });
        const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
        const nextBalance = currentBalance - (existing.refundAmount || 0);

        await tx.vendorLedger.create({
          data: {
            vendorId: existing.vendorId,
            type: 'DEBIT',
            amount: existing.refundAmount || 0,
            balanceAfterTransaction: nextBalance,
            sourceModule: 'PROCUREMENT',
            referenceType: 'RETURN',
            referenceId: id,
            paymentMode: 'CASH',
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
        status: 'PENDING_APPROVAL'
      },
      include: { vendor: true }
    });
  }
}
