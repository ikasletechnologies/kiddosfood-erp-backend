import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FinanceService } from '../finance/finance.service';

export class ProcurementService {
  /**
   * Create a new vendor/supplier
   */
  static async createVendor(data: { name: string; contact: string; email?: string }) {
    return prisma.vendor.create({
      data: {
        name: data.name,
        contact: data.contact,
        email: data.email
      }
    });
  }

  static async getVendors() {
    return prisma.vendor.findMany({
      include: { 
        _count: { select: { orders: true } },
        suppliedMaterials: { include: { material: true } }
      },
      orderBy: { name: 'asc' }
    });
  }

  static async getVendorById(id: string) {
    return prisma.vendor.findUnique({
      where: { id },
      include: { orders: { include: { poItems: { include: { inventoryItem: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }, _count: { select: { orders: true } } }
    });
  }

  static async updateVendor(id: string, data: { name?: string; contact?: string; email?: string; rating?: number }) {
    return prisma.vendor.update({ where: { id }, data });
  }

  static async deleteVendor(id: string) {
    // 1. Unlink items associated with this vendor
    await prisma.inventoryItem.updateMany({
      where: { vendorId: id },
      data: { vendorId: null }
    });
    // 2. Delete many-to-many link records
    await prisma.vendorMaterial.deleteMany({ where: { vendorId: id } });
    // 3. Delete the vendor
    return prisma.vendor.delete({ where: { id } });
  }

  /**
   * Create a Purchase Order with relational items
   */
  static async createPurchaseOrder(data: {
    vendorId: string;
    advancePaid?: number;
    expectedDeliveryDate?: string;
    notes?: string;
    items: Array<{ inventoryItemId: string; quantity: number; price: number }>;
  }) {
    const totalAmount = data.items.reduce((acc, item) => acc + item.quantity * item.price, 0);

    const po = await prisma.procurementOrder.create({
      data: {
        vendorId: data.vendorId,
        totalAmount,
        advancePaid: data.advancePaid ?? 0,
        expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : null,
        notes: data.notes,
        status: 'PENDING',
        poItems: {
          create: data.items.map((item) => ({
            inventoryItemId: item.inventoryItemId,
            quantity: item.quantity,
            price: item.price
          }))
        }
      },
      include: { poItems: true, vendor: true }
    });

    // Automatically link these materials to the vendor for future reference
    for (const item of data.items) {
      await this.linkMaterialToVendor(data.vendorId, item.inventoryItemId, item.price);
    }

    return po;
  }

  static async linkMaterialToVendor(vendorId: string, materialId: string, price?: number) {
    return prisma.vendorMaterial.upsert({
      where: { vendorId_materialId: { vendorId, materialId } },
      update: { price, lastUpdated: new Date() },
      create: { vendorId, materialId, price }
    });
  }

  static async recordAdvancePayment(poId: string, advancePaid: number) {
    return prisma.procurementOrder.update({
      where: { id: poId },
      data: { advancePaid },
      include: { poItems: { include: { inventoryItem: true } }, vendor: true }
    });
  }

  static async getPurchaseOrders() {
    return prisma.procurementOrder.findMany({
      include: { vendor: true, poItems: { include: { inventoryItem: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getPurchaseOrderById(id: string) {
    return prisma.procurementOrder.findUnique({
      where: { id },
      include: { vendor: true, poItems: { include: { inventoryItem: true } }, goodsReceipts: true }
    });
  }

  /**
   * GRN Logic: Receive Goods and Increase Stock
   */
  static async cancelPO(poId: string) {
    const po = await prisma.procurementOrder.findUnique({ where: { id: poId } });
    if (!po) throw new Error('Purchase Order not found');
    if (po.received) throw new Error('Cannot cancel a received PO');
    return prisma.procurementOrder.update({ where: { id: poId }, data: { status: 'CANCELLED' }, include: { vendor: true, poItems: { include: { inventoryItem: true } } } });
  }

  static async deletePO(poId: string) {
    const po = await prisma.procurementOrder.findUnique({ where: { id: poId } });
    if (!po) throw new Error('Purchase Order not found');
    if (po.received) throw new Error('Cannot delete a received PO — it has stock movements');
    await prisma.procurementOrderItem.deleteMany({ where: { poId } });
    return prisma.procurementOrder.delete({ where: { id: poId } });
  }

  static async receiveGoods(poId: string) {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch PO with items
      const po = await tx.procurementOrder.findUnique({
        where: { id: poId },
        include: { poItems: true }
      });

      if (!po) throw new Error('Purchase Order not found');
      if (po.received) throw new Error('Goods already received for this PO');

      // 2. Increase Stock for each item
      for (const item of po.poItems) {
        await tx.stockMovement.create({
          data: {
            itemId: item.inventoryItemId,
            movementType: 'PURCHASE_IN',
            quantity: item.quantity,
            referenceType: 'PROCUREMENT_ORDER',
            referenceId: po.id,
            note: `GRN for PO ${po.id}`
          }
        });

        await tx.inventoryItem.update({
          where: { id: item.inventoryItemId },
          data: { currentStock: { increment: item.quantity } }
        });
      }

      // 3. Create Goods Receipt record
      await tx.goodsReceipt.create({
        data: { poId: po.id }
      });

      // 4. Update PO Status
      const updatedPO = await tx.procurementOrder.update({
        where: { id: poId },
        data: {
          status: 'RECEIVED',
          received: true,
          // actualDeliveryDate: new Date()
        },
        include: { poItems: true, goodsReceipts: true }
      });

      return updatedPO;
    });

    // Phase 5: Record Expense automatically (After transaction commits)
    try {
        await FinanceService.recordExpenseFromPurchase(poId);
    } catch (err) {
        console.error('[Accounting] Failed to record purchase expense', err);
    }

    return result;
  }
}
