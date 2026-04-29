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
        ledgerEntries: { select: { type: true, amount: true, referenceType: true } },
        orders: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 }
      },
      orderBy: { name: 'asc' }
    });

    return vendors.map(v => {
      // MASTER ACCOUNTING FORMULA
      const totalPayments = v.ledgerEntries
        .filter(e => e.type === 'CREDIT' && e.referenceType === 'PAYMENT')
        .reduce((s, e) => s + e.amount, 0);

      const totalReturns = v.ledgerEntries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'RETURN')
        .reduce((s, e) => s + e.amount, 0);

      const totalPurchased = v.ledgerEntries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'PO')
        .reduce((s, e) => s + e.amount, 0);
      
      const manualCredits = v.ledgerEntries
        .filter(e => e.type === 'CREDIT' && (e.referenceType === 'ADJUSTMENT' || e.referenceType === 'ADVANCE'))
        .reduce((s, e) => s + e.amount, 0);
      
      const manualDebits = v.ledgerEntries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'ADJUSTMENT')
        .reduce((s, e) => s + e.amount, 0);

      const netPaid = (totalPayments + manualCredits) - (totalReturns + manualDebits);
      const balance = netPaid - totalPurchased;

      return {
        ...v,
        totalPurchased,
        totalPaid: netPaid, 
        balance: balance,
        advance: balance > 0 ? balance : 0,
        due: balance < 0 ? Math.abs(balance) : 0,
        lastOrderDate: v.orders[0]?.createdAt || null
      };
    });
  }

  static async getVendorById(id: string) {
    return prisma.vendor.findUnique({
      where: { id },
      include: { 
        orders: { 
          include: { poItems: { include: { inventoryItem: true } } }, 
          orderBy: { createdAt: 'desc' }, 
          take: 10 
        }, 
        _count: { select: { orders: true } } 
      }
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
    if (data.name !== undefined && !/^[A-Za-z\s]+$/.test(data.name)) {
      throw new Error("Vendor Name must contain only alphabets.");
    }
    if (data.contact !== undefined && !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be exactly 10 digits.");
    }
    if (data.email && !data.email.toLowerCase().endsWith("@gmail.com")) {
      throw new Error("Only @gmail.com addresses are permitted.");
    }
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
      await tx.inventoryItem.updateMany({
        where: { vendorId: id },
        data: { vendorId: null }
      });
      await tx.vendorMaterial.deleteMany({ where: { vendorId: id } });
      await tx.vendorLedger.deleteMany({ where: { vendorId: id } });
      await tx.procurementOrderItem.deleteMany({ where: { procurementOrder: { vendorId: id } } });
      await tx.goodsReceipt.deleteMany({ where: { procurementOrder: { vendorId: id } } });
      await tx.procurementOrder.deleteMany({ where: { vendorId: id } });
      await tx.purchaseRFQ.deleteMany({ where: { vendorId: id } });
      return tx.vendor.delete({ where: { id } });
    });
  }

  static async getVendorBalance(vendorId: string): Promise<number> {
    const entries = await prisma.vendorLedger.findMany({
      where: { vendorId },
      select: { type: true, amount: true }
    });
    return entries.reduce((acc, e) => acc + (e.type === 'CREDIT' ? e.amount : -e.amount), 0);
  }

  static async createPurchaseOrder(data: {
    vendorId: string;
    advancePaid?: number;
    expectedDeliveryDate?: string;
    notes?: string;
    items: Array<{ inventoryItemId: string; quantity: number; price: number }>;
  }) {
    const poItemsData = await Promise.all(data.items.map(async (item) => {
      const inventoryItem = await prisma.inventoryItem.findUnique({
        where: { id: item.inventoryItemId }
      });
      const gstRate = inventoryItem?.gstRate || 5;
      const subtotal = item.quantity * item.price;
      const gstAmount = (subtotal * gstRate) / 100;
      const cgst = gstAmount / 2;
      const sgst = gstAmount / 2;
      
      return {
        ...item,
        gstRate,
        subtotal,
        cgst,
        sgst,
        igst: 0,
        total: subtotal + gstAmount
      };
    }));

    const totalSubtotal = poItemsData.reduce((acc, item) => acc + item.subtotal, 0);
    const totalCGST = poItemsData.reduce((acc, item) => acc + item.cgst, 0);
    const totalSGST = poItemsData.reduce((acc, item) => acc + item.sgst, 0);
    const totalIGST = poItemsData.reduce((acc, item) => acc + item.igst, 0);
    const totalAmount = totalSubtotal + totalCGST + totalSGST + totalIGST;

    const ledgerBalance = await this.getVendorBalance(data.vendorId);
    const existingCredit = Math.max(0, ledgerBalance); 
    const autoApplied = Math.min(totalAmount, existingCredit);
    const providedAmount = data.advancePaid || 0;
    const finalPaidOnPO = Math.max(autoApplied, providedAmount);
    const newMoneyPayment = Math.max(0, providedAmount - existingCredit);

    const result = await prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      const count = await tx.procurementOrder.count();
      const poNumber = `PO-${year}-${(count + 1).toString().padStart(4, '0')}`;

      const po = await tx.procurementOrder.create({
        data: {
          poNumber,
          vendorId: data.vendorId,
          subtotal: totalSubtotal,
          cgst: totalCGST,
          sgst: totalSGST,
          igst: totalIGST,
          totalAmount,
          advancePaid: finalPaidOnPO,
          paid: finalPaidOnPO,
          balance: totalAmount - finalPaidOnPO,
          expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : null,
          notes: data.notes,
          status: 'PENDING',
          poItems: {
            create: poItemsData.map((item) => ({
              inventoryItemId: item.inventoryItemId,
              gstRate: item.gstRate,
              quantity: item.quantity,
              price: item.price,
              subtotal: item.subtotal,
              cgst: item.cgst,
              sgst: item.sgst,
              igst: item.igst,
              total: item.total
            }))
          }
        },
        include: { poItems: { include: { inventoryItem: true } }, vendor: true }
      });

      await tx.vendorLedger.create({
        data: {
          vendorId: data.vendorId,
          type: 'DEBIT',
          amount: totalAmount,
          paymentMode: 'CASH',
          referenceType: 'PO',
          referenceId: po.id,
          note: `Purchase Order #${po.poNumber} — Total: ₹${totalAmount.toLocaleString('en-IN')}`
        }
      });

      if (newMoneyPayment > 0) {
        await tx.vendorLedger.create({
          data: {
            vendorId: data.vendorId,
            type: 'CREDIT',
            amount: newMoneyPayment,
            paymentMode: 'CASH',
            referenceType: 'ADVANCE',
            referenceId: po.id,
            note: `Advance Payment with PO #${po.poNumber}`
          }
        });
      }
      return po;
    });

    for (const item of data.items) {
      await this.linkMaterialToVendor(data.vendorId, item.inventoryItemId, item.price);
    }
    return result;
  }

  static async linkMaterialToVendor(vendorId: string, materialId: string, price?: number) {
    await prisma.vendorMaterial.upsert({
      where: { vendorId_materialId: { vendorId, materialId } },
      update: { price, lastUpdated: new Date() },
      create: { vendorId, materialId, price }
    });
    return prisma.inventoryItem.update({
      where: { id: materialId },
      data: { vendorId }
    });
  }

  static async recordAdvancePayment(poId: string, advancePaid: number) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'CANCELLED') throw new Error('Cannot record advance on a cancelled PO');

      await tx.vendorLedger.create({
        data: {
          vendorId: po.vendorId,
          type: 'CREDIT',
          amount: advancePaid,
          paymentMode: 'CASH',
          referenceType: 'ADVANCE',
          referenceId: po.id,
          note: `Advance Payment for PO #${po.poNumber || po.id.substring(0, 8)}`
        }
      });

      const newAdvancePaid = Math.min(po.totalAmount, po.advancePaid + advancePaid);
      return tx.procurementOrder.update({
        where: { id: poId },
        data: { advancePaid: newAdvancePaid },
        include: { poItems: { include: { inventoryItem: true } }, vendor: true }
      });
    });
  }

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

  static async applyAdvanceToPO(poId: string) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({
        where: { id: poId },
        include: { vendor: true }
      });
      if (!po) throw new Error('Purchase Order not found');

      const balance = await this.getVendorBalance(po.vendorId);
      if (balance <= 0) {
        throw new Error(`Vendor ${po.vendor.name} has no available advance balance (Current: ₹${balance})`);
      }

      const remainingDue = po.totalAmount - po.advancePaid;
      if (remainingDue <= 0) throw new Error('This Purchase Order is already fully paid.');

      const amountToApply = Math.min(remainingDue, balance);
      const newPaid = po.paid + amountToApply;

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { 
          paid: newPaid,
          balance: po.totalAmount - newPaid,
          status: (po.totalAmount - newPaid <= 0 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
        },
        include: { vendor: true, poItems: { include: { inventoryItem: true } } }
      });
    });
  }

  static async getPurchaseOrders() {
    const orders = await prisma.procurementOrder.findMany({
      include: { vendor: true, poItems: { include: { inventoryItem: true } }, goodsReceipts: true },
      orderBy: { createdAt: 'desc' }
    });
    const vendorIds = Array.from(new Set(orders.map(o => o.vendorId)));
    const allLedger = await prisma.vendorLedger.findMany({
      where: { vendorId: { in: vendorIds } }
    });
    return orders.map((po) => {
      const linkedPayments = allLedger
        .filter(l => l.referenceId === po.id && l.type === 'CREDIT')
        .reduce((sum, l) => sum + l.amount, 0);
      const livePaid = Math.max(po.paid || 0, linkedPayments);
      return {
        ...po,
        paid: livePaid,
        balanceDue: Math.max(0, Number((po.totalAmount - livePaid).toFixed(2)))
      };
    });
  }

  static async getPurchaseOrderById(id: string) {
    return prisma.procurementOrder.findUnique({
      where: { id },
      include: { vendor: true, poItems: { include: { inventoryItem: true } }, goodsReceipts: true }
    });
  }

  static async cancelPO(poId: string) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'RECEIVED') throw new Error('Cannot cancel a received PO');
      if (po.status === 'CANCELLED') throw new Error('PO is already cancelled');

      await tx.vendorLedger.create({
        data: {
          vendorId: po.vendorId,
          type: 'CREDIT',
          amount: po.totalAmount,
          paymentMode: 'CASH',
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

  static async deletePO(poId: string) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'RECEIVED') throw new Error('Cannot delete a received PO');

      if (po.status === 'PENDING') {
        await tx.vendorLedger.create({
          data: {
            vendorId: po.vendorId,
            type: 'CREDIT',
            amount: po.totalAmount,
            paymentMode: 'CASH',
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
      const po = await tx.procurementOrder.findUnique({
        where: { id: poId },
        include: { poItems: true }
      });
      if (!po) throw new Error('Purchase Order not found');
      if (po.received) throw new Error('Goods already received for this PO');

      for (const item of po.poItems) {
        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PURCHASE_IN',
          quantity: item.quantity,
          referenceType: 'PROCUREMENT_ORDER',
          referenceId: po.id,
          note: `GRN for PO ${po.poNumber || po.id.substring(0, 8)}`
        });
        await tx.inventoryItem.update({
          where: { id: item.inventoryItemId },
          data: { vendorId: po.vendorId }
        });
      }

      await tx.goodsReceipt.create({
        data: {
          poId: po.id,
          status: 'COMPLETED',
          items: {
            create: po.poItems.map((item) => ({
              materialId: item.inventoryItemId,
              quantity: item.quantity,
              receivedQty: item.quantity,
              acceptedQty: item.quantity,
              rejectedQty: 0,
              price: item.price
            }))
          }
        }
      });

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { status: 'RECEIVED', received: true },
        include: { poItems: true, goodsReceipts: true }
      });
    });

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
      if (filters.materialId) {
        if (!v.suppliedMaterials.some((m: any) => m.materialId === filters.materialId)) return false;
      }
      if (filters.balanceType === 'ADVANCE' && v.balance <= 0) return false;
      if (filters.balanceType === 'OWED' && v.balance >= 0) return false;
      if (filters.minPrice || filters.maxPrice) {
        const match = v.suppliedMaterials.some((m: any) => {
          if (filters.minPrice && (m.price || 0) < Number(filters.minPrice)) return false;
          if (filters.maxPrice && (m.price || 0) > Number(filters.maxPrice)) return false;
          return true;
        });
        if (!match) return false;
      }
      return true;
    });
  }

  static async getVendorsSummary() {
    const vendors = await this.getVendors();
    const totalAdvance = vendors.reduce((s, v) => s + (v.advance || 0), 0);
    const totalDue = vendors.reduce((s, v) => s + (v.due || 0), 0);
    const totalPurchased = vendors.reduce((s, v) => s + (v.totalPurchased || 0), 0);
    return { 
      totalVendors: vendors.length, 
      totalOwed: totalDue, 
      totalAdvance, 
      totalMaterials: await prisma.vendorMaterial.count(),
      totalPurchased
    };
  }

  static async getVendorLedger(vendorId: string, _filters: any = {}) {
    const ledger = await prisma.vendorLedger.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' }
    });
    let runningBalance = 0;
    return ledger.map(entry => {
      runningBalance += (entry.type === 'CREDIT' ? entry.amount : -entry.amount);
      return { ...entry, runningBalance };
    }).reverse();
  }

  static async recordPayment(vendorId: string, data: { amount: number; note: string; paymentMode?: any; referenceId?: string }) {
    const { amount, note, paymentMode, referenceId } = data;
    let resolvedNote = note;
    if (!resolvedNote && referenceId) {
      const po = await prisma.procurementOrder.findUnique({ where: { id: referenceId } });
      resolvedNote = po?.poNumber ? `Payment for PO #${po.poNumber}` : `Payment for PO #${referenceId.substring(0, 8)}`;
    }
    const payment = await prisma.vendorLedger.create({
      data: {
        vendorId,
        type: 'CREDIT',
        amount,
        paymentMode: paymentMode || 'CASH',
        referenceType: 'PAYMENT',
        referenceId,
        note: resolvedNote || 'Direct Payment'
      }
    });
    if (referenceId) {
      const po = await prisma.procurementOrder.findUnique({ where: { id: referenceId } });
      if (po) {
        const newPaid = (po.paid || 0) + Math.min(amount, po.totalAmount - (po.paid || 0));
        await prisma.procurementOrder.update({
          where: { id: referenceId },
          data: {
            paid: newPaid,
            balance: Math.max(0, Number((po.totalAmount - newPaid).toFixed(2))),
            status: (po.totalAmount - newPaid <= 0.01 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
          }
        });
      }
    } else {
      await this.settleVendorOrders(vendorId);
    }
    return payment;
  }

  static async settleVendorOrders(vendorId: string) {
    return prisma.$transaction(async (tx) => {
      const vendors = await this.getVendors();
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor || (vendor.balance || 0) <= 0) return;
      let availableAdvance = vendor.balance;
      const outstandingOrders = await tx.procurementOrder.findMany({
        where: { vendorId, status: { in: ['APPROVED', 'RECEIVED'] } },
        orderBy: { createdAt: 'asc' }
      });
      for (const po of outstandingOrders) {
        if (availableAdvance <= 0) break;
        const currentPaid = po.paid || po.advancePaid || 0;
        const remainingDue = Math.max(0, po.totalAmount - currentPaid);
        if (remainingDue > 0) {
          const amountToApply = Math.min(remainingDue, availableAdvance);
          const newPaid = currentPaid + amountToApply;
          await tx.procurementOrder.update({
            where: { id: po.id },
            data: {
              paid: newPaid,
              balance: po.totalAmount - newPaid,
              status: (po.totalAmount - newPaid <= 0 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
            }
          });
          availableAdvance -= amountToApply;
        }
      }
    });
  }

  static async recordAdjustment(vendorId: string, amount: number, type: 'CREDIT' | 'DEBIT', note: string, referenceType: any = 'ADJUSTMENT', referenceId?: string) {
    return prisma.vendorLedger.create({
      data: {
          vendorId,
          type,
          amount,
          paymentMode: 'CASH',
          referenceType,
          referenceId,
          note: note || 'Manual Ledger Adjustment'
      }
    });
  }
}
