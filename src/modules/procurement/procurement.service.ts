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
    billingAddress?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
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
      throw new Error("Vendor Name is required and must only contain alphanumeric characters, spaces, and the following symbols: & . , - ( )");
    }

    // 2. Contact Validation (Exactly 10 Numbers)
    if (!data.contact || !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be a valid 10-digit number.");
    }

    // 3. Email Validation (Relaxed)
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw new Error("Please enter a valid email address.");
    }

    const resolvedAddress = data.address || (data as any).billingAddress;
    // 4. Address Validation (Mandatory)
    if (!resolvedAddress || resolvedAddress.trim().length === 0) {
      throw new Error("Registered Office Address is required.");
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
            email: data.email || null,
            address: resolvedAddress,
            state: data.state,
            district: data.district,
            city: data.city,
            pincode: data.pincode,
            shippingAddress: data.shippingAddress,
            gstType: data.gstType,
            openingBalance: Number(data.openingBalance) || 0,
            asOfDate: data.asOfDate ? new Date(data.asOfDate) : null,
            creditLimit: data.creditLimit !== undefined && data.creditLimit !== null ? Number(data.creditLimit) : null,
            remark: data.remark,
            gstNumber: data.gstNumber,
            category: data.category,
            paymentTerms: data.paymentTerms || 'IMMEDIATE',
            status: data.status || 'ACTIVE'
          }
        });

        // Generate opening balance ledger entry if applicable
        if (data.openingBalance && data.openingBalance !== 0) {
          const amount = Math.abs(data.openingBalance);
          const type = data.openingBalance > 0 ? 'CREDIT' : 'DEBIT';
          const obNumber = await ProcurementService.generateOpeningBalanceNumber(tx);
          await tx.vendorLedger.create({
            data: {
              vendorId: vendor.id,
              type,
              amount,
              balanceAfterTransaction: data.openingBalance,
              referenceType: 'OPENING_BALANCE',
              referenceId: obNumber,
              paymentMode: 'CASH',
              note: 'Vendor Opening Balance',
              createdAt: data.asOfDate ? new Date(data.asOfDate) : vendor.createdAt
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
        orders: { 
          include: { 
            poItems: { include: { inventoryItem: true } }
          }, 
          orderBy: { createdAt: 'desc' } 
        }
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
        
        const obNumber = await prisma.vendorLedger.count({
          where: { referenceType: 'OPENING_BALANCE' }
        }).then(c => `OB-${String(c + 1).padStart(4, '0')}`);
        
        // Create the missing entry in the database permanently
        const newEntry = await prisma.vendorLedger.create({
          data: {
            vendorId: v.id,
            type,
            amount,
            balanceAfterTransaction: v.openingBalance,
            referenceType: 'OPENING_BALANCE',
            referenceId: obNumber,
            paymentMode: 'CASH',
            note: 'Vendor Opening Balance',
            createdAt: v.asOfDate ? new Date(v.asOfDate) : v.createdAt
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
        .filter(e => e.type === 'DEBIT' && (e.referenceType === 'ADJUSTMENT' || e.referenceType === 'ADVANCE' || e.referenceType === 'OPENING_BALANCE'))
        .reduce((s, e) => s + (e.amount || 0), 0);

      const totalOwedByUs = totalPurchased + manualCredits;
      const totalPaidToThem = totalPayments + totalReturns + manualDebits;

      // Single source of truth for balance/due/advance
      const balance = entries.reduce((acc, e) => acc + (e.type === 'CREDIT' ? e.amount : -e.amount), 0);
      const rawAdvance = balance < 0 ? -balance : 0;
      const reservedAdvance = rawAdvance > 0
        ? (await prisma.procurementOrder.aggregate({
            where: { vendorId: v.id, status: { notIn: ['CLOSED', 'CANCELLED'] } },
            _sum: { advanceApplied: true }
          }))._sum.advanceApplied || 0
        : 0;

      const materialMap = new Map<string, { material: any; price: number; quantity: number; totalQuantity: number; totalAmount: number; lastUpdated: Date }>();
      if (v.suppliedMaterials) {
        for (const sm of v.suppliedMaterials) {
          if (sm.material) {
            const qty = Number(sm.quantity) || 0;
            const p = Number(sm.price) || Number(sm.material.costPrice) || Number(sm.material.basePrice) || 0;
            materialMap.set(sm.materialId, {
              material: sm.material,
              price: p,
              quantity: qty,
              totalQuantity: qty,
              totalAmount: qty * p,
              lastUpdated: sm.lastUpdated || v.createdAt
            });
          }
        }
      }

      const sortedOrders = [...(v.orders || [])].reverse();
      for (const order of sortedOrders) {
        for (const item of order.poItems || []) {
          if (item.inventoryItem) {
            const prev = materialMap.get(item.inventoryItem.id);
            const itemQty = Number(item.quantity) || 0;
            const itemPrice = Number(item.price) || 0;
            const itemTotal = Number(item.total) || (itemQty * itemPrice);

            materialMap.set(item.inventoryItem.id, {
              material: item.inventoryItem,
              price: itemPrice,
              quantity: itemQty,
              totalQuantity: (prev?.totalQuantity || 0) + itemQty,
              totalAmount: (prev?.totalAmount || 0) + itemTotal,
              lastUpdated: order.createdAt
            });
          }
        }
      }

      const suppliedMaterials = Array.from(materialMap.entries()).map(([mId, data]) => ({
        id: mId,
        materialId: mId,
        price: data.price,
        quantity: data.quantity,
        totalQuantity: data.totalQuantity,
        totalAmount: data.totalAmount,
        lastUpdated: data.lastUpdated,
        material: data.material
      }));

      return {
        ...v,
        totalPurchased: totalOwedByUs,
        totalPaid: totalPaidToThem,
        totalPayments,
        balance: balance,
        due: balance > 0 ? balance : 0,
        advance: Math.max(0, rawAdvance - reservedAdvance),
        suppliedMaterials,
        lastOrderDate: v.orders?.[0]?.createdAt || null
      };
    }));
  }

  static async getVendorById(id: string) {
    const vendor = await prisma.vendor.findUnique({
      where: { id },
      include: { 
        orders: { 
          include: { 
            poItems: { include: { inventoryItem: true } },
            goodsReceipts: { include: { items: { include: { inventoryItem: true } } } },
            invoices: true
          }, 
          orderBy: { createdAt: 'desc' }
        },
        invoices: true,
        ledgerEntries: true,
        suppliedMaterials: { include: { material: true } },
        _count: { select: { orders: true } } 
      }
    });

    if (!vendor) return null;

    const entries = vendor.ledgerEntries || [];
    
    // Auto-repair: If openingBalance exists but no ledger entry exists, inject it!
    const hasOpeningBalanceEntry = entries.some(e => e.referenceType === 'OPENING_BALANCE');
    if (!hasOpeningBalanceEntry && vendor.openingBalance !== 0) {
      const type = vendor.openingBalance > 0 ? 'CREDIT' : 'DEBIT';
      const amount = Math.abs(vendor.openingBalance);
      const obNumber = await prisma.vendorLedger.count({
        where: { referenceType: 'OPENING_BALANCE' }
      }).then(c => `OB-${String(c + 1).padStart(4, '0')}`);
      
      const newEntry = await prisma.vendorLedger.create({
        data: {
          vendorId: vendor.id,
          type,
          amount,
          balanceAfterTransaction: vendor.openingBalance,
          referenceType: 'OPENING_BALANCE',
          referenceId: obNumber,
          paymentMode: 'CASH',
          note: 'Vendor Opening Balance',
          createdAt: vendor.asOfDate ? new Date(vendor.asOfDate) : vendor.createdAt
        }
      });
      entries.push(newEntry);
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
      .filter(e => e.type === 'DEBIT' && (e.referenceType === 'ADJUSTMENT' || e.referenceType === 'ADVANCE' || e.referenceType === 'OPENING_BALANCE'))
      .reduce((s, e) => s + (e.amount || 0), 0);

    const totalOwedByUs = totalPurchased + manualCredits;
    const totalPaidToThem = totalPayments + totalReturns + manualDebits;

    const balance = entries.reduce((acc, e) => acc + (e.type === 'CREDIT' ? e.amount : -e.amount), 0);
    const rawAdvance = balance < 0 ? -balance : 0;
    const reservedAdvance = rawAdvance > 0
      ? (await prisma.procurementOrder.aggregate({
          where: { vendorId: id, status: { notIn: ['CLOSED', 'CANCELLED'] } },
          _sum: { advanceApplied: true }
        }))._sum.advanceApplied || 0
      : 0;

    const materialMap = new Map<string, { material: any; price: number; quantity: number; totalQuantity: number; totalAmount: number; lastUpdated: Date }>();
    
    if (vendor.suppliedMaterials) {
      for (const sm of vendor.suppliedMaterials) {
        if (sm.material) {
          const qty = Number(sm.quantity) || 0;
          const p = Number(sm.price) || Number(sm.material.costPrice) || Number(sm.material.basePrice) || 0;
          materialMap.set(sm.materialId, {
            material: sm.material,
            price: p,
            quantity: qty,
            totalQuantity: qty,
            totalAmount: qty * p,
            lastUpdated: sm.lastUpdated || vendor.createdAt
          });
        }
      }
    }

    const sortedOrders = [...vendor.orders].reverse();
    for (const order of sortedOrders) {
      for (const item of order.poItems) {
        if (item.inventoryItem) {
          const prev = materialMap.get(item.inventoryItem.id);
          const itemQty = Number(item.quantity) || 0;
          const itemPrice = Number(item.price) || 0;
          const itemTotal = Number(item.total) || (itemQty * itemPrice);

          materialMap.set(item.inventoryItem.id, {
            material: item.inventoryItem,
            price: itemPrice,
            quantity: itemQty,
            totalQuantity: (prev?.totalQuantity || 0) + itemQty,
            totalAmount: (prev?.totalAmount || 0) + itemTotal,
            lastUpdated: order.createdAt
          });
        }
      }
      for (const grn of order.goodsReceipts || []) {
        for (const item of grn.items || []) {
          if (item.inventoryItem) {
            const prev = materialMap.get(item.inventoryItem.id);
            if (prev) {
              prev.lastUpdated = grn.createdAt || order.createdAt;
              if (item.price) prev.price = Number(item.price);
            }
          }
        }
      }
    }

    const suppliedMaterials = Array.from(materialMap.entries()).map(([mId, data]) => ({
      id: mId,
      materialId: mId,
      price: data.price,
      quantity: data.quantity,
      totalQuantity: data.totalQuantity,
      totalAmount: data.totalAmount,
      lastUpdated: data.lastUpdated,
      material: data.material
    }));

    return {
      ...vendor,
      totalPurchased: totalOwedByUs,
      totalPaid: totalPaidToThem,
      totalPayments,
      totalReturns,
      balance: balance,
      due: balance > 0 ? balance : 0,
      advance: Math.max(0, rawAdvance - reservedAdvance),
      advanceCredit: rawAdvance,
      suppliedMaterials
    };
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
    billingAddress?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
    asOfDate?: string | Date | null;
    creditLimit?: number | null;
    remark?: string | null;
    rating?: number | null;
    gstNumber?: string | null;
    category?: string | null;
    paymentTerms?: any;
    status?: any;
    paymentReminderEnabled?: boolean;
    paymentReminderDays?: number;
    vendorCode?: string | null;
  }) {
    if (data.name !== undefined && !/^[A-Za-z0-9\s&.,\-()]+$/.test(data.name)) {
      throw new Error("Vendor Name must only contain alphanumeric characters, spaces, and the following symbols: & . , - ( )");
    }
    if (data.contact !== undefined && !/^\d{10}$/.test(data.contact)) {
      throw new Error("Contact Number must be a valid 10-digit number.");
    }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      throw new Error("Please enter a valid email address.");
    }
    const resolvedAddress = data.address !== undefined ? data.address : (data as any).billingAddress;
    if (resolvedAddress !== undefined && resolvedAddress.trim().length === 0) {
      throw new Error("Registered Office Address cannot be empty.");
    }
    
    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.contact !== undefined) updateData.contact = data.contact;
    if (data.email !== undefined) updateData.email = data.email || null;
    if (resolvedAddress !== undefined) updateData.address = resolvedAddress;
    if (data.state !== undefined) updateData.state = data.state;
    if (data.district !== undefined) updateData.district = data.district;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.pincode !== undefined) updateData.pincode = data.pincode;
    if (data.shippingAddress !== undefined) updateData.shippingAddress = data.shippingAddress;
    if (data.gstType !== undefined) updateData.gstType = data.gstType;
    if (data.openingBalance !== undefined) updateData.openingBalance = Number(data.openingBalance) || 0;
    if (data.asOfDate !== undefined) {
      updateData.asOfDate = data.asOfDate ? new Date(data.asOfDate) : null;
    }
    if (data.creditLimit !== undefined) updateData.creditLimit = data.creditLimit !== null && data.creditLimit !== undefined ? Number(data.creditLimit) : null;
    if (data.remark !== undefined) updateData.remark = data.remark;
    if (data.rating !== undefined) updateData.rating = data.rating !== null && data.rating !== undefined ? Number(data.rating) : null;
    if (data.gstNumber !== undefined) updateData.gstNumber = data.gstNumber;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.paymentTerms !== undefined) updateData.paymentTerms = data.paymentTerms;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.paymentReminderEnabled !== undefined) updateData.paymentReminderEnabled = Boolean(data.paymentReminderEnabled);
    if (data.paymentReminderDays !== undefined) updateData.paymentReminderDays = Number(data.paymentReminderDays);
    if ((data as any).vendorCode !== undefined) updateData.vendorCode = (data as any).vendorCode;
    if ((data as any).manualPurchaseAdj !== undefined) updateData.manualPurchaseAdj = Number((data as any).manualPurchaseAdj);
    if ((data as any).manualAdvanceAdj !== undefined) updateData.manualAdvanceAdj = Number((data as any).manualAdvanceAdj);
    
    return prisma.$transaction(async (tx) => {
      const vendor = await tx.vendor.update({ where: { id }, data: updateData });

      // Synchronize Opening Balance Ledger Entry if it's set or if asOfDate is updated
      if (data.openingBalance !== undefined || data.asOfDate !== undefined) {
        const existingEntry = await tx.vendorLedger.findFirst({
          where: { vendorId: id, referenceType: 'OPENING_BALANCE' }
        });

        const currentBal = data.openingBalance !== undefined ? data.openingBalance : vendor.openingBalance;
        const amount = Math.abs(currentBal);
        const type = currentBal >= 0 ? 'CREDIT' : 'DEBIT';

        const targetDate = data.asOfDate !== undefined 
          ? (data.asOfDate ? new Date(data.asOfDate) : vendor.createdAt)
          : (vendor.asOfDate ? new Date(vendor.asOfDate) : vendor.createdAt);

        if (existingEntry) {
          if (amount === 0) {
            await tx.vendorLedger.delete({ where: { id: existingEntry.id } });
          } else {
            await tx.vendorLedger.update({
              where: { id: existingEntry.id },
              data: { 
                amount, 
                type, 
                balanceAfterTransaction: currentBal,
                note: 'Vendor Opening Balance',
                createdAt: targetDate
              }
            });
          }
        } else if (amount > 0) {
          const obNumber = await ProcurementService.generateOpeningBalanceNumber(tx);
          await tx.vendorLedger.create({
            data: {
              vendorId: id,
              type,
              amount,
              balanceAfterTransaction: currentBal,
              referenceType: 'OPENING_BALANCE',
              referenceId: obNumber,
              paymentMode: 'CASH',
              note: 'Vendor Opening Balance',
              createdAt: targetDate
            }
          });
        }
      }

        // Recalculate subsequent balances if needed
        // (For simplicity, the running balances are usually fetched live via getVendors calculation, 
        // but to ensure the UI ledger is perfect, we can leave it to the UI or run a migration. 
        // We update the entry's amount which fixes the getVendors calculation.)
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

  static async getVendorBalance(vendorId: string, tx: any = prisma): Promise<number> {
    const entries = await tx.vendorLedger.findMany({
      where: { vendorId },
      select: { type: true, amount: true }
    });
    return entries.reduce((acc: number, e: any) => acc + (e.type === 'CREDIT' ? e.amount : -e.amount), 0);
  }

  /**
   * Single source of truth for "how much unspent vendor advance is actually
   * available right now" — used by every place that offers to apply advance
   * (PO creation, the explicit Apply Advance action, invoice approval's
   * auto-utilization, and the Vendor Overview "Advance" figure).
   *
   * getVendorBalance() alone isn't enough: a negative balance means advance
   * was paid, but if some of it has already been earmarked to a specific PO
   * (ProcurementOrder.advanceApplied) that PO's own purchase liability
   * hasn't been billed/recognized yet, so it hasn't yet reduced the raw
   * ledger balance. Subtracting reservations across ALL open POs — including
   * the PO the caller is about to apply advance to — prevents that same
   * advance being offered again, to another PO OR back to this same one.
   *
   * No excludePoId: an earlier version excluded the target PO from the
   * reservation sum, on the assumption a PO calling this always had
   * advanceApplied still at 0. That's false for the common case of a PO
   * that already got advance auto-applied at creation (createPurchaseOrder)
   * — excluding it made that PO's own already-claimed advance look
   * unclaimed again, letting "Apply Advance" grant the same ₹ a second time
   * on top of what the PO already had.
   */
  static async getAvailableAdvance(vendorId: string, tx: any = prisma): Promise<number> {
    const balance = await this.getVendorBalance(vendorId, tx);
    const rawAvailable = balance < 0 ? -balance : 0;
    if (rawAvailable <= 0) return 0;

    const reserved = await tx.procurementOrder.aggregate({
      where: {
        vendorId,
        status: { notIn: ['CLOSED', 'CANCELLED'] }
      },
      _sum: { advanceApplied: true }
    });

    return Math.max(0, rawAvailable - (reserved._sum.advanceApplied || 0));
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
    warehouseId?: string;
    purchaseType?: string;
    discountAmount?: number;
    freightCost?: number;
    paymentTerms?: string;
    items: Array<{ inventoryItemId: string; quantity: number; price: number; gstRate?: number; unit?: string }>;
    manualTax?: { cgst: number, sgst: number, igst: number };
  }) {
    const poItemsData = await Promise.all(data.items.map(async (item) => {
      const inventoryItem = await prisma.inventoryItem.findUnique({
        where: { id: item.inventoryItemId }
      });
      // A Finished Good is only ever created by Production/QC (see
      // ProductionService.inspectBatch) — receiving one on a vendor PO would
      // credit its stock outside that workflow, bypassing the batch/QC trail
      // and silently inflating Finished Goods that were never manufactured.
      if (inventoryItem?.category === 'FINISHED_GOOD') {
        throw new Error(`"${inventoryItem.name}" is a Finished Good and cannot be purchased on a vendor PO — Finished Goods stock is only credited via Production QC acceptance.`);
      }

      // Unit Validation: Ensure the transaction unit is compatible with the item's base unit.
      // E.g. Reject KG -> ML. We don't save the unit or convert the quantity for PO financials,
      // we only use the engine to enforce dimension safety.
      if (item.unit && inventoryItem?.unit) {
         try {
            const { convertMeasurement } = require('@businessgroupikasle/erp-units');
            // This will throw if dimensions don't match (e.g. WEIGHT vs VOLUME)
            convertMeasurement(item.quantity, item.unit.toUpperCase(), inventoryItem.unit.toUpperCase());
         } catch (e: any) {
            throw new Error(`Unit mismatch for "${inventoryItem.name}": ${e.message}`);
         }
      }

      // Prefer whatever GST% the line item actually shows on the PO (the
      // user can override it there); fall back to the item master's own
      // rate, then 5% as a last resort. `??` matters here — `|| 5` would
      // silently turn a genuine 0%-GST item into 5%, since 0 is falsy.
      const gstRate = item.gstRate ?? inventoryItem?.gstRate ?? 5;
      const subtotal = item.quantity * item.price;
      const gstAmount = (subtotal * gstRate) / 100;
      const cgst = gstAmount / 2;
      const sgst = gstAmount / 2;

      return {
        ...item,
        itemName: inventoryItem?.name || "Unknown Material",
        gstRate,
        quantity: item.quantity,
        price: item.price,
        unit: item.unit || 'UNIT',
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
    const discountAmount = Number(data.discountAmount) || 0;
    const freightCost = Number(data.freightCost) || 0;
    const totalAmount = totalSubtotal + totalCGST + totalSGST + totalIGST - discountAmount + freightCost;

    // Existing usable credit — see getAvailableAdvance for why this isn't
    // just the raw ledger balance (it also excludes advance already
    // reserved to other open POs, so the same credit can't be handed out
    // twice).
    const existingCredit = await this.getAvailableAdvance(data.vendorId);
    const providedAmount = data.advancePaid || 0;
    // const finalPaidOnPO = Math.max(autoApplied, providedAmount);
    const newMoneyPayment = Math.max(0, providedAmount - existingCredit);
    // The rest of providedAmount (up to what existing credit covers) isn't
    // new money — it's previously-received advance being spent on this PO.
    // That consumption still has to be written to the ledger below, or
    // getVendorBalance() keeps reporting it as available and the same
    // credit could be "applied" to every future PO forever.
    const appliedFromCredit = Math.min(providedAmount, existingCredit);

    const result = await prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      const count = await tx.procurementOrder.count();
      const poNumber = `PO-${year}-${(count + 1).toString().padStart(4, '0')}`;

      const po = await tx.procurementOrder.create({
        data: {
          poNumber,
          vendorId: data.vendorId,
          franchiseId: data.franchiseId || null,
          warehouseId: data.warehouseId || null,
          purchaseType: (data.purchaseType as any) || 'RAW_MATERIAL',
          subtotal: totalSubtotal,
          cgst: totalCGST,
          sgst: totalSGST,
          igst: totalIGST,
          discountAmount,
          freightCost,
          totalAmount,
          advancePaid: providedAmount, // Real money provided
          advanceApplied: appliedFromCredit, // Portion of the above that was pre-existing credit, not fresh cash
          paid: providedAmount,
          balance: totalAmount - providedAmount,
          expectedDeliveryDate: data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : null,
          notes: data.notes,
          internalNotes: data.internalNotes,
          vendorNotes: data.vendorNotes,
          deliveryInstructions: data.deliveryInstructions,
          paymentTerms: data.paymentTerms || 'IMMEDIATE',
          status: (data.status as any) || 'PENDING_APPROVAL',
          poItems: {
            create: poItemsData.map((item) => ({
              inventoryItemId: item.inventoryItemId,
              itemName: item.itemName,
              gstRate: item.gstRate,
              quantity: item.quantity,
              price: item.price,
              unit: item.unit,
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

      // NO LEDGER ENTRY ON PO CREATION FOR THE PURCHASE ITSELF (wait for GRN/Bill).
      // Fresh cash paid as advance right now DOES hit Ledger + Account — via
      // FinanceService.createPayment alone. It already creates the Payment
      // record, writes the VendorLedger DEBIT row, and adjusts the account
      // balance in one place; this used to ALSO do all three manually right
      // after, which duplicated the Payment row, duplicated the ledger row,
      // and double-deducted the account balance for the same advance.
      if (newMoneyPayment > 0) {
        if (!data.accountId) throw new Error('Source Account ID is required for advance payment.');

        await FinanceService.createPayment({
          tx,
          amount: newMoneyPayment,
          type: 'ADVANCE',
          flow: 'OUT',
          status: 'PAID',
          sourceAccount: data.accountId,
          method: 'CASH',
          sourceModule: 'PROCUREMENT',
          linkedDocType: 'PO',
          linkedDocId: po.poNumber,
          entityType: 'VENDOR',
          entityId: data.vendorId,
          note: `Advance Payment for PO #${po.poNumber}`,
          createdBy: 'SYSTEM_PO'
        });
      }

      // Existing credit spent on this PO is recorded on the PO itself
      // (advanceApplied, set above) — not as an extra offsetting VendorLedger
      // entry. Writing one here used to zero the vendor's ledger balance out
      // immediately, before the purchase liability it's meant to offset was
      // even recognized (that only happens later, at Bill approval), so the
      // balance overshot back up to the FULL gross amount once the Bill
      // posted instead of net of the advance. getAvailableAdvance() reads
      // ProcurementOrder.advanceApplied directly, so nothing else needs this
      // written to the ledger to know the credit is spoken for.

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

  /**
   * Update a Purchase Order in place. Replaces the previous "delete + recreate"
   * workaround the frontend used (PurchaseFormContent.tsx), which lost the PO's id/
   * history and could orphan a linked GRN/Invoice. Blocked once the PO has any
   * GRN or Vendor Invoice against it, or is past the editable-status window —
   * at that point the commercial record is already in motion and must be
   * changed via cancellation/return flows instead of a silent edit.
   */
  static async updatePO(poId: string, data: {
    vendorId?: string;
    franchiseId?: string;
    expectedDeliveryDate?: string;
    notes?: string;
    internalNotes?: string;
    vendorNotes?: string;
    deliveryInstructions?: string;
    warehouseId?: string;
    purchaseType?: string;
    discountAmount?: number;
    freightCost?: number;
    paymentTerms?: string;
    items?: Array<{ inventoryItemId: string; quantity: number; price: number; gstRate?: number; unit?: string }>;
    manualTax?: { cgst: number, sgst: number, igst: number };
  }) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId }, include: { poItems: true } });
      if (!po) throw new Error('Purchase Order not found');

      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(po.status)) {
        throw new Error(`Cannot edit a PO in status ${po.status}. Cancel or return it instead.`);
      }
      const [grnCount, invoiceCount] = await Promise.all([
        tx.goodsReceipt.count({ where: { poId } }),
        tx.vendorInvoice.count({ where: { poId } })
      ]);
      if (grnCount > 0 || invoiceCount > 0) {
        throw new Error('Cannot edit a PO that already has a Goods Receipt or Vendor Invoice against it.');
      }

      const updateData: any = {};
      if (data.vendorId) updateData.vendorId = data.vendorId;
      if (data.franchiseId !== undefined) updateData.franchiseId = data.franchiseId || null;
      if (data.warehouseId !== undefined) updateData.warehouseId = data.warehouseId || null;
      if (data.purchaseType !== undefined) updateData.purchaseType = data.purchaseType;
      if (data.discountAmount !== undefined) updateData.discountAmount = Number(data.discountAmount) || 0;
      if (data.freightCost !== undefined) updateData.freightCost = Number(data.freightCost) || 0;
      if (data.expectedDeliveryDate !== undefined) {
        updateData.expectedDeliveryDate = data.expectedDeliveryDate ? new Date(data.expectedDeliveryDate) : null;
      }
      if (data.notes !== undefined) updateData.notes = data.notes;
      if (data.internalNotes !== undefined) updateData.internalNotes = data.internalNotes;
      if (data.vendorNotes !== undefined) updateData.vendorNotes = data.vendorNotes;
      if (data.deliveryInstructions !== undefined) updateData.deliveryInstructions = data.deliveryInstructions;
      if (data.paymentTerms !== undefined) updateData.paymentTerms = data.paymentTerms;

      if (data.items && data.items.length > 0) {
        const poItemsData = await Promise.all(data.items.map(async (item) => {
          const inventoryItem = await tx.inventoryItem.findUnique({ where: { id: item.inventoryItemId } });
          // Same guard as createPurchaseOrder — a Finished Good must never
          // be added to a vendor PO, on creation or on a later edit.
          if (inventoryItem?.category === 'FINISHED_GOOD') {
            throw new Error(`"${inventoryItem.name}" is a Finished Good and cannot be purchased on a vendor PO — Finished Goods stock is only credited via Production QC acceptance.`);
          }

          if (item.unit && inventoryItem?.unit) {
             try {
                const { convertMeasurement } = require('@businessgroupikasle/erp-units');
                convertMeasurement(item.quantity, item.unit.toUpperCase(), inventoryItem.unit.toUpperCase());
             } catch (e: any) {
                throw new Error(`Unit mismatch for "${inventoryItem.name}": ${e.message}`);
             }
          }

          // Same `??` fix as createPurchaseOrder — a real 0%-GST item must
          // not get silently bumped to 5% by a falsy-zero fallback.
          const gstRate = item.gstRate ?? inventoryItem?.gstRate ?? 5;
          const subtotal = item.quantity * item.price;
          const gstAmount = (subtotal * gstRate) / 100;
          return {
            inventoryItemId: item.inventoryItemId,
            itemName: inventoryItem?.name || 'Unknown Material',
            gstRate,
            quantity: item.quantity,
            price: item.price,
            unit: item.unit || 'UNIT',
            subtotal,
            cgst: gstAmount / 2,
            sgst: gstAmount / 2,
            igst: 0,
            total: subtotal + gstAmount
          };
        }));

        const totalSubtotal = poItemsData.reduce((acc, item) => acc + item.subtotal, 0);
        const totalCGST = data.manualTax ? data.manualTax.cgst : poItemsData.reduce((acc, item) => acc + item.cgst, 0);
        const totalSGST = data.manualTax ? data.manualTax.sgst : poItemsData.reduce((acc, item) => acc + item.sgst, 0);
        const totalIGST = data.manualTax ? data.manualTax.igst : poItemsData.reduce((acc, item) => acc + item.igst, 0);
        const discount = data.discountAmount !== undefined ? (Number(data.discountAmount) || 0) : (po.discountAmount || 0);
        const freight = data.freightCost !== undefined ? (Number(data.freightCost) || 0) : (po.freightCost || 0);
        const totalAmount = totalSubtotal + totalCGST + totalSGST + totalIGST - discount + freight;

        await tx.procurementOrderItem.deleteMany({ where: { poId } });

        updateData.subtotal = totalSubtotal;
        updateData.cgst = totalCGST;
        updateData.sgst = totalSGST;
        updateData.igst = totalIGST;
        updateData.totalAmount = totalAmount;
        updateData.balance = Math.max(0, totalAmount - po.paid);
        updateData.poItems = { create: poItemsData };

        // Item price changes should be reflected in the vendor's price list too,
        // same as at PO creation time.
        for (const item of data.items) {
          await tx.vendorMaterial.upsert({
            where: { vendorId_materialId: { vendorId: data.vendorId || po.vendorId, materialId: item.inventoryItemId } },
            update: { price: item.price, lastUpdated: new Date() },
            create: { vendorId: data.vendorId || po.vendorId, materialId: item.inventoryItemId, price: item.price }
          });
        }
      }

      return tx.procurementOrder.update({
        where: { id: poId },
        data: updateData,
        include: { vendor: true, poItems: { include: { inventoryItem: true } } }
      });
    });
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

      // balanceAfterTransaction must be computed, not left to its schema
      // default of 0 — getNextBalance() reads the most recent ledger row's
      // balanceAfterTransaction as the running balance, so a row with a bare
      // 0 here would corrupt every balance computed after it.
      const nextBalance = await this.getNextBalance(tx, po.vendorId, advancePaid, 'DEBIT');
      await tx.vendorLedger.create({
        data: {
          vendorId: po.vendorId,
          type: 'DEBIT',
          amount: advancePaid,
          balanceAfterTransaction: nextBalance,
          paymentMode: 'CASH',
          referenceType: 'ADVANCE',
          referenceId: po.id,
          note: `Advance Payment for PO #${po.poNumber || po.id.substring(0, 8)}`
        }
      });

      const newAdvancePaid = Math.min(po.totalAmount, po.advancePaid + advancePaid);
      const newPaid = Math.min(po.totalAmount, po.paid + advancePaid);
      const newBalance = Math.max(0, po.totalAmount - newPaid);

      return tx.procurementOrder.update({
        where: { id: poId },
        data: { 
          advancePaid: newAdvancePaid,
          paid: newPaid,
          balance: newBalance,
          status: (newBalance <= 0.01 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
        },
        include: { poItems: { include: { inventoryItem: true } }, vendor: true }
      });
    });
  }

  static async approvePO(poId: string) {
    return this.updatePOStatus(poId, 'APPROVED');
  }

  static async updatePOStatus(poId: string, status: any) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({ where: { id: poId } });
      if (!po) throw new Error('Purchase Order not found');
      
      const updateData: any = { status };
      if (status === 'APPROVED') {
        updateData.approvedAt = new Date();
        updateData.approvedBy = 'SUPER_ADMIN'; 
      }

      const updated = await tx.procurementOrder.update({
        where: { id: poId },
        data: updateData,
        include: { vendor: true, poItems: { include: { inventoryItem: true } } }
      });

      if (status === 'APPROVED' || status === 'RECEIVED') {
        await this.settleVendorOrders(po.vendorId, tx);
        return tx.procurementOrder.findUnique({
          where: { id: poId },
          include: { vendor: true, poItems: { include: { inventoryItem: true } } }
        });
      }

      return updated;
    });
  }

  static async applyAdvanceToPO(poId: string) {
    return prisma.$transaction(async (tx) => {
      const po = await tx.procurementOrder.findUnique({
        where: { id: poId },
        include: { vendor: true }
      });
      if (!po) throw new Error('Purchase Order not found');

      // Includes this PO's own already-applied reservation in what counts as
      // "spent" — see getAvailableAdvance for why excluding it let the same
      // advance be applied to this PO twice.
      const availableAdvance = await this.getAvailableAdvance(po.vendorId, tx);
      if (availableAdvance <= 0) {
        throw new Error(`Vendor ${po.vendor.name} has no available advance balance.`);
      }

      const remainingDue = po.totalAmount - po.paid;
      if (remainingDue <= 0) throw new Error('This Purchase Order is already fully paid.');

      const amountToApply = Math.min(remainingDue, availableAdvance);
      const newPaid = po.paid + amountToApply;
      const newAdvanceApplied = (po.advanceApplied || 0) + amountToApply;

      // Advance consumption lives on the PO (advanceApplied), not as an
      // extra VendorLedger entry — see createPurchaseOrder's appliedFromCredit
      // comment for why a ledger write here corrupts the running balance.
      //
      // updateMany + a WHERE clause pinned to the `paid` value just read
      // (rather than a plain update-by-id) is an optimistic-concurrency
      // guard: if a second "Apply Advance" call for this same PO — or a
      // payment/settlement touching the same `paid` field — commits between
      // this transaction's read above and this write, `count` comes back 0
      // and this throws instead of silently applying advance a second time
      // on stale numbers.
      const result = await tx.procurementOrder.updateMany({
        where: { id: poId, paid: po.paid },
        data: {
          paid: newPaid,
          advanceApplied: newAdvanceApplied,
          balance: po.totalAmount - newPaid,
          status: (po.totalAmount - newPaid <= 0 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
        }
      });
      if (result.count === 0) {
        throw new Error('This Purchase Order was updated by another request — please retry.');
      }

      return tx.procurementOrder.findUnique({
        where: { id: poId },
        include: { vendor: true, poItems: { include: { inventoryItem: true } } }
      });
    });
  }

  static async getPurchaseOrders() {
    const orders = await prisma.procurementOrder.findMany({
      include: { 
        vendor: true, 
        poItems: { include: { inventoryItem: true } }, 
        goodsReceipts: { include: { items: true } },
        warehouse: true,
        franchise: true
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
      include: { 
        vendor: true, 
        poItems: { include: { inventoryItem: true } }, 
        goodsReceipts: { include: { items: true } },
        warehouse: true,
        franchise: true
      }
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
        const billNumber = `BILL-${po.poNumber || po.id.substring(0, 8)}-REC`;
        await tx.inventoryBatch.create({
          data: {
            inventoryItemId: item.inventoryItemId,
            batchNumber: billNumber,
            initialQty: item.quantity,
            currentQty: item.quantity,
            unitCost: item.price,
            status: 'QC_HOLD'
          }
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
              price: item.price,
              unit: item.unit,
              qcStatus: 'PENDING'
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

      const updatedPo = await tx.procurementOrder.update({
        where: { id: poId },
        data: { status: 'RECEIVED', received: true },
        include: { poItems: true, goodsReceipts: { include: { items: true } } }
      });

      await this.settleVendorOrders(po.vendorId, tx);

      return tx.procurementOrder.findUnique({
        where: { id: poId },
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
    // 0. Auto-repair: sync any completed purchase returns for this vendor that are not yet in VendorLedger
    try {
      const completedReturns = await prisma.purchaseReturn.findMany({
        where: {
          vendorId,
          status: { in: ['COMPLETED', 'APPROVED'] }
        },
        include: {
          procurementOrder: { include: { invoices: true } },
          items: true
        }
      });

      for (const pr of completedReturns) {
        const returnAmount = Number(pr.refundAmount) || 0;
        if (returnAmount <= 0) continue;

        const alreadyPosted = await prisma.vendorLedger.findFirst({
          where: {
            vendorId: pr.vendorId,
            referenceType: 'RETURN',
            OR: [
              { referenceId: pr.id },
              { referenceId: pr.returnNumber }
            ]
          }
        });

        if (!alreadyPosted) {
          await prisma.$transaction(async (tx) => {
            const lastEntry = await tx.vendorLedger.findFirst({
              where: { vendorId: pr.vendorId },
              orderBy: { createdAt: 'desc' }
            });
            const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
            const nextBalance = currentBalance - returnAmount;

            let invoiceId: string | undefined = undefined;
            let billRefNote = '';
            const linkedInvoice = pr.procurementOrder?.invoices?.[0];
            if (linkedInvoice) {
              invoiceId = linkedInvoice.id;
              billRefNote = ` against Purchase Bill ${linkedInvoice.invoiceNumber}`;
            }

            await tx.vendorLedger.create({
              data: {
                vendorId: pr.vendorId,
                type: 'DEBIT',
                amount: returnAmount,
                balanceAfterTransaction: nextBalance,
                sourceModule: 'PROCUREMENT',
                referenceType: 'RETURN',
                referenceId: pr.returnNumber,
                invoiceId,
                paymentMode: 'CASH',
                note: `Purchase Return ${pr.returnNumber}${billRefNote}`,
                createdAt: pr.createdAt || new Date()
              }
            });
          });
        }
      }
    } catch (err) {
      console.error('[ProcurementService] auto-sync returns error:', err);
    }

    const ledger = await prisma.vendorLedger.findMany({
      where: { vendorId },
      include: { invoice: true },
      orderBy: { createdAt: 'asc' }
    });

    const paymentIds = ledger
      .filter(e => (e.referenceType === 'PAYMENT' || e.referenceType === 'ADVANCE') && e.referenceId)
      .map(e => e.referenceId as string);

    const returnRefs = ledger
      .filter(e => (e.referenceType === 'RETURN' || (e.referenceType as any) === 'PURCHASE_RETURN') && e.referenceId)
      .map(e => e.referenceId as string);

    const [payments, returns] = await Promise.all([
      paymentIds.length > 0
        ? prisma.payment.findMany({
            where: { id: { in: paymentIds } },
            select: { id: true, paymentNumber: true, transactionRef: true }
          })
        : [],
      returnRefs.length > 0
        ? prisma.purchaseReturn.findMany({
            where: {
              OR: [
                { id: { in: returnRefs } },
                { returnNumber: { in: returnRefs } }
              ]
            },
            include: {
              procurementOrder: { include: { invoices: true } },
              items: true
            }
          })
        : []
    ]);

    const paymentMap = new Map<string, any>();
    payments.forEach((p: any) => paymentMap.set(p.id, p));
    const returnMap = new Map<string, any>();
    returns.forEach(r => {
      returnMap.set(r.id, r);
      returnMap.set(r.returnNumber, r);
    });
    
    let runningBalance = 0;
    return ledger.map(entry => {
      if (entry.balanceAfterTransaction !== 0) {
        runningBalance = entry.balanceAfterTransaction;
      } else {
        runningBalance += (entry.type === 'CREDIT' ? entry.amount : -entry.amount);
      }

      const paymentInfo = entry.referenceId ? paymentMap.get(entry.referenceId) : null;
      const returnInfo = entry.referenceId ? returnMap.get(entry.referenceId) : null;

      const returnNumber = returnInfo?.returnNumber || (entry.referenceType === 'RETURN' ? entry.referenceId : null);
      const originalInvoiceNumber = entry.invoice?.invoiceNumber || returnInfo?.procurementOrder?.invoices?.[0]?.invoiceNumber || null;

      return { 
        ...entry, 
        runningBalance,
        paymentNumber: paymentInfo?.paymentNumber || null,
        transactionRef: paymentInfo?.transactionRef || null,
        returnNumber,
        returnItems: returnInfo?.items || [],
        originalInvoiceNumber
      };
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

  static async recordPayment(vendorId: string, data: {
    amount: number; note: string; accountId: string; type?: 'PAYMENT' | 'ADVANCE';
    paymentMode?: any; referenceId?: string; vendorInvoiceId?: string; transactionRef?: string;
    idempotencyKey?: string; allowOverpayment?: boolean; date?: string;
  }) {
    const { amount, note, accountId, type = 'PAYMENT', paymentMode, referenceId, vendorInvoiceId, transactionRef, idempotencyKey, allowOverpayment, date } = data;
    const modeMap: Record<string, string> = {
      CASH: 'CASH',
      UPI: 'UPI',
      CARD: 'CARD',
      BANK: 'BANK_TRANSFER',
      BANK_TRANSFER: 'BANK_TRANSFER',
      CHEQUE: 'CHEQUE',
      NEFT: 'NEFT',
      RTGS: 'RTGS',
      IMPS: 'IMPS'
    };
    const resolvedMode = modeMap[String(paymentMode || 'CASH').toUpperCase()] || 'CASH';

    return prisma.$transaction(async (tx) => {
      // Idempotency short-circuit for THIS function's own side effects (PO
      // update, ledger sweep) — FinanceService.createPayment has the same
      // check for the Payment/VendorLedger rows it owns, but a replay must
      // not re-run recordPayment's own PO/settlement updates either, or a
      // retry would apply the payment's effect on the PO twice even though
      // no second Payment/ledger row gets created.
      if (idempotencyKey) {
        const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
        if (existing) return existing;
      }

      // Resolve which PO this payment should update. Paying from the Bills
      // screen only ever passed vendorInvoiceId, never referenceId (a PO
      // id) — so the linked PO's `paid`/`balance` never moved and stayed
      // out of sync with what the invoice/vendor ledger showed as paid.
      let targetPoId = referenceId;
      if (!targetPoId && vendorInvoiceId) {
        const inv = await tx.vendorInvoice.findUnique({ where: { id: vendorInvoiceId }, select: { poId: true } });
        targetPoId = inv?.poId || undefined;
      }

      // Outstanding = Invoice/PO gross total - advance already applied -
      // previously recorded valid payments. Reject anything beyond that
      // unless the caller explicitly opted into overpayment (which should
      // be recorded as a fresh vendor advance, not silently absorbed here).
      if (!allowOverpayment) {
        let outstanding: number | null = null;
        if (vendorInvoiceId) {
          const inv = await tx.vendorInvoice.findUnique({ where: { id: vendorInvoiceId } });
          if (inv) {
            const priorPaid = await tx.payment.aggregate({
              where: { vendorInvoiceId, status: 'PAID', isCancelled: false },
              _sum: { paidAmount: true }
            });
            outstanding = inv.amount - (inv.advanceApplied || 0) - (priorPaid._sum.paidAmount || 0);
          }
        } else if (targetPoId) {
          const po = await tx.procurementOrder.findUnique({ where: { id: targetPoId } });
          if (po) outstanding = po.totalAmount - (po.paid || 0);
        }
        if (outstanding !== null && amount > outstanding + 0.01) {
          throw new Error(`Payment of ₹${amount} exceeds the outstanding balance of ₹${Math.max(0, outstanding).toFixed(2)}. Pass allowOverpayment to record the excess as a vendor advance instead.`);
        }
      }

      // Centralized Payment, Account Adjustment, and VendorLedger posting —
      // all in one place (FinanceService.createPayment). This function used
      // to ALSO write its own VendorLedger DEBIT row for the same payment
      // right after this call, which is exactly how one payment ended up as
      // two identical "Payment Out" ledger rows under the same reference.
      const payment = await FinanceService.createPayment({
        tx,
        amount,
        type: type === 'ADVANCE' ? 'ADVANCE' : 'INVOICE_LINKED',
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: accountId,
        method: resolvedMode,
        sourceModule: 'PROCUREMENT',
        linkedDocType: vendorInvoiceId ? 'INVOICE' : (targetPoId ? 'PO' : 'DIRECT'),
        linkedDocId: vendorInvoiceId || targetPoId,
        vendorInvoiceId: vendorInvoiceId,
        entityType: 'VENDOR',
        entity: vendorId,
        createdBy: 'PROCUREMENT_MODULE',
        note: note,
        reference: transactionRef,
        idempotencyKey,
        createdAt: date
      });

      // Update PO Payment status if linked (directly, or via the invoice's PO)
      if (targetPoId) {
        const po = await tx.procurementOrder.findUnique({ where: { id: targetPoId } });
        if (po) {
          const newPaid = (po.paid || 0) + Math.min(amount, po.totalAmount - (po.paid || 0));
          await tx.procurementOrder.update({
            where: { id: targetPoId },
            data: {
              paid: newPaid,
              balance: Math.max(0, Number((po.totalAmount - newPaid).toFixed(2))),
              status: (po.totalAmount - newPaid <= 0.01 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
            }
          });
        }
      }

      // Invoice status (PAID once cash+advance cover the gross amount) is
      // already handled inside FinanceService.createPayment, which checks
      // the actual paid total instead of blindly marking PAID regardless of
      // whether `amount` covered the invoice — no need to repeat it here.

      // Settle against any available advance
      await this.settleVendorOrders(vendorId, tx);

      return payment;
    }, { maxWait: 5000, timeout: 20000 });
  }

  static async settleVendorOrders(vendorId: string, txParam?: any) {
    const execute = async (tx: any) => {
      // 1. Calculate total DEBIT entries (payments, advances, returns)
      const entries = await tx.vendorLedger.findMany({
        where: { vendorId }
      });
      const totalPaidToThem = entries
        .filter((e: any) => e.type === 'DEBIT')
        .reduce((s: number, e: any) => s + (e.amount || 0), 0);

      // 2. Calculate the sum of po.paid for all orders (excluding cancelled)
      const allPOs = await tx.procurementOrder.findMany({
        where: { vendorId, status: { not: 'CANCELLED' } }
      });
      const totalPOPaid = allPOs.reduce((s: number, p: any) => s + (p.paid || 0), 0);

      // 3. The difference is the unapplied advance/payment balance
      let availableAdvance = Math.max(0, totalPaidToThem - totalPOPaid);

      if (availableAdvance <= 0.01) return;

      // 4. Find all outstanding orders (APPROVED or RECEIVED, not closed, having remaining balance)
      const outstandingOrders = await tx.procurementOrder.findMany({
        where: { 
          vendorId, 
          status: { in: ['APPROVED', 'RECEIVED'] },
          balance: { gt: 0 }
        },
        orderBy: { createdAt: 'asc' }
      });

      for (const po of outstandingOrders) {
        if (availableAdvance <= 0.01) break;
        const currentPaid = po.paid || 0;
        const remainingDue = Math.max(0, po.totalAmount - currentPaid);
        if (remainingDue > 0) {
          const amountToApply = Math.min(remainingDue, availableAdvance);
          const newPaid = Number((currentPaid + amountToApply).toFixed(2));
          const newBalance = Math.max(0, Number((po.totalAmount - newPaid).toFixed(2)));
          
          await tx.procurementOrder.update({
            where: { id: po.id },
            data: {
              paid: newPaid,
              balance: newBalance,
              status: (newBalance <= 0.01 && po.status === 'RECEIVED') ? 'CLOSED' : po.status
            }
          });
          availableAdvance -= amountToApply;
        }
      }
    };

    if (txParam) {
      await execute(txParam);
    } else {
      await prisma.$transaction(async (tx) => execute(tx), { maxWait: 5000, timeout: 20000 });
    }
  }

  static async recordAdjustment(vendorId: string, amount: number, type: 'CREDIT' | 'DEBIT', note: string, referenceType: any = 'ADJUSTMENT', referenceId?: string) {
    const nextBalance = await prisma.$transaction(async (tx) => {
      return this.getNextBalance(tx, vendorId, amount, type);
    }, { maxWait: 5000, timeout: 20000 });
    
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

  static async getNextPaymentNumber(dateStr?: string) {
    // Build the day boundaries from local calendar components (not toISOString(),
    // which renders in UTC and silently shifts the date by a day whenever the
    // server's local timezone has a non-zero UTC offset — e.g. IST). The ID should
    // reflect the actual transaction date the user selected, not a UTC-shifted one.
    const target = dateStr ? new Date(dateStr) : new Date();
    const startOfDay = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 23, 59, 59, 999);

    // Find all payments created on that date for vendors
    const count = await prisma.payment.count({
      where: {
        createdAt: { gte: startOfDay, lte: endOfDay },
        entityType: 'VENDOR'
      }
    });

    const yyyymmdd = `${target.getFullYear()}${String(target.getMonth() + 1).padStart(2, '0')}${String(target.getDate()).padStart(2, '0')}`;
    const nextSeq = String(count + 1).padStart(4, '0');
    return { nextPaymentNumber: `VPAY-${yyyymmdd}-${nextSeq}` };
  }

  private static async generateOpeningBalanceNumber(tx: any): Promise<string> {
    const obCount = await tx.vendorLedger.count({
      where: { referenceType: 'OPENING_BALANCE' }
    });
    return `OB-${String(obCount + 1).padStart(4, '0')}`;
  }
}
