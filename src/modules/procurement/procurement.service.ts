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
      // MASTER ACCOUNTING FORMULA (Optimized for correctness)
      // 1. Total Paid (Actual money out - actual money back)
      const totalPayments = v.ledgerEntries
        .filter(e => e.type === 'CREDIT' && e.referenceType === 'PAYMENT')
        .reduce((s, e) => s + e.amount, 0);

      const totalReturns = v.ledgerEntries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'RETURN')
        .reduce((s, e) => s + e.amount, 0);

      // 2. Total Purchases (PO Obligations)
      const totalPurchased = v.ledgerEntries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'PO')
        .reduce((s, e) => s + e.amount, 0);
      
      // 3. Adjustments / Advances (Manual adjustments)
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
    // 1. Fetch item details for GST calculation
    const poItemsData = await Promise.all(data.items.map(async (item) => {
      const inventoryItem = await prisma.inventoryItem.findUnique({
        where: { id: item.inventoryItemId }
      });
      const gstRate = inventoryItem?.gstRate || 5;
      const subtotal = item.quantity * item.price;
      const gstAmount = (subtotal * gstRate) / 100;
      
      // Simple logic: If inside the same state (mocked as CGST/SGST), else IGST
      // For now, split 50/50 for CGST/SGST as default
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

    // 2. Fetch current balance (Purchased - Paid)
    // Here we use the Ledger balance to see if they have existing credits
    const ledgerBalance = await this.getVendorBalance(data.vendorId);
    // Negative balance in old logic meant "We Owe", but here we want to know if they have ADVANCE
    // Let's stick to getVendorBalance meaning (Paid - Purchased) for internal check
    const existingCredit = Math.max(0, ledgerBalance); 
    
    // 3. Determine how much advance to mark on this PO
    const autoApplied = Math.min(totalAmount, existingCredit);
    const providedAmount = data.advancePaid || 0;
    const finalPaidOnPO = Math.max(autoApplied, providedAmount);
    const newMoneyPayment = Math.max(0, providedAmount - existingCredit);

    const result = await prisma.$transaction(async (tx) => {
      // Generate PO Number
      const year = new Date().getFullYear();
      const count = await tx.procurementOrder.count();
      const poNumber = `PO-${year}-${(count + 1).toString().padStart(4, '0')}`;

      // 1. Create the PO with GST fields
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

      // 2. Create Ledger DEBIT for total PO amount
      await tx.vendorLedger.create({
        data: {
          vendorId: data.vendorId,
          type: 'DEBIT',
          amount: totalAmount,
          referenceType: 'PO',
          referenceId: po.id,
          note: `Purchase Order #${po.poNumber} — Total: ₹${totalAmount.toLocaleString('en-IN')}`
        }
      });

      // 3. Record NEW CREDIT if money provided
      if (newMoneyPayment > 0) {
        await tx.vendorLedger.create({
          data: {
            vendorId: data.vendorId,
            type: 'CREDIT',
            amount: newMoneyPayment,
            referenceType: 'ADVANCE',
            referenceId: po.id,
            note: `Advance Payment with PO #${po.poNumber}`
          }
        });
      }

      return po;
    });

    // Link materials to vendor (ensure consistency)
    for (const item of data.items) {
      await this.linkMaterialToVendor(data.vendorId, item.inventoryItemId, item.price);
    }

    return result;
  }

  static async linkMaterialToVendor(vendorId: string, materialId: string, price?: number) {
    // 1. Update the cross-reference join table
    await prisma.vendorMaterial.upsert({
      where: { vendorId_materialId: { vendorId, materialId } },
      update: { price, lastUpdated: new Date() },
      create: { vendorId, materialId, price }
    });

    // 2. Set the primary vendorId on the material if not already set or updated
    return prisma.inventoryItem.update({
      where: { id: materialId },
      data: { vendorId }
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
          note: `Advance Payment for PO #${po.poNumber || po.id.substring(0, 8)}`
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

  /**
   * Apply available vendor credit balance to an existing PO.
   * This is useful for clearing "Balance Due" using funds already in the ledger.
   */
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
      if (remainingDue <= 0) {
        throw new Error('This Purchase Order is already fully paid.');
      }

      const amountToApply = Math.min(remainingDue, balance);
      const newPaid = po.paid + amountToApply;

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { 
          paid: newPaid,
          balance: po.totalAmount - newPaid,
          // If fully paid and received, mark as CLOSED
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

    // 1. Get ALL ledger entries for these vendors to calculate LIVE paid amounts
    const vendorIds = Array.from(new Set(orders.map(o => o.vendorId)));
    const allLedger = await prisma.vendorLedger.findMany({
      where: { vendorId: { in: vendorIds } }
    });

    return orders.map((po) => {
      // 2. Calculate Paid amount: (Explicitly linked) + (Share of auto-settled balance from 'po.paid' field)
      // Note: 'po.paid' is maintained by our auto-settlement engine in recordPayment() and settleVendorOrders()
      const linkedPayments = allLedger
        .filter(l => l.referenceId === po.id && l.type === 'CREDIT')
        .reduce((sum, l) => sum + l.amount, 0);

      // 3. Fallback to 'po.paid' which captures auto-distributed advance credits
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
        await InventoryService.recordMovement(tx, {
          itemId: item.inventoryItemId,
          type: 'PURCHASE_IN',
          quantity: item.quantity,
          referenceType: 'PROCUREMENT_ORDER',
          referenceId: po.id,
          note: `GRN for PO ${po.poNumber || po.id.substring(0, 8)}`
        });

        // Link material to vendor
        await tx.inventoryItem.update({
          where: { id: item.inventoryItemId },
          data: { vendorId: po.vendorId }
        });
      }

      // 3. Create Goods Receipt record with items for audit
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
    
    // totalAdvance = sum(all vendor advances)
    // totalDue = sum(all vendor dues)
    // totalPurchased = sum(all vendor purchases)
    const totalAdvance = vendors.reduce((s, v) => s + (v.advance || 0), 0);
    const totalDue = vendors.reduce((s, v) => s + (v.due || 0), 0);
    const totalPurchased = vendors.reduce((s, v) => s + (v.totalPurchased || 0), 0);
    
    const totalVendors = vendors.length;
    const totalMaterials = await prisma.vendorMaterial.count();

    return { 
      totalVendors, 
      totalOwed: totalDue, 
      totalAdvance, 
      totalMaterials,
      totalPurchased
    };
  }

  /**
   * Ledger Operations
   */
  static async getVendorLedger(vendorId: string, _filters: any = {}) {
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

  static async recordPayment(vendorId: string, amount: number, note: string, referenceId?: string) {
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
        referenceType: 'PAYMENT',
        referenceId,
        note: resolvedNote || 'Direct Payment'
      }
    });

    // Auto-settlement logic: If it's a direct payment, apply to oldest ones.
    // If it's linked to a PO, update that PO specifically.
    if (referenceId) {
      const po = await prisma.procurementOrder.findUnique({ where: { id: referenceId } });
      if (po) {
        const remainingToPay = po.totalAmount - (po.paid || 0);
        const allocation = Math.min(amount, remainingToPay);
        const newPaid = (po.paid || 0) + allocation;
        
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

  /**
   * Internal helper to automatically apply unallocated credits to outstanding POs (Oldest first)
   */
  static async settleVendorOrders(vendorId: string) {
    return prisma.$transaction(async (tx) => {
      // 1. Get vendor's available unallocated advance
      const vendors = await this.getVendors();
      const vendor = vendors.find(v => v.id === vendorId);
      if (!vendor || (vendor.balance || 0) <= 0) return; // No advance to apply

      let availableAdvance = vendor.balance;

      // 2. Get all non-closed orders that owe money (Oldest first)
      const outstandingOrders = await tx.procurementOrder.findMany({
        where: {
          vendorId,
          status: { in: ['APPROVED', 'RECEIVED'] },
        },
        orderBy: { createdAt: 'asc' }
      });

      for (const po of outstandingOrders) {
        if (availableAdvance <= 0) break;

        const currentPaid = po.paid || po.advancePaid || 0;
        const totalDue = po.totalAmount;
        const remainingDue = Math.max(0, totalDue - currentPaid);

        if (remainingDue > 0) {
          const amountToApply = Math.min(remainingDue, availableAdvance);
          const newPaid = currentPaid + amountToApply;

          await tx.procurementOrder.update({
            where: { id: po.id },
            data: {
              paid: newPaid,
              balance: totalDue - newPaid,
              status: (totalDue - newPaid <= 0 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
            }
          });

          availableAdvance -= amountToApply;
        }
      }
    });
  }

  static async recordAdjustment(vendorId: string, amount: number, type: 'CREDIT' | 'DEBIT', note: string, referenceType: any = 'ADJUSTMENT') {
    return prisma.vendorLedger.create({
      data: {
        vendorId,
        type,
        amount,
        referenceType,
        note: note || 'Manual Ledger Adjustment'
      }
    });
  }
}
