import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FinanceService } from '../finance/finance.service';
import { AccountService } from '../finance/account.service';

export class ProcurementService {
  /**
   * Create a new vendor/supplier
   */
  static async createVendor(data: { 
    name: string; 
    contact: string; 
    email?: string; 
    address?: string; 
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstType?: string;
    openingBalance?: number;
    asOfDate?: string;
    creditLimit?: number;
    remark?: string;
    gstNumber?: string;
    category?: string;
    paymentTerms?: any;
    status?: any;
  }) {
    // 1. Name Validation (Relaxed)
    if (!data.name || !/^[A-Za-z0-9\s&.,\-()]+$/.test(data.name)) {
      throw new Error("Vendor Name is required and must be alphanumeric (symbols like & . , - () are allowed).");
    }

    // 2. Contact Validation (Exactly 10 Numbers)
    if (!data.contact || !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be exactly 10 digits.");
    }

    // 3. Email Validation (Relaxed)
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw new Error("Invalid email format for vendor.");
    }

    // 4. Address Validation (Mandatory)
    if (!data.address || data.address.trim().length === 0) {
      throw new Error("Registered Office Address is a mandatory field.");
    }

    // ROBUST CODE GENERATION (Find max to prevent collisions)
    const lastVendor = await prisma.vendor.findFirst({
      orderBy: { vendorCode: 'desc' },
      select: { vendorCode: true }
    });

    let nextNum = 1;
    if (lastVendor?.vendorCode) {
      const match = lastVendor.vendorCode.match(/\d+/);
      if (match) nextNum = parseInt(match[0]) + 1;
    }
    
    const vendorCode = `V-${nextNum.toString().padStart(4, '0')}`;

    try {
      return await prisma.$transaction(async (tx) => {
        const vendor = await tx.vendor.create({
          data: {
            vendorCode,
            name: data.name,
            contact: data.contact,
            email: data.email,
            address: data.address,
            state: data.state,
            district: data.district,
            city: data.city,
            pincode: data.pincode,
            shippingAddress: data.shippingAddress,
            gstType: data.gstType,
            openingBalance: data.openingBalance || 0,
            asOfDate: data.asOfDate ? new Date(data.asOfDate) : null,
            creditLimit: data.creditLimit,
            remark: data.remark,
            gstNumber: data.gstNumber,
            category: data.category,
            paymentTerms: data.paymentTerms || 'IMMEDIATE',
            status: data.status || 'ACTIVE'
          }
        });

        // Generate opening balance ledger entry if applicable
        if (data.openingBalance && data.openingBalance > 0) {
          await tx.vendorLedger.create({
            data: {
              vendorId: vendor.id,
              type: 'CREDIT', // Opening balance = we owe the vendor
              amount: data.openingBalance,
              balanceAfterTransaction: data.openingBalance,
              referenceType: 'OPENING_BALANCE',
              paymentMode: 'CASH',
              note: 'Opening Balance'
            }
          });
        }

        return vendor;
      });
    } catch (err: any) {
      console.error('[ProcurementService] createVendor Error:', err);
      throw new Error(`Database Error: ${err.message}`);
    }
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

    return Promise.all(vendors.map(async (v) => {
      // MASTER ACCOUNTING FORMULA
      let entries = v.ledgerEntries || [];
      
      // AUTO-REPAIR: If openingBalance exists but no ledger entry exists, inject it!
      const hasOpeningBalanceEntry = entries.some(e => e.referenceType === 'OPENING_BALANCE');
      if (!hasOpeningBalanceEntry && v.openingBalance !== 0) {
        const type = v.openingBalance > 0 ? 'CREDIT' : 'DEBIT'; // CREDIT = We owe them
        const amount = Math.abs(v.openingBalance);
        
        // Create the missing entry in the database permanently
        const newEntry = await prisma.vendorLedger.create({
          data: {
            vendorId: v.id,
            type,
            amount,
            balanceAfterTransaction: amount,
            referenceType: 'OPENING_BALANCE',
            paymentMode: 'CASH',
            note: 'Opening Balance (Auto-Repaired)',
            createdAt: new Date('2000-01-01')
          }
        });
        
        // Append it to our local array so the math below is correct immediately
        entries.push(newEntry as any);
      }
      
      const totalPayments = entries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'PAYMENT')
        .reduce((s, e) => s + (e.amount || 0), 0);

      const totalReturns = entries
        .filter(e => e.type === 'DEBIT' && e.referenceType === 'RETURN')
        .reduce((s, e) => s + (e.amount || 0), 0);

      const totalPurchased = entries
        .filter(e => e.type === 'CREDIT' && e.referenceType === 'PURCHASE')
        .reduce((s, e) => s + (e.amount || 0), 0);
      
      const manualCredits = entries
        .filter(e => e.type === 'CREDIT' && (e.referenceType === 'ADJUSTMENT' || e.referenceType === 'OPENING_BALANCE'))
        .reduce((s, e) => s + (e.amount || 0), 0);
      
      const manualDebits = entries
        .filter(e => e.type === 'DEBIT' && (e.referenceType === 'ADJUSTMENT' || e.referenceType === 'ADVANCE'))
        .reduce((s, e) => s + (e.amount || 0), 0);

      const totalOwedByUs = totalPurchased + manualCredits; 
      const totalPaidToThem = totalPayments + totalReturns + manualDebits;
      
      const balance = totalOwedByUs - totalPaidToThem; // Positive = We owe them (To Pay), Negative = They owe us (Advance)

      return {
        ...v,
        totalPurchased: totalOwedByUs,
        totalPaid: totalPaidToThem, 
        balance: balance,
        due: balance > 0 ? balance : 0,         // We owe them
        advance: balance < 0 ? Math.abs(balance) : 0, // They owe us
        lastOrderDate: v.orders?.[0]?.createdAt || null
      };
    }));
  }

  static async getVendorById(id: string) {
    return prisma.vendor.findUnique({
      where: { id },
      include: { 
        orders: { 
          include: { 
            poItems: { include: { inventoryItem: true } },
            goodsReceipts: { include: { items: { include: { inventoryItem: true } } } },
            invoices: true
          }, 
          orderBy: { createdAt: 'desc' }, 
          take: 20
        },
        suppliedMaterials: { include: { material: true } },
        invoices: true,
        _count: { select: { orders: true } } 
      }
    });
  }

  static async getVendorFinancials(vendorId: string) {
    const entries = await prisma.vendorLedger.findMany({
      where: { vendorId },
      select: { type: true, amount: true }
    });

    const totalPaid = entries.filter(e => e.type === 'DEBIT').reduce((s, e) => s + e.amount, 0);
    const totalLiability = entries.filter(e => e.type === 'CREDIT').reduce((s, e) => s + e.amount, 0);
    const balance = totalLiability - totalPaid;

    return { totalPaid, totalLiability, balance };
  }

  static async updateVendor(id: string, data: { 
    name?: string; 
    contact?: string; 
    email?: string; 
    address?: string; 
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstType?: string;
    openingBalance?: number;
    asOfDate?: string;
    creditLimit?: number;
    remark?: string; 
    rating?: number; 
    gstNumber?: string;
    category?: string;
    paymentTerms?: any;
    status?: any;
  }) {
    if (data.name !== undefined && !/^[A-Za-z0-9\s&.,\-()]+$/.test(data.name)) {
      throw new Error("Vendor Name must be alphanumeric (symbols like & . , - () are allowed).");
    }
    if (data.contact !== undefined && !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be exactly 10 digits.");
    }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw new Error("Invalid email format.");
    }
    if (data.address !== undefined && data.address.trim().length === 0) {
      throw new Error("Registered Office Address cannot be empty.");
    }
    
    const updateData: any = { ...data };
    if (data.asOfDate) updateData.asOfDate = new Date(data.asOfDate);
    
    // Remove properties that are not part of the Prisma schema
    delete updateData.openingBalanceType;
    
    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.update({ where: { id }, data: updateData });

      // Synchronize Opening Balance Ledger Entry if it's set
      if (data.openingBalance !== undefined) {
        const existingEntry = await tx.vendorLedger.findFirst({
          where: { vendorId: id, referenceType: 'OPENING_BALANCE' }
        });

        const amount = Math.abs(data.openingBalance);
        const type = data.openingBalance >= 0 ? 'CREDIT' : 'DEBIT'; // Credit = we owe them (To Pay)

        if (existingEntry) {
          if (amount === 0) {
            await tx.vendorLedger.delete({ where: { id: existingEntry.id } });
          } else {
            await tx.vendorLedger.update({
              where: { id: existingEntry.id },
              data: { amount, type, balanceAfterTransaction: amount }
            });
          }
        } else if (amount > 0) {
          await tx.vendorLedger.create({
            data: {
              vendorId: id,
              type,
              amount,
              balanceAfterTransaction: amount,
              referenceType: 'OPENING_BALANCE',
              paymentMode: 'CASH',
              note: 'Opening Balance',
              createdAt: new Date('2000-01-01')
            }
          });
        }

        // Recalculate subsequent balances if needed
        // (For simplicity, the running balances are usually fetched live via getVendors calculation, 
        // but to ensure the UI ledger is perfect, we can leave it to the UI or run a migration. 
        // We update the entry's amount which fixes the getVendors calculation.)
      }
      return vendor;
    });
  }

  static async deleteVendor(id: string) {
    const financials = await this.getVendorFinancials(id);
    if (Math.abs(financials.balance) > 0.01) {
      throw new Error(`Cannot delete vendor with non-zero balance (₹${financials.balance.toLocaleString()})`);
    }

    const pendingOrders = await prisma.procurementOrder.count({
      where: { vendorId: id, status: 'PENDING_APPROVAL' }
    });
    if (pendingOrders > 0) {
      throw new Error("Cannot delete vendor with pending Purchase Orders.");
    }

    // ERP Soft Delete: Set status to INACTIVE instead of removing records
    return prisma.vendor.update({
      where: { id },
      data: { status: 'INACTIVE' }
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
    franchiseId?: string;
    advancePaid?: number;
    accountId?: string; // Source account for advance
    expectedDeliveryDate?: string;
    notes?: string;
    internalNotes?: string;
    vendorNotes?: string;
    deliveryInstructions?: string;
    status?: string;
    items: Array<{ inventoryItemId: string; quantity: number; price: number }>;
    manualTax?: { cgst: number, sgst: number, igst: number };
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
        itemName: inventoryItem?.name || "Unknown Material",
        gstRate,
        subtotal,
        cgst,
        sgst,
        igst: 0,
        total: subtotal + gstAmount
      };
    }));

    const totalSubtotal = poItemsData.reduce((acc, item) => acc + item.subtotal, 0);
    const totalCGST = data.manualTax ? data.manualTax.cgst : poItemsData.reduce((acc, item) => acc + item.cgst, 0);
    const totalSGST = data.manualTax ? data.manualTax.sgst : poItemsData.reduce((acc, item) => acc + item.sgst, 0);
    const totalIGST = data.manualTax ? data.manualTax.igst : poItemsData.reduce((acc, item) => acc + item.igst, 0);
    const totalAmount = totalSubtotal + totalCGST + totalSGST + totalIGST;

    const ledgerBalance = await this.getVendorBalance(data.vendorId);
    const existingCredit = Math.max(0, ledgerBalance); 
    const providedAmount = data.advancePaid || 0;
    // const finalPaidOnPO = Math.max(autoApplied, providedAmount);
    const newMoneyPayment = Math.max(0, providedAmount - existingCredit);

    const result = await prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      const count = await tx.procurementOrder.count();
      const poNumber = `PO-${year}-${(count + 1).toString().padStart(4, '0')}`;

      const po = await tx.procurementOrder.create({
        data: {
          poNumber,
          vendorId: data.vendorId,
          franchiseId: data.franchiseId || null,
          subtotal: totalSubtotal,
          cgst: totalCGST,
          sgst: totalSGST,
          igst: totalIGST,
          totalAmount,
          advancePaid: providedAmount, // Real money provided
          paid: providedAmount,
          balance: totalAmount - providedAmount,
          expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : null,
          notes: data.notes,
          internalNotes: data.internalNotes,
          vendorNotes: data.vendorNotes,
          deliveryInstructions: data.deliveryInstructions,
          status: (data.status as any) || 'PENDING_APPROVAL',
          poItems: {
            create: poItemsData.map((item) => ({
              inventoryItemId: item.inventoryItemId,
              itemName: item.itemName,
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

      // NO LEDGER ENTRY ON PO CREATION (Wait for GRN)
      // BUT Advance Payment hits Ledger and Account
      if (newMoneyPayment > 0) {
        if (!data.accountId) throw new Error('Source Account ID is required for advance payment.');

        // 1. Central Payment + Account Update
        await FinanceService.createPayment({
          tx,
          amount: newMoneyPayment,
          flow: 'OUT',
          status: 'PAID',
          sourceAccount: data.accountId,
          method: 'CASH',
          sourceModule: 'PROCUREMENT',
          linkedDocType: 'PO',
          linkedDocId: po.poNumber,
          entityType: 'VENDOR',
          entityId: data.vendorId,
          createdBy: 'SYSTEM_PO'
        });

        // 2. Vendor Ledger Entry
        const nextBalance = await this.getNextBalance(tx, data.vendorId, newMoneyPayment, 'CREDIT');
        await tx.vendorLedger.create({
          data: {
            vendorId: data.vendorId,
            type: 'CREDIT',
            amount: newMoneyPayment,
            balanceAfterTransaction: nextBalance,
            paymentMode: 'CASH',
            sourceModule: 'PROCUREMENT',
            referenceType: 'ADVANCE',
            referenceId: po.id,
            accountId: data.accountId,
            note: `Advance Payment for PO #${po.poNumber}`
          }
        });

        // Track Money Movement
        await AccountService.adjustBalance(tx, data.accountId, newMoneyPayment, 'OUTFLOW');

        // Also record as a Payment entity for audit
        await tx.payment.create({
          data: {
            type: 'ADVANCE',
            entityType: 'VENDOR',
            entityId: data.vendorId,
            paidAmount: newMoneyPayment,
            accountId: data.accountId,
            transactionRef: po.id,
            status: 'SUCCESS'
          }
        });
      }
      // TRANSACTION SAFETY: Material linking must be inside the transaction
      for (const item of data.items) {
        await tx.vendorMaterial.upsert({
          where: { vendorId_materialId: { vendorId: data.vendorId, materialId: item.inventoryItemId } },
          update: { price: item.price, lastUpdated: new Date() },
          create: { vendorId: data.vendorId, materialId: item.inventoryItemId, price: item.price }
        });
        await tx.inventoryItem.update({
          where: { id: item.inventoryItemId },
          data: { vendorId: data.vendorId }
        });
      }

      return po;
    });

    return result;
  }

  static async linkMaterialToVendor(vendorId: string, materialId: string, price?: number, quantity?: number) {
    await prisma.vendorMaterial.upsert({
      where: { vendorId_materialId: { vendorId, materialId } },
      update: { price, quantity, lastUpdated: new Date() },
      create: { vendorId, materialId, price, quantity }
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
    return this.updatePOStatus(poId, 'APPROVED');
  }

  static async updatePOStatus(poId: string, status: any) {
    const po = await prisma.procurementOrder.findUnique({ where: { id: poId } });
    if (!po) throw new Error('Purchase Order not found');
    
    const updateData: any = { status };
    if (status === 'APPROVED') {
      updateData.approvedAt = new Date();
      updateData.approvedBy = 'SUPER_ADMIN'; 
    }

    return prisma.procurementOrder.update({
      where: { id: poId },
      data: updateData,
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
      include: { 
        vendor: true, 
        poItems: { include: { inventoryItem: true } }, 
        goodsReceipts: { include: { items: true } } 
      },
      orderBy: { createdAt: 'desc' }
    });
    const vendorIds = Array.from(new Set(orders.map(o => o.vendorId)));
    const allLedger = await prisma.vendorLedger.findMany({
      where: { vendorId: { in: vendorIds } }
    });
    return orders.map((po: any) => {
      const linkedPayments = allLedger
        .filter(l => l.referenceId === po.id && l.type === 'CREDIT')
        .reduce((sum, l) => sum + l.amount, 0);
      const livePaid = Math.max(po.paid || 0, linkedPayments);

      // Calculate fulfillment stats (Support both structured poItems and legacy JSON items)
      let totalItemsCount = 0;
      if (po.poItems && po.poItems.length > 0) {
        totalItemsCount = po.poItems.reduce((sum: number, item: any) => sum + (item.quantity || 0), 0);
      } else if (Array.isArray(po.items)) {
        totalItemsCount = po.items.reduce((sum: number, item: any) => sum + (Number(item.quantity) || 0), 0);
      }

      const receivedItemsCount = (po.goodsReceipts || []).reduce((sum: number, grn: any) => {
        const grnTotal = (grn.items || []).reduce((s: number, i: any) => s + (i.receivedQty || 0), 0);
        return sum + grnTotal;
      }, 0);

      return {
        ...po,
        paid: livePaid,
        balanceDue: Math.max(0, Number((po.totalAmount - livePaid).toFixed(2))),
        totalItemsCount,
        receivedItemsCount
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

      if (po.status === 'PENDING_APPROVAL') {
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
        if (!item.inventoryItemId) continue;
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

      // FINANCIAL TRIGGER: Recognize liability on Receipt
      const totalValue = po.poItems.reduce((acc, it) => acc + (it.quantity * it.price), 0);
      
      // Calculate tax factor from PO totals
      const taxFactor = po.subtotal > 0 ? po.totalAmount / po.subtotal : 1;
      const totalWithTax = totalValue * taxFactor;

      if (totalWithTax > 0) {
        const lastEntry = await tx.vendorLedger.findFirst({
          where: { vendorId: po.vendorId },
          orderBy: { createdAt: 'desc' }
        });
        const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;

        await tx.vendorLedger.create({
          data: {
            vendorId: po.vendorId,
            type: 'CREDIT', // Liability increases
            amount: totalWithTax,
            balanceAfterTransaction: currentBalance + totalWithTax,
            paymentMode: 'CASH',
            sourceModule: 'PROCUREMENT',
            referenceType: 'PURCHASE',
            referenceId: po.id,
            note: `Direct Receipt for PO #${po.poNumber || po.id.slice(0,8)}`
          }
        });
      }

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { status: 'RECEIVED', received: true },
        include: { poItems: true, goodsReceipts: { include: { items: true } } }
      });
    });

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
    try {
      const vendors = await this.getVendors();
      const totalAdvance = vendors.reduce((s, v) => s + (v.advance || 0), 0);
      const totalDue = vendors.reduce((s, v) => s + (v.due || 0), 0);
      const totalPurchased = vendors.reduce((s, v) => s + (v.totalPurchased || 0), 0);
      return { 
        totalVendors: vendors.length, 
        totalOwed: totalDue, 
        totalAdvance, 
        totalMaterials: await prisma.vendorMaterial.count().catch(() => 0),
        totalPurchased
      };
    } catch (e) {
      console.error('[ProcurementService] getVendorsSummary failed:', e);
      return { totalVendors: 0, totalOwed: 0, totalAdvance: 0, totalMaterials: 0, totalPurchased: 0 };
    }
  }

  static async getVendorLedger(vendorId: string, _filters: any = {}) {
    const ledger = await prisma.vendorLedger.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' }
    });
    
    // For older entries that don't have balanceAfterTransaction, we calculate on the fly
    // but we return the stored value if available.
    let runningBalance = 0;
    return ledger.map(entry => {
      if (entry.balanceAfterTransaction !== 0) {
        runningBalance = entry.balanceAfterTransaction;
      } else {
        runningBalance += (entry.type === 'CREDIT' ? entry.amount : -entry.amount);
      }
      return { ...entry, runningBalance };
    }).reverse();
  }

  private static async getNextBalance(tx: any, vendorId: string, amount: number, type: 'CREDIT' | 'DEBIT'): Promise<number> {
    const lastEntry = await tx.vendorLedger.findFirst({
      where: { vendorId },
      orderBy: { createdAt: 'desc' }
    });
    const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
    return type === 'CREDIT' ? currentBalance + amount : currentBalance - amount;
  }

  static async recordPayment(vendorId: string, data: { amount: number; note: string; accountId: string; type?: 'PAYMENT' | 'ADVANCE'; paymentMode?: any; referenceId?: string; vendorInvoiceId?: string }) {
    const { amount, note, accountId, type = 'PAYMENT', paymentMode, referenceId, vendorInvoiceId } = data;
    if (!accountId) throw new Error('Source Account (Cash/Bank) is mandatory for payments.');

    return prisma.$transaction(async (tx) => {
      // Centralized Payment & Account Adjustment (FinanceService will handle Ledger)
      const payment = await FinanceService.createPayment({
        tx,
        amount,
        type: type === 'ADVANCE' ? 'ADVANCE' : 'INVOICE_LINKED',
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: accountId,
        method: paymentMode || 'CASH',
        sourceModule: 'PROCUREMENT',
        linkedDocType: vendorInvoiceId ? 'INVOICE' : (referenceId ? 'PO' : 'DIRECT'),
        linkedDocId: vendorInvoiceId || referenceId,
        vendorInvoiceId: vendorInvoiceId,
        entityType: 'VENDOR',
        entity: vendorId,
        createdBy: 'PROCUREMENT_MODULE',
        note: note
      });

      // Update PO Payment status if linked
      if (referenceId) {
        const po = await tx.procurementOrder.findUnique({ where: { id: referenceId } });
        if (po) {
          const newPaid = (po.paid || 0) + Math.min(amount, po.totalAmount - (po.paid || 0));
          await tx.procurementOrder.update({
            where: { id: referenceId },
            data: {
              paid: newPaid,
              balance: Math.max(0, Number((po.totalAmount - newPaid).toFixed(2))),
              status: (po.totalAmount - newPaid <= 0.01 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
            }
          });
        }
      }

      return payment;
    });
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
    const nextBalance = await prisma.$transaction(async (tx) => {
      return this.getNextBalance(tx, vendorId, amount, type);
    });
    
    return prisma.vendorLedger.create({
      data: {
          vendorId,
          type,
          amount,
          balanceAfterTransaction: nextBalance,
          paymentMode: 'CASH',
          referenceType,
          referenceId,
          note: note || 'Manual Ledger Adjustment'
      }
    });
  }

  static async getVendorAging(vendorId: string) {
    const ledger = await prisma.vendorLedger.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' }
    });

    if (!ledger || ledger.length === 0) {
      return { current: 0, thirtySixty: 0, sixtyNinety: 0, overNinety: 0 };
    }

    let totalDebits = ledger.filter(e => e.type === 'DEBIT').reduce((s, e) => s + (e.amount || 0), 0);
    const credits = ledger.filter(e => e.type === 'CREDIT');

    const buckets = {
      current: 0, // 0-30 days
      thirtySixty: 0, // 31-60 days
      sixtyNinety: 0, // 61-90 days
      overNinety: 0 // 90+ days
    };

    const now = new Date();

    for (const credit of credits) {
      let remainingCredit = credit.amount;
      
      // Settle against debits (FIFO)
      const settlement = Math.min(remainingCredit, totalDebits);
      remainingCredit -= settlement;
      totalDebits -= settlement;

      if (remainingCredit > 0) {
        const createdAt = credit.createdAt || new Date();
        const ageInDays = Math.floor((now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
        
        if (ageInDays <= 30) buckets.current += remainingCredit;
        else if (ageInDays <= 60) buckets.thirtySixty += remainingCredit;
        else if (ageInDays <= 90) buckets.sixtyNinety += remainingCredit;
        else buckets.overNinety += remainingCredit;
      }
    }

    return buckets;
  }
}
