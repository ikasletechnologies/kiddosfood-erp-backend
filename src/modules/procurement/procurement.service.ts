import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FinanceService } from '../finance/finance.service';

export class ProcurementService {
  /**
   * Create a new vendor/supplier
   */
  static async createVendor(data: { name: string; contact: string; email?: string; address?: string; remark?: string, manualPurchaseAdj?: number, manualAdvanceAdj?: number }) {
    // 1. Name Validation (Alphabet Only)
    if (!data.name || !/^[A-Za-z\s]+$/.test(data.name)) {
      throw new Error("Vendor Name is required and must contain only alphabets.");
    }

    // 2. Contact Validation (Exactly 10 Numbers)
    if (!data.contact || !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be exactly 10 digits.");
    }

    // 3. Email Validation (@gmail.com only)
    if (data.email && !data.email.toLowerCase().endsWith("@gmail.com")) {
      throw new Error("Only @gmail.com addresses are permitted for vendors.");
    }

    // 4. Address Validation (Mandatory)
    if (!data.address || data.address.trim().length === 0) {
      throw new Error("Registered Office Address is a mandatory field.");
    }

    return prisma.vendor.create({
      data: {
        name: data.name,
        contact: data.contact,
        email: data.email,
        address: data.address,
        remark: data.remark,
        manualPurchaseAdj: data.manualPurchaseAdj || 0,
        manualAdvanceAdj: data.manualAdvanceAdj || 0
      }
    });
  }

  static async getVendors() {
    const vendors = await prisma.vendor.findMany({
      include: { 
        _count: { select: { orders: true } },
        suppliedMaterials: { include: { material: true } },
        ledgerEntries: { select: { type: true, amount: true } },
        orders: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 }
      },
      orderBy: { name: 'asc' }
    });

    return vendors.map(v => {
      // Calculate balance from ledger: Credit - Debit
      const balance = v.ledgerEntries.reduce((acc, entry) => {
        return acc + (entry.type === 'CREDIT' ? entry.amount : -entry.amount);
      }, 0);

      // Keep legacy fields for UI compatibility but calculate from ledger
      const totalOrder = v.ledgerEntries
        .filter(e => e.type === 'DEBIT')
        .reduce((s, e) => s + e.amount, 0);
      
      const totalAdvance = v.ledgerEntries
        .filter(e => e.type === 'CREDIT')
        .reduce((s, e) => s + e.amount, 0);

      const lastOrderDate = v.orders[0]?.createdAt || null;

      return {
        ...v,
        totalOrder,
        totalAdvance,
        balance,
        lastOrderDate
      };
    });
  }

  static async getVendorById(id: string) {
    return prisma.vendor.findUnique({
      where: { id },
      include: { orders: { include: { poItems: { include: { inventoryItem: true } } }, orderBy: { createdAt: 'desc' }, take: 10 }, _count: { select: { orders: true } } }
    });
  }

  static async getVendorFinancials(vendorId: string) {
    const entries = await prisma.vendorLedger.findMany({
      where: { vendorId },
      select: { type: true, amount: true }
    });

    const totalOrder = entries.filter(e => e.type === 'DEBIT').reduce((s, e) => s + e.amount, 0);
    const totalAdvance = entries.filter(e => e.type === 'CREDIT').reduce((s, e) => s + e.amount, 0);
    const balance = totalAdvance - totalOrder;

    return { totalOrder, totalAdvance, balance };
  }

  static async updateVendor(id: string, data: { name?: string; contact?: string; email?: string; address?: string; remark?: string; rating?: number; manualPurchaseAdj?: number, manualAdvanceAdj?: number }) {
    // 1. Name Validation
    if (data.name !== undefined && !/^[A-Za-z\s]+$/.test(data.name)) {
      throw new Error("Vendor Name must contain only alphabets.");
    }

    // 2. Contact Validation
    if (data.contact !== undefined && !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be exactly 10 digits.");
    }

    // 3. Email Validation
    if (data.email && !data.email.toLowerCase().endsWith("@gmail.com")) {
      throw new Error("Only @gmail.com addresses are permitted.");
    }

    // 4. Address Validation
    if (data.address !== undefined && data.address.trim().length === 0) {
      throw new Error("Registered Office Address cannot be empty.");
    }

    return prisma.vendor.update({ where: { id }, data });
  }

  static async deleteVendor(id: string) {
    const financials = await this.getVendorFinancials(id);
    if (Math.abs(financials.balance) > 0.01) {
      throw new Error(`Cannot delete vendor with non-zero balance (₹${financials.balance.toLocaleString()})`);
    }

    const pendingOrders = await prisma.procurementOrder.count({
      where: { vendorId: id, status: 'PENDING' }
    });
    if (pendingOrders > 0) {
      throw new Error("Cannot delete vendor with pending Purchase Orders.");
    }

    return prisma.$transaction(async (tx) => {
      // 1. Unlink items associated with this vendor
      await tx.inventoryItem.updateMany({
        where: { vendorId: id },
        data: { vendorId: null }
      });
      
      // 2. Clear related records
      await tx.vendorMaterial.deleteMany({ where: { vendorId: id } });
      await tx.vendorLedger.deleteMany({ where: { vendorId: id } });
      await tx.procurementOrderItem.deleteMany({ where: { procurementOrder: { vendorId: id } } });
      await tx.goodsReceipt.deleteMany({ where: { procurementOrder: { vendorId: id } } });
      await tx.procurementOrder.deleteMany({ where: { vendorId: id } });
      await tx.purchaseRFQ.deleteMany({ where: { vendorId: id } });

      // Finally delete the vendor
      return tx.vendor.delete({ where: { id } });
    });
  }

  /**
   * Helper: get current vendor ledger balance (CREDIT - DEBIT)
   * Positive = vendor has advance with us; Negative = we owe vendor
   */
  static async getVendorBalance(vendorId: string): Promise<number> {
    const entries = await prisma.vendorLedger.findMany({
      where: { vendorId },
      select: { type: true, amount: true }
    });
    return entries.reduce((acc, e) => acc + (e.type === 'CREDIT' ? e.amount : -e.amount), 0);
  }

  /**
   * Create a Purchase Order with relational items.
   * Auto-applies any available advance balance against the PO amount.
   * If advancePaid is provided, it records a new payment (CREDIT) on top.
   */
  static async createPurchaseOrder(data: {
    vendorId: string;
    advancePaid?: number;
    expectedDeliveryDate?: string;
    notes?: string;
    items: Array<{ inventoryItemId: string; quantity: number; price: number }>;
  }) {
    const totalAmount = data.items.reduce((acc, item) => acc + item.quantity * item.price, 0);

    // Fetch current balance BEFORE this transaction (auto-advance calculation)
    const currentBalance = await this.getVendorBalance(data.vendorId);
    const newAdvancePayment = data.advancePaid && data.advancePaid > 0 ? data.advancePaid : 0;
    // Available advance = existing balance + any new advance being paid now
    const availableForThisPO = currentBalance + newAdvancePayment;
    // Auto-applied advance shown on PO (display only — actual balance comes from ledger)
    const autoAppliedAdvance = Math.max(0, Math.min(availableForThisPO, totalAmount));

    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the PO
      const po = await tx.procurementOrder.create({
        data: {
          vendorId: data.vendorId,
          totalAmount,
          advancePaid: autoAppliedAdvance,
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
        include: { poItems: { include: { inventoryItem: true } }, vendor: true }
      });

      // 2. Create Ledger DEBIT for PO amount (goods ordered = liability)
      await tx.vendorLedger.create({
        data: {
          vendorId: data.vendorId,
          type: 'DEBIT',
          amount: totalAmount,
          referenceType: 'PO',
          referenceId: po.id,
          note: `Purchase Order #${po.id.substring(0, 8)} — ₹${totalAmount.toLocaleString('en-IN')}`
        }
      });

      // 3. If user is paying new advance NOW (along with PO creation), record CREDIT
      if (newAdvancePayment > 0) {
        await tx.vendorLedger.create({
          data: {
            vendorId: data.vendorId,
            type: 'CREDIT',
            amount: newAdvancePayment,
            referenceType: 'ADVANCE',
            referenceId: po.id,
            note: `Advance Payment with PO #${po.id.substring(0, 8)}`
          }
        });
      }

      return po;
    });

    // Link materials to vendor (non-critical, outside transaction)
    for (const item of data.items) {
      this.linkMaterialToVendor(data.vendorId, item.inventoryItemId, item.price).catch(console.error);
    }

    return result;
  }

  static async linkMaterialToVendor(vendorId: string, materialId: string, price?: number) {
    return prisma.vendorMaterial.upsert({
      where: { vendorId_materialId: { vendorId, materialId } },
      update: { price, lastUpdated: new Date() },
      create: { vendorId, materialId, price }
    });
  }

  /**
   * Record advance payment against an existing PO.
   * Creates a CREDIT ledger entry and updates PO.advancePaid for display.
   */
  static async recordAdvancePayment(poId: string, advancePaid: number) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'CANCELLED') throw new Error('Cannot record advance on a cancelled PO');

      // Create CREDIT entry in ledger (new advance payment)
      await tx.vendorLedger.create({
        data: {
          vendorId: po.vendorId,
          type: 'CREDIT',
          amount: advancePaid,
          referenceType: 'ADVANCE',
          referenceId: po.id,
          note: `Advance Payment for PO #${po.id.substring(0, 8)}`
        }
      });

      // Recalculate advancePaid display: previous advancePaid + this new payment (capped at totalAmount)
      const newAdvancePaid = Math.min(po.totalAmount, po.advancePaid + advancePaid);

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { advancePaid: newAdvancePaid },
        include: { poItems: { include: { inventoryItem: true } }, vendor: true }
      });
    });
  }

  /** Transition PO from PENDING → APPROVED */
  static async approvePO(poId: string) {
    const po = await prisma.procurementOrder.findUnique({ where: { id: poId } });
    if (!po) throw new Error('Purchase Order not found');
    if (po.status !== 'PENDING') throw new Error(`Cannot approve a PO with status ${po.status}`);

    return prisma.procurementOrder.update({
      where: { id: poId },
      data: { status: 'APPROVED' },
      include: { vendor: true, poItems: { include: { inventoryItem: true } } }
    });
  }

  static async getPurchaseOrders() {
    const orders = await prisma.procurementOrder.findMany({
      include: { vendor: true, poItems: { include: { inventoryItem: true } }, goodsReceipts: true },
      orderBy: { createdAt: 'desc' }
    });
    // Attach live balanceDue for each PO
    return orders.map((po) => ({
      ...po,
      balanceDue: Math.max(0, po.totalAmount - po.advancePaid)
    }));
  }

  static async getPurchaseOrderById(id: string) {
    return prisma.procurementOrder.findUnique({
      where: { id },
      include: { vendor: true, poItems: { include: { inventoryItem: true } }, goodsReceipts: true }
    });
  }

  /**
   * Cancel a PO: only reverses the PO DEBIT in the ledger.
   * Advance/payment CREDITs remain intact — the money is still with the vendor
   * and will automatically apply to future POs via balance calculation.
   */
  static async cancelPO(poId: string) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'RECEIVED') throw new Error('Cannot cancel a received PO');
      if (po.status === 'CANCELLED') throw new Error('PO is already cancelled');

      // Reverse ONLY the PO DEBIT — advances stay with vendor as credit balance
      await tx.vendorLedger.create({
        data: {
          vendorId: po.vendorId,
          type: 'CREDIT',
          amount: po.totalAmount,
          referenceType: 'ADJUSTMENT',
          referenceId: po.id,
          note: `PO Cancelled — Reversal of PO #${po.id.substring(0, 8)}`
        }
      });

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { status: 'CANCELLED' },
        include: { vendor: true, poItems: { include: { inventoryItem: true } } }
      });
    });
  }

  /**
   * Hard-delete a PENDING or CANCELLED PO.
   * Creates ledger reversal if PENDING, then removes the record.
   */
  static async deletePO(poId: string) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'RECEIVED') throw new Error('Cannot delete a received PO');

      // If PENDING, reverse the DEBIT before deleting
      if (po.status === 'PENDING') {
        await tx.vendorLedger.create({
          data: {
            vendorId: po.vendorId,
            type: 'CREDIT',
            amount: po.totalAmount,
            referenceType: 'ADJUSTMENT',
            referenceId: po.id,
            note: `PO Deleted — Reversal of PO #${po.id.substring(0, 8)}`
          }
        });
      }

      await tx.procurementOrderItem.deleteMany({ where: { poId } });
      await tx.goodsReceipt.deleteMany({ where: { poId } });
      return tx.procurementOrder.delete({ where: { id: poId } });
    });
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

  static async filterVendors(filters: any) {
    const vendors = await this.getVendors();

    return vendors.filter(v => {
      // 1. Material Filter
      if (filters.materialId) {
        const hasMaterial = v.suppliedMaterials.some((m: any) => m.materialId === filters.materialId);
        if (!hasMaterial) return false;
      }

      // 2. Balance Type Filter
      if (filters.balanceType === 'ADVANCE' && v.balance <= 0) return false;
      if (filters.balanceType === 'OWED' && v.balance >= 0) return false;

      // 3. Price Filter (Search across supplied materials)
      if (filters.minPrice || filters.maxPrice) {
        const prices = v.suppliedMaterials.map((m: any) => m.price || 0);
        const match = prices.some((p: number) => {
          if (filters.minPrice && p < Number(filters.minPrice)) return false;
          if (filters.maxPrice && p > Number(filters.maxPrice)) return false;
          return true;
        });
        if (!match) return false;
      }

      return true;
    });
  }

  static async getVendorsSummary() {
    const vendors = await this.getVendors();
    const totalVendors = vendors.length;
    
    const totalOwed    = vendors.filter(v => v.balance < 0).reduce((s, v) => s + Math.abs(v.balance), 0);
    const totalAdvance = vendors.filter(v => v.balance > 0).reduce((s, v) => s + v.balance, 0);
    const totalMaterials = await prisma.vendorMaterial.count();

    return { totalVendors, totalOwed, totalAdvance, totalMaterials };
  }

  /**
   * Ledger Operations
   */
  static async getVendorLedger(vendorId: string, filters: any = {}) {
    const ledger = await prisma.vendorLedger.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' } // Sorted for running balance
    });

    let runningBalance = 0;
    return ledger.map(entry => {
      runningBalance += (entry.type === 'CREDIT' ? entry.amount : -entry.amount);
      return {
        ...entry,
        runningBalance
      };
    }).reverse(); // Latest first for UI
  }

  static async recordPayment(vendorId: string, amount: number, note: string) {
    return prisma.vendorLedger.create({
      data: {
        vendorId,
        type: 'CREDIT',
        amount,
        referenceType: 'PAYMENT',
        note: note || 'Direct Payment'
      }
    });
  }

  static async recordAdjustment(vendorId: string, amount: number, type: 'CREDIT' | 'DEBIT', note: string) {
    return prisma.vendorLedger.create({
      data: {
        vendorId,
        type,
        amount,
        referenceType: 'ADJUSTMENT',
        note: note || 'Manual Ledger Adjustment'
      }
    });
  }
}
