import prisma from '../../lib/prisma';
import { AccountService } from './account.service';
import { POSService } from '../pos/pos.service';
import { ItemCategory } from '@prisma/client';

export class FinanceService {
  /**
   * Automatically generate an Invoice for a completed order
   */
  static async createInvoiceFromOrder(orderId: string) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId }
      });

      if (!order) throw new Error('Order not found');

      // 1. Calculate Tax (5% GST as per Phase 5 instructions)
      const subTotal = order.subTotal;
      const taxAmount = Number((subTotal * 0.05).toFixed(2));
      const finalAmount = subTotal + taxAmount;

      // 2. Create Invoice
      const invoice = await tx.invoice.upsert({
        where: { orderId },
        update: {
          totalAmount: subTotal,
          taxAmount: taxAmount,
          finalAmount: finalAmount,
          status: 'PAID' // Default since POS orders are usually paid at completion
        },
        create: {
          orderId,
          totalAmount: subTotal,
          taxAmount: taxAmount,
          finalAmount: finalAmount,
          status: 'PAID'
        }
      });

      // 3. Link existing payments to this invoice (if any)
      await tx.payment.updateMany({
        where: { orderId },
        data: { invoiceId: invoice.id }
      });

      return invoice;
    });
  }

  /**
   * Automatically log an Expense when a Purchase is received
   */
  static async recordExpenseFromPurchase(poId: string) {
    const po = await prisma.procurementOrder.findUnique({
      where: { id: poId },
      include: { vendor: true }
    });

    if (!po) throw new Error('Purchase Order not found');

    return prisma.expense.create({
      data: {
        category: 'RAW_MATERIAL_PURCHASE',
        amount: po.totalAmount,
        description: `Purchase from ${po.vendor.name} (PO: ${po.id})`,
        purchaseOrderId: po.id
      }
    });
  }

  /**
   * Comprehensive Financial Reports (Reports → Profit & Loss)
   * Delegates to getProfitAndLoss so both this and the `detailed=true`
   * endpoint variant return the same fully-populated shape (revenue, cogs,
   * purchase, tax, grossProfit, expenses, netProfit) instead of the two
   * diverging, partially-empty objects this used to compute separately.
   */
  static async getFinancialReport(filters: { franchiseId?: string; startDate?: Date; endDate?: Date }) {
    return this.getProfitAndLoss(filters);
  }

  /**
   * Profit & Loss with COGS logic
   */
  static async getProfitAndLoss(filters: { franchiseId?: string; startDate?: Date; endDate?: Date }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    // 1. Revenue
    const sales = await prisma.invoice.findMany({
      where: {
        status: 'PAID',
        ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
        order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined
      },
      include: { order: { include: { orderItems: { include: { product: { include: { recipe: { include: { recipeItems: { include: { inventoryItem: { include: { vendors: true } } } } } } } } } } } } }
    });

    // Fetch all inventory items for mapping
    const inventoryItems = await prisma.inventoryItem.findMany({
      where: filters.franchiseId ? { franchiseId: filters.franchiseId } : {}
    });
    const invItemMap = new Map(inventoryItems.map(i => [i.sku, i]));

    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalOutputTax = 0;

    for (const inv of sales) {
      if (!inv.order) continue;
      totalRevenue += inv.finalAmount;
      totalOutputTax += inv.taxAmount || 0;
      for (const item of inv.order.orderItems) {
        // `totalCost` is captured at sale time (see pos.service.ts) from the
        // actual FIFO lot(s)/production batch this line drew from — the real
        // cost of THIS sale, frozen at the moment it happened. Prefer it over
        // recomputing from today's live costPrice, which drifts every time a
        // new purchase lands and would silently re-cost old, already-booked sales.
        if (item.totalCost !== null && item.totalCost !== undefined) {
          totalCOGS += item.totalCost;
          continue;
        }

        // Fallback for orders recorded before cost capture existed.
        const product = item.product;
        if (product) {
          if (product.recipe) {
            const scalar = item.quantity / product.recipe.yieldQty;
            for (const ri of product.recipe.recipeItems) {
              const qtyUsed = ri.quantityRequired * scalar;
              const costPerUnit = ri.inventoryItem.costPrice || ri.inventoryItem.vendors[0]?.price || 0;
              totalCOGS += (qtyUsed * costPerUnit);
            }
          } else {
            // Direct product: get average buying/purchase cost from InventoryItem with matching SKU
            const invItem = invItemMap.get(product.sku || '');
            const costPerUnit = invItem?.costPrice || 0;
            totalCOGS += (item.quantity * costPerUnit);
          }
        }
      }
    }

    // 2. Purchases — posted (non-cancelled) procurement, plus the input tax
    // booked against those POs. Same aggregate pattern as getTrialBalance/
    // getBalanceSheetReport, so all three reports agree on what "Purchase" means.
    const purchaseAggregate = await prisma.procurementOrder.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: 'CANCELLED' },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { totalAmount: true, cgst: true, sgst: true, igst: true }
    });
    const totalPurchases = purchaseAggregate._sum.totalAmount || 0;
    const totalInputTax = (purchaseAggregate._sum.cgst || 0) + (purchaseAggregate._sum.sgst || 0) + (purchaseAggregate._sum.igst || 0);

    // 3. Expenses
    const expenses = await prisma.expense.aggregate({
      where: {
        ...(filters.startDate || filters.endDate ? { date: dateQuery } : {}),
        franchiseId: filters.franchiseId,
        isCancelled: false
      },
      _sum: { amount: true }
    });

    const totalExpenses = expenses._sum.amount || 0;
    const grossProfit = totalRevenue - totalCOGS;

    return {
      revenue: totalRevenue,
      cogs: totalCOGS,
      purchase: totalPurchases,
      taxPayable: totalOutputTax,
      taxReceivable: totalInputTax,
      tax: totalOutputTax,
      grossProfit: grossProfit,
      expenses: totalExpenses,
      netProfit: grossProfit - totalExpenses,
      period: filters
    };
  }

  /**
   * Generates a list of all inventory stock items with their stock value
   * calculated using their average purchase cost (costPrice).
   */
  static async getInventoryValuationReport(franchiseId?: string) {
    const items = await prisma.inventoryItem.findMany({
      where: franchiseId ? { franchiseId } : {},
      orderBy: { name: 'asc' }
    });

    let totalStockValue = 0;
    const reportItems = items.map(item => {
      const stockInHand = item.currentStock || 0;
      const unitCost = item.costPrice || 0;
      const stockValue = stockInHand * unitCost;
      totalStockValue += stockValue;

      return {
        id: item.id,
        name: item.name,
        sku: item.sku,
        hsn: item.hsnCode,
        unit: item.unit,
        stockInHand,
        unitCost,
        stockValue
      };
    });

    // Calculate share of total value
    const itemsWithShare = reportItems.map(item => ({
      ...item,
      shareOfTotalValue: totalStockValue > 0 ? (item.stockValue / totalStockValue) * 100 : 0
    }));

    return {
      summary: {
        totalItemsCount: items.length,
        totalStockValue
      },
      items: itemsWithShare
    };
  }

  /**
   * Comprehensive Ledger Summary for Reports
   */
  static async getLedgerSummary(filters: { franchiseId?: string; startDate?: Date; endDate?: Date }) {
    const dateQuery = {
      ...(filters.startDate || filters.endDate ? { gte: filters.startDate, lte: filters.endDate } : {})
    };

    const [invoiced, collected, expenseBilled, expensePaid] = await Promise.all([
      // 1. Total Invoiced (Accrual)
      prisma.invoice.aggregate({
        where: { ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}), order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined },
        _sum: { finalAmount: true },
        _count: { id: true }
      }),
      // 2. Total Collected (Cash)
      prisma.payment.aggregate({
        where: { 
          entityType: 'CUSTOMER', 
          status: 'PAID', 
          ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}), 
          order: filters.franchiseId ? { franchiseId: filters.franchiseId } : undefined 
        },
        _sum: { paidAmount: true }
      }),
      // 3. Total Expense Billed (Accrual)
      prisma.expense.aggregate({
        where: { ...(filters.startDate || filters.endDate ? { date: dateQuery } : {}), franchiseId: filters.franchiseId },
        _sum: { amount: true },
        _count: { id: true }
      }),
      // 4. Total Expense Paid (Cash)
      prisma.payment.aggregate({
        where: { 
          sourceModule: 'EXPENSE', 
          status: 'PAID', 
          ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}), 
          // Linkage check (optional if sourceModule is enough)
        },
        _sum: { paidAmount: true }
      })
    ]);

    const totalInvoiced = invoiced._sum?.finalAmount || 0;
    const totalCollected = collected._sum?.paidAmount || 0;
    const totalExpBilled = expenseBilled._sum?.amount || 0;
    const totalExpPaid = expensePaid._sum?.paidAmount || 0;

    return {
      invoices: {
        count: invoiced._count.id,
        total: totalInvoiced,
        received: totalCollected,
        due: Math.max(0, totalInvoiced - totalCollected)
      },
      expenses: {
        count: expenseBilled._count.id,
        total: totalExpBilled,
        paid: totalExpPaid,
        due: Math.max(0, totalExpBilled - totalExpPaid)
      },
      generatedAt: new Date()
    };
  }

  static async getCashFlow(franchiseId?: string | null) {

    const accounts = await prisma.account.findMany({
      where: franchiseId ? { franchiseId } : { franchiseId: null }
    });

    const totalCash = accounts.filter(a => a.type === 'CASH').reduce((s, a) => s + a.balance, 0);
    const totalBank = accounts.filter(a => a.type === 'BANK').reduce((s, a) => s + a.balance, 0);
    const totalUPI = accounts.filter(a => a.type === 'UPI').reduce((s, a) => s + a.balance, 0);

    return {
      accounts,
      totalLiquidity: totalCash + totalBank + totalUPI,
      breakdown: { cash: totalCash, bank: totalBank, upi: totalUPI }
    };
  }

  static async getInvoices(franchiseId?: string) {
    return prisma.invoice.findMany({
      where: franchiseId ? { order: { franchiseId } } : undefined,
      include: { 
        order: { 
          include: { 
            customer: true,
            orderItems: {
              include: {
                product: true
              }
            }
          } 
        }, 
        payments: true 
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async addExpense(data: any) {
    return prisma.$transaction(async (tx) => {
      // 1. Generate Expense Number
      const year = new Date().getFullYear();
      const count = await tx.expense.count({
        where: { date: { gte: new Date(year, 0, 1) } }
      });
      const expenseNumber = `EXP-${year}-${(count + 1).toString().padStart(4, "0")}`;

      const amount = data.amount;
      const initialPaidAmount = data.isPaidImmediately ? amount : 0;
      const status = data.isPaidImmediately ? "PAID" : "UNPAID";

      // 2. Create Expense
      const expense = await tx.expense.create({ 
        data: {
          expenseNumber,
          franchiseId: data.franchiseId,
          category: data.category,
          payee: data.payee,
          amount: amount,
          paidAmount: initialPaidAmount,
          description: data.note || data.description,
          date: data.date ? new Date(data.date) : new Date(),
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          status: status,
          accountId: data.accountId,
          paymentMode: data.paymentMode || 'CASH'
        } 
      });

      // 3. If PAID immediately and account provided, hit the ledger
      if (initialPaidAmount > 0 && data.accountId) {
        await this.createPayment({
          tx,
          amount: initialPaidAmount,
          flow: 'OUT',
          status: 'PAID',
          sourceAccount: data.accountId,
          method: expense.paymentMode || 'CASH',
          sourceModule: 'EXPENSE',
          linkedDocType: 'EXPENSE_BILL',
          linkedDocId: expense.id,
          entity: expense.payee || expense.category,
          createdBy: data.createdBy || 'SYSTEM'
        });
      }

      return expense;
    });
  }

  static async recordExpensePayment(expenseId: string, data: { amount: number, accountId: string, paymentMode: any, note?: string, createdBy?: string }) {
    return prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!expense) throw new Error("Expense not found");
      if (expense.isCancelled) throw new Error("Cannot pay a cancelled expense");

      const remaining = expense.amount - expense.paidAmount;
      if (data.amount > remaining + 0.01) { // small buffer for float
        throw new Error(`Payment amount ₹${data.amount} exceeds remaining balance ₹${remaining}`);
      }

      const newPaidAmount = expense.paidAmount + data.amount;
      const newStatus = newPaidAmount >= expense.amount - 0.01 ? "PAID" : "PARTIAL";

      // 1. Update Expense
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          paidAmount: newPaidAmount,
          status: newStatus,
          accountId: data.accountId, // Store last used account
          paymentMode: data.paymentMode
        }
      });

      // 2. Create Payment Record
      await this.createPayment({
        tx,
        amount: data.amount,
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: data.accountId,
        method: data.paymentMode,
        sourceModule: 'EXPENSE',
        linkedDocType: 'EXPENSE_BILL',
        linkedDocId: expense.id,
        entity: expense.payee || expense.category,
        transactionRef: data.note,
        createdBy: data.createdBy || 'SYSTEM'
      });

      return { success: true };
    });
  }

  static async cancelExpense(expenseId: string, cancelledBy?: string) {
    return prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id: expenseId } });
      if (!expense) throw new Error("Expense not found");
      if (expense.status === "PAID") throw new Error("Cannot cancel a fully paid expense. Please cancel the payments first.");

      // 1. Mark as cancelled
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          isCancelled: true,
          cancelledAt: new Date(),
          status: "CANCELLED"
        }
      });

      // 2. If there were partial payments, they should probably be reversed?
      // For now, enterprise logic usually requires manual reversal of payments to maintain audit trail.
      // But we can check if there are any payments linked and warn.

      return { success: true };
    });
  }

  static async getExpenseDetails(expenseId: string) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { account: true }
    });

    if (!expense) throw new Error("Expense not found");

    const payments = await prisma.payment.findMany({
      where: {
        linkedDocId: expenseId,
        linkedDocType: 'EXPENSE_BILL',
        isCancelled: false
      },
      orderBy: { createdAt: 'desc' }
    });

    return {
      ...expense,
      payments
    };
  }

  static async getExpenses(franchiseId?: string, startDate?: string, endDate?: string) {
    const where: any = {
      ...(franchiseId ? { franchiseId } : {}),
      isCancelled: false
    };
    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }
    return prisma.expense.findMany({
      where,
      include: { account: true },
      orderBy: { date: 'desc' }
    });
  }

  static async getPayments(franchiseId?: string) {
    const payments = await prisma.payment.findMany({
      where: {
        ...(franchiseId ? { order: { franchiseId } } : {}),
      },
      include: { order: true, invoice: true, account: true },
      orderBy: { createdAt: 'desc' }
    });

    return payments.map(p => ({
      id: p.id,
      paymentNumber: p.paymentNumber,
      date: p.createdAt.toISOString(),
      entity: p.entityId || p.transactionRef || "Manual Entry",
      flow: p.entityType === 'VENDOR' ? 'OUT' : 'IN',
      method: p.paymentMode,
      amount: p.paidAmount,
      status: p.status,
      reference: p.transactionRef || "",
      type: p.type,
      sourceModule: p.sourceModule,
      linkedDocType: p.linkedDocType,
      linkedDocId: p.linkedDocId,
      isCancelled: p.isCancelled,
      accountName: p.account?.name || "Unknown",
    }));
  }

  static async getGstReportData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [sales, purchases] = await Promise.all([
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          ...dateFilter,
          status: 'COMPLETED'
        },
        include: { customer: true }
      }),
      prisma.procurementOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          ...dateFilter,
          status: 'DELIVERED'
        },
        include: { vendor: true }
      })
    ]);

    const partyMap: Record<string, { partyName: string; saleTax: number; purchaseTax: number }> = {};

    // Process sales (Tax In / Sale Tax)
    sales.forEach(s => {
      const name = s.customer?.name || "Cash Customer";
      if (!partyMap[name]) {
        partyMap[name] = { partyName: name, saleTax: 0, purchaseTax: 0 };
      }
      partyMap[name].saleTax += s.taxAmount || 0;
    });

    // Process purchases (Tax Out / Purchase Tax)
    purchases.forEach(p => {
      const name = p.vendor?.name || "Raw Material Vendor";
      if (!partyMap[name]) {
        partyMap[name] = { partyName: name, saleTax: 0, purchaseTax: 0 };
      }
      partyMap[name].purchaseTax += (p.cgst || 0) + (p.sgst || 0) + (p.igst || 0);
    });

    const data = Object.values(partyMap);
    const totalTaxIn = data.reduce((acc, r) => acc + r.saleTax, 0);
    const totalTaxOut = data.reduce((acc, r) => acc + r.purchaseTax, 0);

    return { data, totalTaxIn, totalTaxOut };
  }

  static async getGstRateReportData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), ...dateFilter, status: 'COMPLETED' },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), ...dateFilter, status: 'DELIVERED' },
        include: { poItems: true }
      })
    ]);

    const knownBrackets = [5, 12, 18, 28];
    const rateMap: Record<number, { taxName: string; taxPercent: number; taxableSaleAmount: number; taxIn: number; taxablePurchaseAmount: number; taxOut: number }> = {};

    knownBrackets.forEach(b => {
      rateMap[b] = { taxName: `GST ${b}%`, taxPercent: b, taxableSaleAmount: 0, taxIn: 0, taxablePurchaseAmount: 0, taxOut: 0 };
    });

    const nearestBracket = (rate: number) =>
      knownBrackets.reduce((prev, curr) => Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev, 5);

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const rate = item.product?.taxPercent ?? 5;
        const bracket = nearestBracket(rate);
        if (rateMap[bracket]) {
          const itemSubtotal = (item.quantity || 0) * (item.price || 0);
          rateMap[bracket].taxableSaleAmount += itemSubtotal;
          rateMap[bracket].taxIn += item.taxAmount || 0;
        }
      });
    });

    purchases.forEach(p => {
      p.poItems.forEach(item => {
        const rate = item.gstRate ?? 5;
        const bracket = nearestBracket(rate);
        if (rateMap[bracket]) {
          rateMap[bracket].taxablePurchaseAmount += item.subtotal || 0;
          rateMap[bracket].taxOut += (item.cgst || 0) + (item.sgst || 0) + (item.igst || 0);
        }
      });
    });

    const data = Object.values(rateMap).map(r => ({
      ...r,
      taxableSaleAmount: Number(r.taxableSaleAmount.toFixed(2)),
      taxIn: Number(r.taxIn.toFixed(2)),
      taxablePurchaseAmount: Number(r.taxablePurchaseAmount.toFixed(2)),
      taxOut: Number(r.taxOut.toFixed(2))
    }));

    return {
      data,
      totalTaxIn: Number(data.reduce((acc, r) => acc + r.taxIn, 0).toFixed(2)),
      totalTaxOut: Number(data.reduce((acc, r) => acc + r.taxOut, 0).toFixed(2))
    };
  }

  static async getTcsReceivableData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const sales = await prisma.order.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter,
        status: 'COMPLETED'
      },
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });

    const data = sales.map(s => {
      const tcsAmount = s.totalAmount * 0.01; // TCS 1%
      return {
        partyName: s.customer?.name || "Cash Customer",
        billNo: s.invoiceNum,
        totalValue: s.totalAmount,
        amountPaid: s.totalAmount,
        tcsAmount,
        date: s.createdAt.toISOString(),
        taxName: "TCS 1%",
        rate: 1
      };
    });

    const totalPurchaseWithTcs = data.reduce((acc, r) => acc + r.totalValue, 0);
    const totalTcs = data.reduce((acc, r) => acc + r.tcsAmount, 0);

    return { data, totalPurchaseWithTcs, totalTcs };
  }

  static async getTdsPayableData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const purchases = await prisma.procurementOrder.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter,
        status: 'DELIVERED'
      },
      include: { vendor: true },
      orderBy: { createdAt: 'desc' }
    });

    const data = purchases.map(p => {
      const tdsAmount = p.subtotal * 0.01; // TDS 1% under 194Q
      return {
        partyName: p.vendor?.name || "Raw Material Vendor",
        transactionType: "PURCHASE",
        billNo: p.poNumber || "PO-REF",
        totalAmount: p.totalAmount,
        taxableAmount: p.subtotal,
        tdsAmount,
        date: p.createdAt.toISOString(),
        taxName: "TDS 194Q",
        section: "194Q",
        rate: 1
      };
    });

    const totalPurchaseWithTds = data.reduce((acc, r) => acc + r.taxableAmount, 0);
    const totalTds = data.reduce((acc, r) => acc + r.tdsAmount, 0);

    return { data, totalPurchaseWithTds, totalTds };
  }

  static async getTdsReceivableData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const sales = await prisma.order.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter,
        status: 'COMPLETED'
      },
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });

    const data = sales.map(s => {
      const tdsAmount = s.subTotal * 0.01; // TDS 1%
      return {
        partyName: s.customer?.name || "Cash Customer",
        transactionType: "SALE",
        invoiceNo: s.invoiceNum,
        totalAmount: s.totalAmount,
        taxableAmount: s.subTotal,
        tdsAmount,
        date: s.createdAt.toISOString(),
        taxName: "TDS 194Q",
        section: "194Q",
        rate: 1
      };
    });

    const totalSaleWithTds = data.reduce((acc, r) => acc + r.taxableAmount, 0);
    const totalTds = data.reduce((acc, r) => acc + r.tdsAmount, 0);

    return { data, totalSaleWithTds, totalTds };
  }

  static async getForm27eqData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const sales = await prisma.order.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter,
        status: 'COMPLETED'
      },
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });

    const data = sales.map(s => {
      const tcsAmount = s.totalAmount * 0.01; // TCS 1%
      return {
        partyName: s.customer?.name || "Cash Customer",
        invoiceNo: s.invoiceNum,
        totalValue: s.totalAmount,
        amountReceived: s.totalAmount,
        tcsAmount,
        date: s.createdAt.toISOString(),
        taxName: "TCS 206C",
        rate: 1
      };
    });

    const totalSaleWithTcs = data.reduce((acc, r) => acc + r.totalValue, 0);
    const totalTcs = data.reduce((acc, r) => acc + r.tcsAmount, 0);

    return { data, totalSaleWithTcs, totalTcs };
  }


  /**
   * Central Ledger Entry Creation
   */
  static async createPayment(data: any) {
    const amount    = parseFloat(data.amount);
    const flow      = data.flow as 'IN' | 'OUT';       
    const status    = (data.status || 'PAID') as string;
    const sourceId = data.sourceAccount as string;    
    const sourceModule = (data.sourceModule || 'MANUAL');
    const linkedDocType = data.linkedDocType || 'DIRECT';
    const linkedDocId = data.linkedDocId;
    const entityId = data.entityId || data.entity; // Compatibility with both naming conventions

    // Robust type mapping for cross-module compatibility
    let paymentType = data.type || 'DIRECT';
    console.log(`[FinanceService] Incoming payment type: ${data.type}, Resolved to: ${paymentType}`);
    if (paymentType === 'PAYMENT') {
      paymentType = 'INVOICE_LINKED';
      console.log(`[FinanceService] Remapped PAYMENT to INVOICE_LINKED`);
    }

    if (flow !== 'IN' && flow !== 'OUT') {
      throw new Error('Invalid payment direction. Must be IN or OUT.');
    }

    const accountTypeMap: Record<string, string> = {
      CASH_ACCOUNT: 'CASH',
      BANK_ACCOUNT: 'BANK',
      UPI_WALLET:   'UPI',
      CASH: 'CASH',
      BANK: 'BANK',
      UPI: 'UPI',
      CARD: 'BANK', // Map CARD to BANK type
      WALLET: 'UPI'  // Map WALLET to UPI type
    };
    const accountType = accountTypeMap[sourceId] ?? accountTypeMap[data.method] ?? 'CASH';

    const paymentModeMap: Record<string, string> = {
      CASH: 'CASH',
      UPI: 'UPI',
      CARD: 'CARD',
      BANK: 'BANK_TRANSFER',
      BANK_TRANSFER: 'BANK_TRANSFER',
      CHEQUE: 'CHEQUE',
      NEFT: 'NEFT',
      CREDIT: 'CASH', // Default CREDIT to CASH
      ADVANCE: 'CASH' // Default ADVANCE to CASH
    };
    const resolvedPaymentMode = paymentModeMap[data.method] || paymentModeMap[sourceId] || 'CASH';

    const operation = async (tx: any) => {
      // 0. Idempotency: a retry/double-click/API re-entry carrying the same
      // key must return the ALREADY-created payment instead of posting a
      // second one. Checked first so a fast in-transaction re-entry never
      // reaches the ledger-write step below; the `idempotencyKey` column's
      // unique constraint is the hard backstop for a true concurrent race
      // (two requests both passing this check before either commits).
      if (data.idempotencyKey) {
        const existing = await tx.payment.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (existing) return existing;
      }

      // 1. Resolve account (Prefer ID, fallback to Type mapping)
      let account;
      if (sourceId && sourceId.length > 20) { // Likely a UUID
         account = await tx.account.findUnique({ where: { id: sourceId } });
      } 
      
      // Fallback if no account found by ID or if sourceId is a Type string
      if (!account) {
         account = await tx.account.findFirst({
           where: { 
             type: accountType as any,
             franchiseId: data.franchiseId || null
           }
         });
      }

      // 2. Balance check for OUTFLOW + PAID
      if (flow === 'OUT' && status === 'PAID') {
        if (!account) throw new Error(`Source account not found. Please create a ${accountType} account first.`);
        if (account.balance < amount) {
          throw new Error(`Insufficient balance in ${account.name}. Available: ₹${account.balance}`);
        }
      }

      // 2b. Overpayment guard for a Tax Invoice receipt — the invoice's
      // paid/outstanding split is computed by summing Payment rows (see
      // step 6 below), so a payment that pushes the total past what's owed
      // would silently produce a negative outstanding balance downstream.
      if (data.invoiceId && flow === 'IN' && status === 'PAID') {
        const invoiceForGuard = await tx.invoice.findUnique({ where: { id: data.invoiceId } });
        if (!invoiceForGuard) throw new Error('Invoice not found.');
        const paidSoFar = await tx.payment.aggregate({
          where: { invoiceId: data.invoiceId, status: 'PAID', isCancelled: false },
          _sum: { paidAmount: true },
        });
        const alreadyPaid = paidSoFar._sum.paidAmount || 0;
        const outstanding = invoiceForGuard.finalAmount - alreadyPaid;
        if (amount > outstanding + 0.01) {
          throw new Error(`Payment amount (₹${amount}) exceeds the outstanding balance (₹${outstanding.toFixed(2)}) on this invoice.`);
        }
      }

      // 3. Generate Payment Number
      // NOTE: was previously `data.entityType === 'VENDOR' || flow === 'OUT'`, which
      // mislabeled every non-vendor outflow (payroll, expenses, franchise settlements)
      // as a vendor payment (VPAY-prefixed number sharing the vendor daily counter).
      const isVendorPayment = data.entityType === 'VENDOR';
      const paymentNumber = await this.generatePaymentNumber(tx, isVendorPayment);

      // 4. Create the payment record
      const payment = await tx.payment.create({
        data: {
          paymentNumber,
          paidAmount:     amount,
          type:           paymentType as any,
          sourceModule:   sourceModule as any,
          linkedDocType:  linkedDocType as any,
          linkedDocId:    linkedDocId,
          vendorInvoiceId: data.vendorInvoiceId,
          invoiceId:      data.invoiceId || undefined,
          entityType:     data.entityType || (flow === 'OUT' ? 'VENDOR' : 'CUSTOMER'),
          entityId:       entityId,
          paymentMode:    resolvedPaymentMode as any,
          transactionRef: data.reference || data.note || undefined,
          status,
          accountId:      account?.id ?? undefined,
          createdBy:      data.createdBy,
          idempotencyKey: data.idempotencyKey || undefined,
          createdAt:      data.createdAt ? new Date(data.createdAt) : undefined,
        },
      });

      // 5. If this is a Vendor Payment, record in VendorLedger (CREDIT)
      // NOTE: was previously `data.entityType === 'VENDOR' || flow === 'OUT'`, which
      // caused any outgoing payment (e.g. payroll, entityType: 'EMPLOYEE') to write an
      // orphaned VendorLedger row keyed by a non-vendor id. Every real vendor-payment
      // call site already passes entityType: 'VENDOR' explicitly, so this fallback
      // was both unnecessary and incorrect.
      if (data.entityType === 'VENDOR') {
        const vendorId = entityId;
        if (vendorId) {
          const lastEntry = await tx.vendorLedger.findFirst({
            where: { vendorId },
            orderBy: { createdAt: 'desc' }
          });
          const currentBalance = lastEntry ? lastEntry.balanceAfterTransaction : 0;
          
          const isOutflow = flow === 'OUT';
          await tx.vendorLedger.create({
            data: {
              vendorId,
              type: isOutflow ? 'DEBIT' : 'CREDIT',
              amount: amount,
              balanceAfterTransaction: isOutflow ? currentBalance - amount : currentBalance + amount,
              sourceModule: sourceModule as any,
              referenceType: data.type === 'ADVANCE' ? 'ADVANCE' : 'PAYMENT',
              referenceId: payment.id,
              invoiceId: data.vendorInvoiceId,
              accountId: account?.id,
              paymentMode: resolvedPaymentMode as any,
              note: data.note || `Payment #${paymentNumber} recorded`,
              createdAt: data.createdAt ? new Date(data.createdAt) : undefined
            }
          });

          // Update Invoice Status if linked
          if (data.vendorInvoiceId) {
             const inv = await tx.vendorInvoice.findUnique({ where: { id: data.vendorInvoiceId } });
             if (inv) {
                // Check if fully paid: cash/bank payments PLUS whatever advance
                // was already applied to this invoice must cover the gross
                // amount — advance settles the invoice too, it just isn't a
                // Payment row, so leaving it out of this sum under-counted
                // how much of the invoice was actually settled.
                const totalPaid = await tx.payment.aggregate({
                   where: { vendorInvoiceId: data.vendorInvoiceId, status: 'PAID', isCancelled: false },
                   _sum: { paidAmount: true }
                });
                const total = (totalPaid._sum.paidAmount || 0) + (inv.advanceApplied || 0);
                if (total >= inv.amount - 0.01) {
                   await tx.vendorInvoice.update({
                      where: { id: data.vendorInvoiceId },
                      data: { status: 'PAID' }
                   });
                }
             }
          }
        }
      }

      // 5b. Customer payment against a Tax Invoice — recompute paid/
      // outstanding/status from the actual sum of Payment rows every time
      // (never trust a client-supplied status), and mirror it onto the
      // Order the Invoice belongs to so both records agree. This is the
      // ONLY place a Tax Invoice's payment status is allowed to change —
      // it is never settable directly by the frontend.
      if (data.invoiceId && status === 'PAID') {
        const invoiceRow = await tx.invoice.findUnique({ where: { id: data.invoiceId } });
        if (invoiceRow) {
          const totalPaid = await tx.payment.aggregate({
            where: { invoiceId: data.invoiceId, status: 'PAID', isCancelled: false },
            _sum: { paidAmount: true },
          });
          const paidSoFar = totalPaid._sum.paidAmount || 0;
          // 'PARTIAL' (not 'PARTIALLY_PAID') to match the existing status
          // vocabulary already used by /sales/invoices' status badge map.
          const newStatus = paidSoFar >= invoiceRow.finalAmount - 0.01
            ? 'PAID'
            : paidSoFar > 0
            ? 'PARTIAL'
            : 'UNPAID';
          await tx.invoice.update({ where: { id: data.invoiceId }, data: { status: newStatus } });
          await tx.order.update({ where: { id: invoiceRow.orderId }, data: { paymentStatus: newStatus } });
        }
      }

      // 5. Update account balance — ONLY if status is PAID
      if (account && status === 'PAID') {
        await AccountService.adjustBalance(
          tx, 
          account.id, 
          amount, 
          flow === 'IN' ? 'INFLOW' : 'OUTFLOW'
        );
      }

      return payment;
    };

    if (data.tx) {
      return operation(data.tx);
    }

    try {
      return await prisma.$transaction(async (tx) => operation(tx));
    } catch (err: any) {
      // True concurrent race: two requests both passed the idempotency
      // check (step 0) before either committed, and the loser hit the
      // idempotencyKey unique constraint, aborting its transaction. Query
      // with a fresh (non-aborted) client for the winner's row rather than
      // surfacing this as a failure to a legitimate retry.
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.payment.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /**
   * Internal Fund Transfer (Cash to Bank, etc)
   */
  static async transferFunds(data: { fromAccountId: string, toAccountId: string, amount: number, note?: string, createdBy?: string }) {
    return prisma.$transaction(async (tx) => {
      const fromAcc = await tx.account.findUnique({ where: { id: data.fromAccountId } });
      const toAcc = await tx.account.findUnique({ where: { id: data.toAccountId } });

      if (!fromAcc || !toAcc) throw new Error("Source or Destination account not found");
      if (fromAcc.balance < data.amount) throw new Error(`Insufficient balance in ${fromAcc.name}`);

      const pNum = await this.generatePaymentNumber(tx);

      // 1. Outflow from source
      await tx.payment.create({
        data: {
          paymentNumber: pNum,
          paidAmount: data.amount,
          type: 'INTERNAL_TRANSFER' as any,
          sourceModule: 'TRANSFER' as any,
          linkedDocType: 'TRANSFER' as any,
          paymentMode: fromAcc.type as any,
          status: 'PAID',
          accountId: fromAcc.id,
          transactionRef: `Transfer to ${toAcc.name}. ${data.note || ''}`,
          entityType: 'ACCOUNT',
          entityId: toAcc.id,
          createdBy: data.createdBy
        }
      });

      // 2. Inflow to destination
      await tx.payment.create({
        data: {
          paymentNumber: pNum + "-IN", // Sub-ref
          paidAmount: data.amount,
          type: 'INTERNAL_TRANSFER' as any,
          sourceModule: 'TRANSFER' as any,
          linkedDocType: 'TRANSFER' as any,
          paymentMode: toAcc.type as any,
          status: 'PAID',
          accountId: toAcc.id,
          transactionRef: `Transfer from ${fromAcc.name}. ${data.note || ''}`,
          entityType: 'ACCOUNT',
          entityId: fromAcc.id,
          createdBy: data.createdBy
        }
      });

      // 3. Update balances
      await tx.account.update({ where: { id: fromAcc.id }, data: { balance: { decrement: data.amount } } });
      await tx.account.update({ where: { id: toAcc.id }, data: { balance: { increment: data.amount } } });

      return { success: true };
    });
  }

  /**
   * Payment Cancellation (Soft Delete + Reversal Entry)
   */
  static async cancelPayment(paymentId: string, cancelledBy?: string) {
    return prisma.$transaction(async (tx) => {
      const original = await tx.payment.findUnique({ 
        where: { id: paymentId },
        include: { account: true }
      });

      if (!original) throw new Error("Payment not found");
      if (original.isCancelled) throw new Error("Payment already cancelled");

      // 1. Mark original as cancelled
      await tx.payment.update({
        where: { id: paymentId },
        data: { isCancelled: true, cancelledAt: new Date() }
      });

      // 2. If it was PAID, create reversal entry and restore balance
      if (original.status === 'PAID' && original.accountId) {
        const flow = original.entityType === 'VENDOR' ? 'OUT' : 'IN'; // Simplification
        const reversalAmount = original.paidAmount;

        const pNum = await this.generatePaymentNumber(tx);
        
        await tx.payment.create({
          data: {
            paymentNumber: pNum,
            type: 'REVERSAL' as any,
            sourceModule: original.sourceModule,
            linkedDocType: original.linkedDocType,
            linkedDocId: original.linkedDocId,
            paidAmount: reversalAmount,
            paymentMode: original.paymentMode,
            status: 'PAID',
            accountId: original.accountId,
            transactionRef: `REVERSAL of ${original.paymentNumber || original.id}`,
            reversalOfPaymentId: original.id,
            entityType: original.entityType,
            entityId: original.entityId,
            createdBy: cancelledBy
          }
        });

        // Restore balance: 
        // If original was OUT (decreased balance) -> Inflow (increase balance)
        // If original was IN (increased balance) -> Outflow (decrease balance)
        const isOriginalOutflow = (original.entityType === 'VENDOR' || original.type === 'EXPENSE');
        
        await tx.account.update({
          where: { id: original.accountId },
          data: {
            balance: {
              increment: isOriginalOutflow ? reversalAmount : -reversalAmount
            }
          }
        });
      }

      return { success: true };
    });
  }

  static async createInvoice(data: {
    franchiseId: string;
    customerId: string;
    items: {
      productId: string;
      qty: number;
      unit?: string;
      rate: number;
      gst: number;
      discount?: number;
      batchNumber?: string;
    }[];
    receivedAmount?: number;
    paymentMode?: any;
    discountAmount?: number;
    roundOff?: number;
    stateOfSupply?: string;
    paymentType?: string;
    termsAndConditions?: string;
    description?: string;
    notes?: string;
    createdBy?: string;
    invoiceNumber?: string;
  }) {
    // Order.franchiseId is a required FK — without this check, a caller with
    // no franchise context (e.g. SUPER_ADMIN with no branch selected) hit a
    // raw Prisma "Argument `franchise` is missing" error instead of a clear,
    // actionable message.
    if (!data.franchiseId) {
      throw new Error('A branch/franchise must be selected to create this invoice.');
    }

    return prisma.$transaction(async (tx) => {
      let subTotal = 0;
      let totalDiscount = data.discountAmount || 0;
      let totalTax = 0;

      const orderItemsData: {
        productId: string;
        quantity: number;
        unit: string;
        price: number;
        discountPct: number;
        taxAmount: number;
        totalAmount: number;
        batchNumber: string | null;
      }[] = [];

      for (const item of data.items) {
        const itemSubtotal = item.qty * item.rate;
        const itemDiscount = itemSubtotal * (item.discount || 0) / 100;
        const itemTaxableAmount = itemSubtotal - itemDiscount;
        const itemTax = itemTaxableAmount * (item.gst / 100);

        subTotal += itemSubtotal;
        if (!data.discountAmount) {
          totalDiscount += itemDiscount;
        }
        totalTax += itemTax;

        orderItemsData.push({
          productId: item.productId,
          quantity: item.qty,
          unit: item.unit || 'NONE',
          price: item.rate,
          discountPct: item.discount || 0,
          taxAmount: itemTax,
          totalAmount: itemSubtotal - itemDiscount + itemTax,
          batchNumber: item.batchNumber || null
        });
      }

      const totalAmount = subTotal + totalTax - totalDiscount;
      const year = new Date().getFullYear();
      // Atomic sequence (same NumberSequence pattern as payment/GRN numbers)
      // instead of COUNT()-based generation, which two invoices saved in the
      // same window could both read before either commits and land on the
      // identical number — Order.invoiceNum is DB-unique, so that used to
      // fail the second save outright rather than silently duplicate it.
      const seq = await this.nextPaymentSequence(tx, `INV_${year}`);
      const invoiceNum = data.invoiceNumber || `INV-${year}-${seq.toString().padStart(4, '0')}`;

      const received = data.receivedAmount || 0;
      let paymentStatus = 'UNPAID';
      if (received >= totalAmount - 0.01) {
        paymentStatus = 'PAID';
      } else if (received > 0) {
        paymentStatus = 'PARTIAL';
      }

      const roundOff = data.roundOff || 0;
      const finalAmount = totalAmount + roundOff;

      const order = await tx.order.create({
        data: {
          invoiceNum,
          customerId: data.customerId,
          franchiseId: data.franchiseId,
          orderType: 'DINE_IN',
          status: 'COMPLETED',
          subTotal,
          taxAmount: totalTax,
          discountAmount: totalDiscount,
          totalAmount: finalAmount,
          paymentStatus,
          paymentType: data.paymentType || 'CASH',
          stateOfSupply: data.stateOfSupply || null,
          inventory_deducted: false,
          orderItems: {
            create: orderItemsData
          }
        }
      });

      const invoice = await tx.invoice.create({
        data: {
          orderId: order.id,
          totalAmount: subTotal - totalDiscount,
          taxAmount: totalTax,
          finalAmount,
          roundOff,
          status: paymentStatus === 'PAID' ? 'PAID' : 'PENDING',
          termsAndConditions: data.termsAndConditions || null,
          description: data.description || null,
          notes: data.notes || null,
        }
      });

      if (received > 0) {
        const paymentMode = data.paymentMode || 'CASH';
        const accountTypeMap: Record<string, string> = {
          'CASH': 'CASH',
          'UPI': 'UPI',
          'CARD': 'BANK',
          'BANK_TRANSFER': 'BANK'
        };
        const targetType = accountTypeMap[paymentMode] || 'CASH';
        const defaultAccount = await tx.account.findFirst({
          where: { 
            type: targetType as any,
            franchiseId: data.franchiseId
          }
        });

        const paymentNumber = await tx.payment.count({
          where: { createdAt: { gte: new Date(year, 0, 1) } }
        });
        const pNum = `PAY-${year}-${(paymentNumber + 1).toString().padStart(4, '0')}`;

        await tx.payment.create({
          data: {
            orderId: order.id,
            invoiceId: invoice.id,
            paymentNumber: pNum,
            paidAmount: received,
            paymentMode: paymentMode as any,
            status: 'PAID',
            accountId: defaultAccount?.id ?? undefined,
            entityType: 'CUSTOMER',
            entityId: data.customerId,
            type: 'INVOICE_LINKED',
            sourceModule: 'POS',
            linkedDocType: 'INVOICE',
            linkedDocId: invoice.id,
            createdBy: data.createdBy || 'SYSTEM'
          }
        });

        if (defaultAccount) {
          await tx.account.update({
            where: { id: defaultAccount.id },
            data: { balance: { increment: received } }
          });
        }
      }

      await tx.customerLedger.create({
        data: {
          customerId: data.customerId,
          type: 'DEBIT',
          amount: totalAmount,
          paymentMode: data.paymentMode || 'CASH',
          referenceType: 'SALE',
          referenceId: order.id,
          note: `Tax Invoice Created — Invoice #${invoiceNum}`
        }
      });

      if (received > 0) {
        await tx.customerLedger.create({
          data: {
            customerId: data.customerId,
            type: 'CREDIT',
            amount: received,
            paymentMode: data.paymentMode || 'CASH',
            referenceType: 'PAYMENT',
            referenceId: order.id,
            note: `Payment Received for Invoice #${invoiceNum}`
          }
        });
      }

      // Automatically deduct inventory based on the items sold
      await POSService.deductInventoryIfNecessary(order.id, tx);

      return {
        ...invoice,
        order
      };
    });
  }

  static async getSalesReportDetails(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
    customerId?: string;
    paymentStatus?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 50));
    const skip = (page - 1) * limit;

    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const whereClause: any = {
      ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
      ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
      ...(filters.customerId ? { customerId: filters.customerId } : {}),
      ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus as any } : {})
    };

    const [totalCount, sales] = await Promise.all([
      prisma.order.count({ where: whereClause }),
      prisma.order.findMany({
        where: whereClause,
        include: {
          customer: true,
          payments: true,
          orderItems: {
            include: {
              product: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    const data = sales.map(order => {
      const paidAmount = order.paymentStatus === 'PAID' ? order.totalAmount : order.payments.reduce((sum, p) => sum + p.paidAmount, 0);
      return {
        id: order.id,
        createdAt: order.createdAt,
        invoiceNumber: order.invoiceNum,
        customerName: order.customer?.name || '—',
        orderType: order.orderType,
        paymentType: order.paymentType,
        total: order.totalAmount,
        paidAmount,
        balance: Math.max(0, order.totalAmount - paidAmount),
        items: order.orderItems.map(item => ({
          productId: item.productId,
          productName: item.product?.name || 'Unknown Product',
          qty: item.quantity,
          price: item.price,
          taxAmount: item.taxAmount,
          totalAmount: item.totalAmount,
          batchNumber: item.batchNumber || null
        })),
        isCancelled: order.status === 'CANCELLED',
        createdBy: 'System',
        approvedBy: 'System'
      };
    });

    return {
      data,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }

  static async getPurchasesReportDetails(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
    vendorId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    // A search hits the full matching set regardless of page size, so it
    // isn't limited to whatever page happened to load first.
    const limit = filters.search
      ? 100
      : Math.max(1, Math.min(100, Number(filters.limit) || 50));
    const skip = filters.search ? 0 : (page - 1) * limit;

    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const whereClause: any = {
      ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
      ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
      ...(filters.vendorId ? { vendorId: filters.vendorId } : {}),
      ...(filters.status ? { status: filters.status as any } : {}),
      ...(filters.search ? {
        OR: [
          { poNumber: { contains: filters.search, mode: 'insensitive' } },
          { vendor: { name: { contains: filters.search, mode: 'insensitive' } } }
        ]
      } : {})
    };

    const [totalCount, pos] = await Promise.all([
      prisma.procurementOrder.count({ where: whereClause }),
      prisma.procurementOrder.findMany({
        where: whereClause,
        include: {
          vendor: true,
          poItems: {
            include: {
              inventoryItem: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    const data = pos.map(po => {
      return {
        id: po.id,
        createdAt: po.createdAt,
        poNumber: po.poNumber || po.id,
        vendorName: po.vendor?.name || '—',
        status: po.status,
        paymentMode: po.paymentStatus === 'PAID' ? 'CASH' : 'CREDIT',
        totalAmount: po.totalAmount,
        advancePaid: po.paid || po.advancePaid || 0,
        balance: po.balance,
        items: po.poItems.map(item => ({
          itemId: item.inventoryItemId || item.id,
          itemName: item.inventoryItem?.name || 'Unknown Material',
          qty: item.quantity,
          price: item.price
        })),
        isCancelled: po.status === 'CANCELLED',
        createdBy: 'System',
        approvedBy: po.approvedBy || 'System'
      };
    });

    return {
      data,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }

  /**
   * Payment has no franchiseId column of its own — it's derived via the
   * (optional, to-one) account/order relations. A plain nested-relation OR
   * filter silently drops any Payment whose accountId AND orderId are both
   * null (most vendor/expense/manual payments, since createPayment doesn't
   * always resolve an account tied to the caller's franchise), which is why
   * Day Book / All Transactions were coming back empty even with real posted
   * payments in the DB. When franchiseId is unscoped (SUPER_ADMIN), skip the
   * filter entirely instead of building a no-op relation-existence check.
   */
  private static paymentFranchiseWhere(franchiseId?: string): any {
    if (!franchiseId) return {};
    return {
      OR: [
        { account: { franchiseId } },
        { order: { franchiseId } },
        { AND: [{ accountId: null }, { orderId: null }] }
      ]
    };
  }

  private static readonly PAYMENT_OUTFLOW_FILTER = {
    OR: [
      { entityType: 'VENDOR' },
      { sourceModule: 'EXPENSE' },
      { type: 'INTERNAL_TRANSFER' }
    ]
  };

  static async getDayBookReport(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
    paymentMode?: string;
    voucherType?: string;
    page?: number;
    limit?: number;
  }) {
    const franchiseWhere = this.paymentFranchiseWhere(filters.franchiseId);

    let openingBalance = 0;
    if (filters.startDate) {
      const preInflows = await prisma.payment.aggregate({
        where: {
          ...franchiseWhere,
          NOT: this.PAYMENT_OUTFLOW_FILTER,
          createdAt: { lt: filters.startDate },
          status: 'PAID',
          isCancelled: false
        },
        _sum: { paidAmount: true }
      });

      const preOutflows = await prisma.payment.aggregate({
        where: {
          AND: [franchiseWhere, this.PAYMENT_OUTFLOW_FILTER],
          createdAt: { lt: filters.startDate },
          status: 'PAID',
          isCancelled: false
        },
        _sum: { paidAmount: true }
      });

      const inflows = preInflows._sum.paidAmount || 0;
      const outflows = preOutflows._sum.paidAmount || 0;
      openingBalance = inflows - outflows;
    }

    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 50));
    const skip = (page - 1) * limit;

    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const whereClause: any = {
      ...franchiseWhere,
      status: 'PAID',
      isCancelled: false,
      ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
      ...(filters.paymentMode ? { paymentMode: filters.paymentMode as any } : {}),
      ...(filters.voucherType ? { sourceModule: filters.voucherType as any } : {})
    };

    const [totalCount, payments, rangeInAgg, rangeOutAgg] = await Promise.all([
      prisma.payment.count({ where: whereClause }),
      prisma.payment.findMany({
        where: whereClause,
        include: {
          order: {
            include: { customer: true }
          },
          account: true
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.payment.aggregate({ where: { ...whereClause, NOT: this.PAYMENT_OUTFLOW_FILTER }, _sum: { paidAmount: true } }),
      prisma.payment.aggregate({ where: { AND: [whereClause, this.PAYMENT_OUTFLOW_FILTER] }, _sum: { paidAmount: true } })
    ]);

    const data = payments.map(p => {
      const flow = p.entityType === 'VENDOR' || p.sourceModule === 'EXPENSE' || p.type === 'INTERNAL_TRANSFER' ? 'OUT' : 'IN';
      return {
        id: p.id,
        createdAt: p.createdAt,
        time: p.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        particulars: p.transactionRef || (p.entityType === 'VENDOR' ? 'Vendor Payment' : p.entityType === 'CUSTOMER' ? 'Customer Payment' : p.sourceModule || 'Direct Payment'),
        type: flow === 'IN' ? 'DEBIT' : 'CREDIT',
        voucherType: p.sourceModule || p.linkedDocType || 'Payment',
        voucherNo: p.paymentNumber || p.id,
        amount: p.paidAmount,
        isCancelled: p.isCancelled,
        createdBy: p.createdBy || 'System',
        approvedBy: p.approvedBy || 'System'
      };
    });

    // Sourced from full-range aggregates (not the paginated `data` slice above)
    // so the totals/closing balance stay correct once a period has more rows
    // than one page.
    const rangeInflows = rangeInAgg._sum.paidAmount || 0;
    const rangeOutflows = rangeOutAgg._sum.paidAmount || 0;

    return {
      data,
      openingBalance,
      closingBalance: openingBalance + rangeInflows - rangeOutflows,
      totalDebit: rangeInflows,
      totalCredit: rangeOutflows,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }

  static async getFinancialTransactionsReport(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.max(1, Math.min(100, Number(filters.limit) || 50));
    const skip = (page - 1) * limit;

    const dateQuery = {
      ...(filters.startDate || filters.endDate ? {
        gte: filters.startDate,
        lte: filters.endDate
      } : {})
    };

    const whereClause: any = {
      ...this.paymentFranchiseWhere(filters.franchiseId),
      isCancelled: false,
      ...(filters.startDate || filters.endDate ? { createdAt: dateQuery } : {}),
      ...(filters.status ? { status: filters.status } : { status: 'PAID' })
    };

    if (filters.type) {
      const isDebit = filters.type === 'DEBIT' || filters.type === 'IN';
      whereClause.entityType = isDebit ? { not: 'VENDOR' } : 'VENDOR';
    }

    const [totalCount, payments, inAgg, outAgg] = await Promise.all([
      prisma.payment.count({ where: whereClause }),
      prisma.payment.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.payment.aggregate({ where: { ...whereClause, NOT: this.PAYMENT_OUTFLOW_FILTER }, _sum: { paidAmount: true } }),
      prisma.payment.aggregate({ where: { AND: [whereClause, this.PAYMENT_OUTFLOW_FILTER] }, _sum: { paidAmount: true } })
    ]);

    const data = payments.map(p => {
      const flow = p.entityType === 'VENDOR' || p.sourceModule === 'EXPENSE' || p.type === 'INTERNAL_TRANSFER' ? 'OUT' : 'IN';
      return {
        id: p.id,
        createdAt: p.createdAt,
        refNo: p.paymentNumber || p.id,
        particulars: p.transactionRef || (p.entityType === 'VENDOR' ? 'Vendor Payment' : p.entityType === 'CUSTOMER' ? 'Customer Payment' : p.sourceModule || 'Direct Payment'),
        type: flow === 'IN' ? 'DEBIT' : 'CREDIT',
        amount: p.paidAmount,
        status: p.status,
        isCancelled: p.isCancelled,
        createdBy: p.createdBy || 'System',
        approvedBy: p.approvedBy || 'System'
      };
    });

    return {
      data,
      totalDebit: inAgg._sum.paidAmount || 0,
      totalCredit: outAgg._sum.paidAmount || 0,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }

  // Atomic row-level UPDATE...increment (same NumberSequence pattern as
  // GRNService.nextSequence) — a COUNT-based sequence let two payments
  // committed in the same window both read the same count and land on the
  // identical paymentNumber (this is how "VPAY-20260820-0001" ended up
  // posted twice for two distinct Payment rows). The idempotencyKey check
  // upstream in createPayment stops a genuine retry from creating a second
  // row at all; this stops two DIFFERENT concurrent payments from racing
  // each other onto the same number (which, now that paymentNumber is
  // DB-unique, would otherwise fail the second payment outright instead of
  // just mislabeling it).
  private static async nextPaymentSequence(tx: any, key: string): Promise<number> {
    const seq = await tx.numberSequence.upsert({
      where: { key },
      create: { key, value: 1 },
      update: { value: { increment: 1 } }
    });
    return seq.value;
  }

  private static async generatePaymentNumber(tx: any, isVendorPayment?: boolean): Promise<string> {
    const now = new Date();
    const year = now.getFullYear();
    if (isVendorPayment) {
      const yearStr = year.toString();
      const monthStr = (now.getMonth() + 1).toString().padStart(2, '0');
      const dateStr = now.getDate().toString().padStart(2, '0');
      const dateKey = `${yearStr}${monthStr}${dateStr}`;

      const seq = await this.nextPaymentSequence(tx, `VPAY_${dateKey}`);
      return `VPAY-${dateKey}-${seq.toString().padStart(4, '0')}`;
    }

    const seq = await this.nextPaymentSequence(tx, `PAY_${year}`);
    return `PAY-${year}-${seq.toString().padStart(4, '0')}`;
  }

  static async getTrialBalanceReport(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    // 1. Fetch Cash, Bank, and UPI accounts
    const accounts = await prisma.account.findMany({
      where: {
        franchiseId: filters.franchiseId,
        status: "ACTIVE"
      }
    });

    const cashBalance = accounts.filter(a => a.type === "CASH").reduce((s, a) => s + (a.balance || 0), 0);
    const bankBalance = accounts.filter(a => a.type === "BANK").reduce((s, a) => s + (a.balance || 0), 0);
    const upiBalance = accounts.filter(a => a.type === "UPI").reduce((s, a) => s + (a.balance || 0), 0);

    // 2. Fetch Customer ledger entries for dynamic Sundry Debtors
    const customers = await prisma.customer.findMany({
      where: { franchiseId: filters.franchiseId },
      include: {
        ledgerEntries: {
          where: {
            createdAt: {
              ...(filters.startDate ? { gte: filters.startDate } : {}),
              ...(filters.endDate ? { lte: filters.endDate } : {})
            }
          }
        }
      }
    });

    const customerRows: any[] = [];
    let totalDebtorsDebit = 0;
    let totalDebtorsCredit = 0;

    for (const cust of customers) {
      let debits = 0;
      let credits = 0;
      for (const entry of cust.ledgerEntries) {
        if (entry.type === "DEBIT") {
          debits += entry.amount;
        } else {
          credits += entry.amount;
        }
      }
      const net = debits - credits;
      if (net > 0) {
        customerRows.push({ name: cust.name, debit: net, credit: 0 });
        totalDebtorsDebit += net;
      } else if (net < 0) {
        customerRows.push({ name: cust.name, debit: 0, credit: Math.abs(net) });
        totalDebtorsCredit += Math.abs(net);
      }
    }

    // 3. Fetch Procurement Orders to calculate Sundry Creditors liability
    const pos = await prisma.procurementOrder.findMany({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      }
    });

    let sundryCreditorsBalance = 0;
    for (const po of pos) {
      const unpaid = po.totalAmount - (po.paid || po.advancePaid || 0);
      sundryCreditorsBalance += unpaid;
    }

    // 4. Calculate Sales Revenue
    const salesAggregate = await prisma.order.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { totalAmount: true }
    });
    const totalSales = salesAggregate._sum.totalAmount || 0;

    // 5. Calculate Purchase Costs
    const purchaseAggregate = await prisma.procurementOrder.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { totalAmount: true }
    });
    const totalPurchases = purchaseAggregate._sum.totalAmount || 0;

    // 6. Calculate Indirect Expenses
    const expenseAggregate = await prisma.expense.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        isCancelled: false,
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { amount: true }
    });
    const totalExpenses = expenseAggregate._sum.amount || 0;

    const result = [
      { name: "Fixed Assets", debit: 0, credit: 0 },
      { name: "Non Current Assets", debit: 0, credit: 0 },
      ...customerRows,
      { name: "Input Duties & Taxes", debit: 0, credit: 0 },
      { name: "Bank Accounts", debit: bankBalance >= 0 ? bankBalance : 0, credit: bankBalance < 0 ? Math.abs(bankBalance) : 0 },
      { name: "Cash Accounts", debit: cashBalance >= 0 ? cashBalance : 0, credit: cashBalance < 0 ? Math.abs(cashBalance) : 0 },
      { name: "Other Current Assets", debit: upiBalance >= 0 ? upiBalance : 0, credit: upiBalance < 0 ? Math.abs(upiBalance) : 0 },
      { name: "Other Assets", debit: 0, credit: 0 },
      { name: "Capital Account", debit: 0, credit: 0 },
      { name: "Long-term Liabilities", debit: 0, credit: 0 },
      { name: "Sundry Creditors", debit: sundryCreditorsBalance < 0 ? Math.abs(sundryCreditorsBalance) : 0, credit: sundryCreditorsBalance >= 0 ? sundryCreditorsBalance : 0 },
      { name: "Outward Duties & Taxes", debit: 0, credit: 0 },
      { name: "Other Current Liabilities", debit: 0, credit: 0 },
      { name: "Other Liabilities", debit: 0, credit: 0 },
      { name: "Sale (Revenue) Account", debit: 0, credit: totalSales },
      { name: "Other Incomes (Direct)", debit: 0, credit: 0 },
      { name: "Other Incomes (Indirect)", debit: 0, credit: 0 },
      { name: "Purchase Accounts", debit: totalPurchases, credit: 0 },
      { name: "Direct Expenses", debit: 0, credit: 0 },
      { name: "Indirect Expenses", debit: totalExpenses, credit: 0 }
    ];

    return result;
  }

  static async getBalanceSheetReport(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    // 1. Fetch Cash, Bank, and UPI accounts
    const accounts = await prisma.account.findMany({
      where: {
        franchiseId: filters.franchiseId,
        status: "ACTIVE"
      }
    });

    const cashBalance = accounts.filter(a => a.type === "CASH").reduce((s, a) => s + (a.balance || 0), 0);
    const bankBalance = accounts.filter(a => a.type === "BANK").reduce((s, a) => s + (a.balance || 0), 0);
    const upiBalance = accounts.filter(a => a.type === "UPI").reduce((s, a) => s + (a.balance || 0), 0);

    // 2. Fetch Customer ledger entries for dynamic Sundry Debtors
    const customers = await prisma.customer.findMany({
      where: { franchiseId: filters.franchiseId },
      include: {
        ledgerEntries: {
          where: {
            createdAt: {
              ...(filters.startDate ? { gte: filters.startDate } : {}),
              ...(filters.endDate ? { lte: filters.endDate } : {})
            }
          }
        }
      }
    });

    let totalDebtorsDebit = 0;
    for (const cust of customers) {
      let debits = 0;
      let credits = 0;
      for (const entry of cust.ledgerEntries) {
        if (entry.type === "DEBIT") {
          debits += entry.amount;
        } else {
          credits += entry.amount;
        }
      }
      const net = debits - credits;
      if (net > 0) {
        totalDebtorsDebit += net;
      }
    }

    // 3. Fetch Procurement Orders to calculate Sundry Creditors liability
    const pos = await prisma.procurementOrder.findMany({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      }
    });

    let sundryCreditorsBalance = 0;
    for (const po of pos) {
      const unpaid = po.totalAmount - (po.paid || po.advancePaid || 0);
      sundryCreditorsBalance += unpaid;
    }

    // 4. Calculate Sales Revenue
    const salesAggregate = await prisma.order.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { totalAmount: true }
    });
    const totalSales = salesAggregate._sum.totalAmount || 0;

    // 5. Calculate Purchase Costs
    const purchaseAggregate = await prisma.procurementOrder.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { totalAmount: true }
    });
    const totalPurchases = purchaseAggregate._sum.totalAmount || 0;

    // 6. Calculate Indirect Expenses
    const expenseAggregate = await prisma.expense.aggregate({
      where: {
        franchiseId: filters.franchiseId,
        isCancelled: false,
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      _sum: { amount: true }
    });
    const totalExpenses = expenseAggregate._sum.amount || 0;

    const currentAssetsAmount = cashBalance + bankBalance + upiBalance + totalDebtorsDebit;
    const currentLiabilitiesAmount = sundryCreditorsBalance >= 0 ? sundryCreditorsBalance : 0;
    const netProfit = totalSales - totalPurchases - totalExpenses;

    // Build sundry debtors breakdown
    const sundryDebtors: { name: string; amount: number }[] = [];
    for (const cust of customers) {
      let debits = 0;
      let credits = 0;
      for (const entry of cust.ledgerEntries) {
        if (entry.type === "DEBIT") debits += entry.amount;
        else credits += entry.amount;
      }
      const net = debits - credits;
      if (net > 0) sundryDebtors.push({ name: cust.name, amount: net });
    }

    // Build sundry creditors breakdown
    const sundryCreditors: { name: string; amount: number }[] = [];
    for (const po of pos) {
      const unpaid = po.totalAmount - (po.paid || po.advancePaid || 0);
      if (unpaid > 0) {
        const vendor = await prisma.vendor.findUnique({ where: { id: po.vendorId } });
        sundryCreditors.push({ name: vendor?.name || 'Vendor', amount: unpaid });
      }
    }

    // Build individual account details
    const accountDetails = accounts.map(a => ({ name: a.name, type: a.type, balance: a.balance || 0 }));

    return {
      assets: [
        { name: "Fixed Assets", amount: 0, notes: "—" },
        { name: "Non Current Assets", amount: 0, notes: "—" },
        { name: "Current Assets", amount: currentAssetsAmount > 0 ? currentAssetsAmount : 0, notes: "Includes Cash, Bank, and Debtor balances" },
        { name: "Other Assets", amount: 0, notes: "—" }
      ],
      liabilities: [
        { name: "Capital Account", amount: 0, notes: "—" },
        { name: "Long-term Liabilities", amount: 0, notes: "—" },
        { name: "Current Liabilities", amount: currentLiabilitiesAmount, notes: "Includes Sundry Creditors / Vendor Payables" },
        { name: "Other Liabilities", amount: 0, notes: "—" },
        { name: "Retained Earnings / Profit & Loss Balance", amount: netProfit, notes: "Balanced through net profit" }
      ],
      details: {
        sundryDebtors,
        sundryCreditors,
        accounts: accountDetails,
        cashBalance,
        bankBalance,
        upiBalance,
        totalDebtorsDebit,
        sundryCreditorsBalance,
        netProfit,
        totalSales,
        totalPurchases,
        totalExpenses
      }
    };
  }

  static async getBillWiseProfitReport(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const orders = await prisma.order.findMany({
      where: {
        franchiseId: filters.franchiseId,
        status: "COMPLETED",
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      include: {
        customer: true,
        orderItems: {
          include: {
            product: {
              include: {
                recipe: {
                  include: {
                    recipeItems: {
                      include: {
                        inventoryItem: true
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { createdAt: "desc" }
    });

    const rows = orders.map(order => {
      let cost = 0;
      for (const item of order.orderItems) {
        // Prefer the real cost captured at sale time (see pos.service.ts) over
        // a live recompute from today's costPrice.
        if (item.totalCost !== null && item.totalCost !== undefined) {
          cost += item.totalCost;
          continue;
        }
        let itemCost = 0;
        const recipeItems = item.product?.recipe?.recipeItems || [];
        if (recipeItems.length > 0) {
          for (const ri of recipeItems) {
            const materialCost = ri.inventoryItem?.costPrice || ri.inventoryItem?.basePrice || 0;
            itemCost += ri.quantityRequired * materialCost;
          }
        } else {
          itemCost = item.product?.basePrice || 0;
        }
        cost += itemCost * item.quantity;
      }

      const total = order.totalAmount;
      const profit = total - cost;
      const margin = total > 0 ? Number(((profit / total) * 100).toFixed(2)) : 0;

      return {
        date: order.createdAt.toISOString().split("T")[0],
        invoiceNumber: order.invoiceNum || `INV-${order.id.slice(0, 8).toUpperCase()}`,
        partyName: order.customer?.name || "Cash Customer",
        total,
        cost: Number(cost.toFixed(2)),
        profit: Number(profit.toFixed(2)),
        margin
      };
    });

    return rows;
  }

  static async getAccountTransactionSummary(filters: {
    franchiseId?: string;
    accountName: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, accountName, startDate, endDate } = filters;
    const start = startDate || new Date(new Date().getFullYear(), 3, 1); // April 1st (FY start)
    const end = endDate || new Date();

    // Generate month buckets between start and end
    const months: { label: string; from: Date; to: Date }[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      const monthStart = new Date(cursor);
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
      const isFirst = months.length === 0;
      const isLast = monthEnd >= end;
      const label = cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      const fromDate = isFirst ? start : monthStart;
      const toDate = isLast ? end : monthEnd;
      const fromStr = `${String(fromDate.getDate()).padStart(2, '0')}/${String(fromDate.getMonth() + 1).padStart(2, '0')}/${fromDate.getFullYear()}`;
      const toStr = `${String(toDate.getDate()).padStart(2, '0')}/${String(toDate.getMonth() + 1).padStart(2, '0')}/${toDate.getFullYear()}`;
      months.push({
        label: isFirst ? `${label} ( from ${fromStr} )` : isLast ? `${label} ( to ${toStr} )` : label,
        from: fromDate,
        to: toDate
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    // Determine account type for querying
    const acctLower = accountName.toLowerCase();
    const isSundryDebtor = acctLower.includes('sundry debtor') || acctLower.includes('current asset');
    const isSundryCreditor = acctLower.includes('sundry creditor') || acctLower.includes('current liabilit');
    const isSaleRevenue = acctLower.includes('sale') || acctLower.includes('revenue') || acctLower.includes('income');
    const isPurchase = acctLower.includes('purchase');
    const isExpense = acctLower.includes('expense');
    const isCash = acctLower.includes('cash');
    const isBank = acctLower.includes('bank');

    const summaryRows: any[] = [];
    let runningBalance = 0;
    const balanceType = (isSundryCreditor || isSaleRevenue) ? 'Cr.' : 'Dr.';

    for (const month of months) {
      let debit = 0;
      let credit = 0;

      if (isSundryDebtor) {
        // Query customer ledger entries
        const entries = await prisma.customerLedger.findMany({
          where: {
            customer: { franchiseId },
            createdAt: { gte: month.from, lte: month.to }
          }
        });
        for (const e of entries) {
          if (e.type === 'DEBIT') debit += e.amount;
          else credit += e.amount;
        }
      } else if (isSaleRevenue) {
        // Sales = credit entries
        const salesAgg = await prisma.order.aggregate({
          where: {
            franchiseId,
            status: { not: 'CANCELLED' },
            createdAt: { gte: month.from, lte: month.to }
          },
          _sum: { totalAmount: true }
        });
        credit = salesAgg._sum.totalAmount || 0;
      } else if (isPurchase) {
        const purchAgg = await prisma.procurementOrder.aggregate({
          where: {
            franchiseId,
            status: { not: 'CANCELLED' },
            createdAt: { gte: month.from, lte: month.to }
          },
          _sum: { totalAmount: true }
        });
        debit = purchAgg._sum.totalAmount || 0;
      } else if (isExpense) {
        const expAgg = await prisma.expense.aggregate({
          where: {
            franchiseId,
            isCancelled: false,
            createdAt: { gte: month.from, lte: month.to }
          },
          _sum: { amount: true }
        });
        debit = expAgg._sum.amount || 0;
      } else if (isCash || isBank) {
        // Query payments for cash/bank accounts
        const payments = await prisma.payment.findMany({
          where: {
            account: { franchiseId, type: isCash ? 'CASH' : 'BANK' },
            createdAt: { gte: month.from, lte: month.to }
          }
        });
        for (const p of payments) {
          const isOut = p.entityType === 'VENDOR' || p.sourceModule === 'EXPENSE' || p.type === 'INTERNAL_TRANSFER';
          if (isOut) credit += p.paidAmount;
          else debit += p.paidAmount;
        }
      }

      runningBalance += (debit - credit);
      const absBalance = Math.abs(runningBalance);

      summaryRows.push({
        month: month.label,
        debit,
        credit,
        closingBalance: `${absBalance.toLocaleString('en-IN')} ${runningBalance >= 0 ? 'Dr.' : 'Cr.'}`
      });
    }

    return {
      accountName,
      openingBalance: `0 ${balanceType}`,
      rows: summaryRows,
      totalDebit: summaryRows.reduce((s, r) => s + r.debit, 0),
      totalCredit: summaryRows.reduce((s, r) => s + r.credit, 0),
      closingBalance: summaryRows.length > 0 ? summaryRows[summaryRows.length - 1].closingBalance : `0 ${balanceType}`
    };
  }

  static async getPartyStatement(filters: {
    franchiseId?: string;
    customerId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, customerId, startDate, endDate } = filters;

    // Fetch all customers for current franchise to populate dropdown
    const customersList = await prisma.customer.findMany({
      where: { franchiseId },
      select: { id: true, name: true, phone: true }
    });

    if (!customerId) {
      return {
        customers: customersList,
        transactions: [],
        summary: {
          totalSale: 0,
          totalPurchase: 0,
          totalExpense: 0,
          totalMoneyIn: 0,
          totalMoneyOut: 0,
          totalReceivable: 0,
          totalPayable: 0
        }
      };
    }

    // Fetch customer ledgers
    const ledgers = await prisma.customerLedger.findMany({
      where: {
        customerId,
        createdAt: {
          ...(startDate ? { gte: startDate } : {}),
          ...(endDate ? { lte: endDate } : {})
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Format transaction rows
    let runningBalance = 0;
    const transactions = ledgers.map(entry => {
      const isDebit = entry.type === 'DEBIT';
      runningBalance += isDebit ? entry.amount : -entry.amount;
      return {
        date: entry.createdAt.toISOString().split('T')[0],
        txnType: entry.referenceType || 'Payment',
        refNo: entry.referenceId ? entry.referenceId.slice(0, 8).toUpperCase() : '—',
        paymentType: entry.paymentMode || '—',
        total: entry.amount,
        receivedPaid: isDebit ? 0 : entry.amount,
        txnBalance: entry.amount,
        receivableBalance: runningBalance >= 0 ? runningBalance : 0,
        payableBalance: runningBalance < 0 ? Math.abs(runningBalance) : 0,
      };
    });

    // Compute summaries
    const totalSale = ledgers.filter(l => l.referenceType === 'SALE').reduce((s, l) => s + l.amount, 0);
    const totalMoneyIn = ledgers.filter(l => l.type === 'CREDIT').reduce((s, l) => s + l.amount, 0);

    return {
      customers: customersList,
      transactions,
      summary: {
        totalSale,
        totalPurchase: 0,
        totalExpense: 0,
        totalMoneyIn,
        totalMoneyOut: 0,
        totalReceivable: runningBalance >= 0 ? runningBalance : 0,
        totalPayable: runningBalance < 0 ? Math.abs(runningBalance) : 0
      }
    };
  }

  static async getPartyProfitLoss(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, startDate, endDate } = filters;

    // Fetch all customers for franchise
    const customers = await prisma.customer.findMany({
      where: { franchiseId },
      include: {
        orders: {
          where: {
            status: { not: 'CANCELLED' },
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {})
            }
          },
          include: {
            orderItems: {
              include: {
                product: {
                  include: {
                    recipe: {
                      include: {
                        recipeItems: {
                          include: {
                            inventoryItem: true
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const reportRows = customers.map(cust => {
      let totalSaleAmount = 0;
      let totalCost = 0;

      for (const order of cust.orders) {
        totalSaleAmount += order.totalAmount;
        for (const item of order.orderItems) {
          if (item.totalCost !== null && item.totalCost !== undefined) {
            totalCost += item.totalCost;
            continue;
          }
          let itemCost = 0;
          const recipeItems = item.product?.recipe?.recipeItems || [];
          if (recipeItems.length > 0) {
            for (const ri of recipeItems) {
              const materialCost = ri.inventoryItem?.costPrice || ri.inventoryItem?.basePrice || 0;
              itemCost += ri.quantityRequired * materialCost;
            }
          } else {
            itemCost = item.product?.basePrice || 0;
          }
          totalCost += itemCost * item.quantity;
        }
      }

      const profit = totalSaleAmount - totalCost;

      return {
        partyName: cust.name,
        phoneNo: cust.phone || '—',
        totalSaleAmount,
        profit
      };
    }).filter(r => r.totalSaleAmount > 0);

    return reportRows;
  }

  static async getPartyReportByItem(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, startDate, endDate } = filters;

    // Fetch customer order items
    const customers = await prisma.customer.findMany({
      where: { franchiseId },
      include: {
        orders: {
          where: {
            status: { not: 'CANCELLED' },
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {})
            }
          },
          include: {
            orderItems: true
          }
        }
      }
    });

    const report = customers.map(cust => {
      let saleQuantity = 0;
      let saleAmount = 0;

      for (const order of cust.orders) {
        saleAmount += order.totalAmount;
        for (const item of order.orderItems) {
          saleQuantity += item.quantity;
        }
      }

      return {
        partyName: cust.name,
        saleQuantity,
        saleAmount,
        purchaseQuantity: 0,
        purchaseAmount: 0
      };
    }).filter(r => r.saleAmount > 0);

    return report;
  }

  static async getSalePurchaseByParty(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, startDate, endDate } = filters;

    // Aggregate sales per customer
    const customers = await prisma.customer.findMany({
      where: { franchiseId },
      include: {
        orders: {
          where: {
            status: { not: 'CANCELLED' },
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {})
            }
          }
        }
      }
    });

    const report = customers.map(cust => {
      const saleAmount = cust.orders.reduce((sum, o) => sum + o.totalAmount, 0);
      return {
        partyName: cust.name,
        saleAmount,
        purchaseAmount: 0
      };
    }).filter(r => r.saleAmount > 0);

    return report;
  }

  static async getLoans(filters: { franchiseId: string }) {
    return prisma.loanAccount.findMany({
      where: { franchiseId: filters.franchiseId },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async addLoanAccount(data: {
    franchiseId: string;
    accountName: string;
    accountNumber?: string;
    lenderName?: string;
    loanType: string;
    principalAmount: number;
    interestRate: number;
    loanDate: Date;
  }) {
    const { franchiseId, accountName, accountNumber, lenderName, loanType, principalAmount, interestRate, loanDate } = data;
    
    // Create Loan Account
    const loan = await prisma.loanAccount.create({
      data: {
        franchiseId,
        accountName,
        accountNumber,
        lenderName,
        loanType: loanType || "RECEIVED",
        principalAmount,
        interestRate,
        loanDate: loanDate || new Date(),
        outstandingBalance: principalAmount,
        principalPaid: 0,
        interestPaid: 0
      }
    });

    // Create initial transaction: DISBURSEMENT
    await prisma.loanTransaction.create({
      data: {
        loanAccountId: loan.id,
        date: loanDate || new Date(),
        type: "DISBURSEMENT",
        amount: principalAmount,
        endingBalance: principalAmount,
        note: "Initial Loan Disbursement"
      }
    });

    return loan;
  }

  static async getLoanStatement(filters: {
    franchiseId: string;
    loanAccountId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, loanAccountId, startDate, endDate } = filters;

    // Fetch all loan accounts for dropdown
    const loansList = await prisma.loanAccount.findMany({
      where: { franchiseId },
      select: { id: true, accountName: true, loanType: true }
    });

    if (!loanAccountId) {
      return {
        loans: loansList,
        transactions: [],
        summary: {
          openingBalance: 0,
          balanceDue: 0,
          totalPrincipalPaid: 0,
          totalInterestPaid: 0
        }
      };
    }

    // Fetch specific loan account
    const loanAccount = await prisma.loanAccount.findFirst({
      where: { id: loanAccountId, franchiseId }
    });

    if (!loanAccount) {
      throw new Error("Loan Account not found");
    }

    // Fetch transactions
    const txns = await prisma.loanTransaction.findMany({
      where: {
        loanAccountId,
        date: {
          ...(startDate ? { gte: startDate } : {}),
          ...(endDate ? { lte: endDate } : {})
        }
      },
      orderBy: { date: 'asc' }
    });

    // Compute transactions within filter
    const transactions = txns.map(t => ({
      id: t.id,
      date: t.date.toISOString().split('T')[0],
      type: t.type,
      amount: t.amount,
      endingBalance: t.endingBalance,
      note: t.note
    }));

    return {
      loans: loansList,
      loanAccount,
      transactions,
      summary: {
        openingBalance: loanAccount.principalAmount,
        balanceDue: loanAccount.outstandingBalance,
        totalPrincipalPaid: loanAccount.principalPaid,
        totalInterestPaid: loanAccount.interestPaid
      }
    };
  }

  static async addLoanTransaction(data: {
    franchiseId: string;
    loanAccountId: string;
    type: string;
    amount: number;
    date: Date;
    note?: string;
  }) {
    const { franchiseId, loanAccountId, type, amount, date, note } = data;

    // Fetch loan account
    const loan = await prisma.loanAccount.findFirst({
      where: { id: loanAccountId, franchiseId }
    });

    if (!loan) {
      throw new Error("Loan Account not found");
    }

    let newOutstandingBalance = loan.outstandingBalance;
    let newPrincipalPaid = loan.principalPaid;
    let newInterestPaid = loan.interestPaid;

    if (type === "PRINCIPAL_PAID") {
      newOutstandingBalance = Math.max(0, loan.outstandingBalance - amount);
      newPrincipalPaid += amount;
    } else if (type === "INTEREST_CHARGED") {
      newOutstandingBalance += amount;
    } else if (type === "INTEREST_PAID") {
      newInterestPaid += amount;
    } else {
      throw new Error("Invalid transaction type. Expected PRINCIPAL_PAID, INTEREST_CHARGED, or INTEREST_PAID.");
    }

    // Update Loan Account
    const updatedLoan = await prisma.loanAccount.update({
      where: { id: loanAccountId },
      data: {
        outstandingBalance: newOutstandingBalance,
        principalPaid: newPrincipalPaid,
        interestPaid: newInterestPaid
      }
    });

    // Create Loan Transaction
    const txn = await prisma.loanTransaction.create({
      data: {
        loanAccountId,
        date: date || new Date(),
        type,
        amount,
        endingBalance: newOutstandingBalance,
        note
      }
    });

    return { loan: updatedLoan, transaction: txn };
  }

  // ─── Item / Stock Reports ───────────────────────────────────────────────────

  static async getStockSummaryData(
    franchiseId: string,
    filters?: { category?: string; startDate?: Date; endDate?: Date }
  ) {
    const { category, startDate, endDate } = filters || {};
    const inclusiveEndDate = endDate ? new Date(endDate) : undefined;
    if (inclusiveEndDate) inclusiveEndDate.setHours(23, 59, 59, 999);

    const items = await prisma.inventoryItem.findMany({
      where: {
        franchiseId,
        isActive: true,
        ...(category && category !== 'ALL' ? { category: category as ItemCategory } : {}),
        ...(startDate || inclusiveEndDate ? {
          createdAt: {
            ...(startDate ? { gte: startDate } : {}),
            ...(inclusiveEndDate ? { lte: inclusiveEndDate } : {})
          }
        } : {})
      },
      orderBy: { name: 'asc' }
    });

    const data = items.map(item => {
      const salePrice = item.customerPrice || item.basePrice || 0;
      const purchasePrice = item.costPrice || 0;
      const stockQty = item.currentStock || 0;
      const stockValue = stockQty > 0 ? stockQty * purchasePrice : 0;
      return {
        itemName: item.name,
        salePrice,
        purchasePrice,
        stockQty,
        stockValue
      };
    });

    return data;
  }

  static async getLowStockSummaryData(franchiseId: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId, isActive: true },
      orderBy: { name: 'asc' }
    });

    const data = items
      .filter(item => (item.currentStock || 0) <= (item.minimumStock || 10))
      .map(item => {
        const stockQty = item.currentStock || 0;
        const purchasePrice = item.costPrice || 0;
        const stockValue = stockQty > 0 ? stockQty * purchasePrice : 0;
        return {
          itemName: item.name,
          minimumStock: item.minimumStock || 10,
          stockQty,
          stockValue
        };
      });

    return data;
  }

  static async getItemWiseProfitLoss(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [sales, purchases] = await Promise.all([
      prisma.order.findMany({
        where: {
          franchiseId,
          ...dateFilter,
          status: 'COMPLETED'
        },
        include: {
          orderItems: {
            include: { product: true }
          }
        }
      }),
      prisma.procurementOrder.findMany({
        where: {
          franchiseId,
          ...dateFilter,
          status: 'DELIVERED'
        },
        include: {
          poItems: {
            include: { inventoryItem: true }
          }
        }
      })
    ]);

    const itemMap: Record<string, {
      itemName: string;
      sale: number;
      saleReturn: number;
      purchase: number;
      purchaseReturn: number;
      openingStock: number;
      closingStock: number;
      taxReceivable: number;
      taxPayable: number;
      mfgCost: number;
      consumptionCost: number;
      netProfitLoss: number;
    }> = {};

    sales.forEach(s => {
      s.orderItems.forEach(item => {
        const name = item.product?.name || item.id;
        if (!itemMap[name]) {
          itemMap[name] = {
            itemName: name,
            sale: 0, saleReturn: 0, purchase: 0, purchaseReturn: 0,
            openingStock: 0, closingStock: 0, taxReceivable: 0, taxPayable: 0,
            mfgCost: 0, consumptionCost: 0, netProfitLoss: 0
          };
        }
        itemMap[name].sale += item.totalAmount || 0;
        itemMap[name].taxPayable += item.taxAmount || 0;
        itemMap[name].netProfitLoss += item.totalAmount || 0;
      });
    });

    purchases.forEach(p => {
      p.poItems.forEach(item => {
        const name = item.itemName || item.inventoryItem?.name || item.id;
        if (!itemMap[name]) {
          itemMap[name] = {
            itemName: name,
            sale: 0, saleReturn: 0, purchase: 0, purchaseReturn: 0,
            openingStock: 0, closingStock: 0, taxReceivable: 0, taxPayable: 0,
            mfgCost: 0, consumptionCost: 0, netProfitLoss: 0
          };
        }
        itemMap[name].purchase += item.total || 0;
        itemMap[name].taxReceivable += (item.cgst + item.sgst + item.igst) || 0;
        itemMap[name].netProfitLoss -= item.total || 0;
      });
    });

    const data = Object.values(itemMap);

    return data;
  }

  static async getItemCategoryWiseProfitLoss(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: { franchiseId, status: 'COMPLETED', ...dateFilter },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: { franchiseId, status: { not: 'CANCELLED' as any }, ...dateFilter },
        include: { poItems: { include: { inventoryItem: true } } }
      })
    ]);

    const categoryMap: Record<string, { category: string; sale: number; purchase: number; netProfitLoss: number }> = {};

    orders.forEach(s => {
      s.orderItems.forEach(item => {
        const category = item.product?.category || 'Uncategorized';
        if (!categoryMap[category]) categoryMap[category] = { category, sale: 0, purchase: 0, netProfitLoss: 0 };
        categoryMap[category].sale += item.totalAmount || 0;
        categoryMap[category].netProfitLoss += item.totalAmount || 0;
      });
    });

    purchases.forEach(p => {
      p.poItems.forEach(item => {
        const category = item.inventoryItem?.category || 'Uncategorized';
        if (!categoryMap[category]) categoryMap[category] = { category, sale: 0, purchase: 0, netProfitLoss: 0 };
        categoryMap[category].purchase += item.total || 0;
        categoryMap[category].netProfitLoss -= item.total || 0;
      });
    });

    return Object.values(categoryMap);
  }

  static async getStockDetailData(franchiseId: string, startDate?: string, endDate?: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId, isActive: true },
      include: {
        movements: {
          where: {
            ...(startDate || endDate ? {
              createdAt: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {})
              }
            } : {})
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    return items.map(item => {
      const inMovements = item.movements.filter(m =>
        m.movementType === 'PURCHASE_IN' || (m.movementType === 'ADJUSTMENT' && m.quantity > 0)
      );
      const outMovements = item.movements.filter(m =>
        m.movementType === 'SALES_OUT' || m.movementType === 'PRODUCTION_OUT' || m.movementType === 'WASTE_OUT'
      );
      const quantityIn = inMovements.reduce((s, m) => s + m.quantity, 0);
      const quantityOut = outMovements.reduce((s, m) => s + Math.abs(m.quantity), 0);
      const purchasePrice = item.costPrice || 0;
      const salePrice = item.customerPrice || item.basePrice || 0;
      const beginningQuantity = item.currentStock - quantityIn + quantityOut;

      return {
        itemName: item.name,
        beginningQuantity: Number(beginningQuantity.toFixed(2)),
        quantityIn: Number(quantityIn.toFixed(2)),
        purchaseAmount: Number((quantityIn * purchasePrice).toFixed(2)),
        quantityOut: Number(quantityOut.toFixed(2)),
        saleAmount: Number((quantityOut * salePrice).toFixed(2)),
        closingQuantity: Number(item.currentStock.toFixed(2))
      };
    });
  }

  static async getItemDetailData(franchiseId: string, itemName?: string, startDate?: string, endDate?: string) {
    const whereClause: any = { franchiseId, isActive: true };
    if (itemName) whereClause.name = { contains: itemName, mode: 'insensitive' };

    const items = await prisma.inventoryItem.findMany({
      where: whereClause,
      include: {
        vendor: true,
        movements: {
          where: {
            ...(startDate || endDate ? {
              createdAt: {
                ...(startDate ? { gte: new Date(startDate) } : {}),
                ...(endDate ? { lte: new Date(endDate) } : {})
              }
            } : {})
          },
          orderBy: { createdAt: 'desc' },
          take: 20
        }
      },
      orderBy: { name: 'asc' }
    });

    return items.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      category: item.category,
      unit: item.unit,
      hsnCode: item.hsnCode,
      gstRate: item.gstRate,
      currentStock: item.currentStock,
      minimumStock: item.minimumStock,
      costPrice: item.costPrice || 0,
      basePrice: item.basePrice || 0,
      customerPrice: item.customerPrice || 0,
      vendorName: item.vendor?.name || '—',
      recentMovements: item.movements.map(m => ({
        date: m.createdAt.toISOString().split('T')[0],
        type: m.movementType,
        quantity: m.quantity,
        referenceType: m.referenceType || '—',
        note: m.note || '—'
      }))
    }));
  }

  static async getBankStatementData(franchiseId: string, accountId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    let accountIds: string[] = [];
    if (accountId && accountId !== 'NONE') {
      accountIds = [accountId];
    } else {
      const bankAccounts = await prisma.account.findMany({
        where: { franchiseId, type: 'BANK' }
      });
      accountIds = bankAccounts.map((a: any) => a.id);
    }

    if (accountIds.length === 0) return { data: [], closingBalance: 0 };

    const payments = await prisma.payment.findMany({
      where: {
        accountId: { in: accountIds },
        isCancelled: false,
        status: 'PAID',
        ...dateFilter
      },
      orderBy: { createdAt: 'asc' }
    });

    let runningBalance = 0;
    
    // Fetch opening balance
    const pastPayments = await prisma.payment.findMany({
      where: {
        accountId: { in: accountIds },
        isCancelled: false,
        status: 'PAID',
        ...(startDate ? { createdAt: { lt: new Date(startDate) } } : {})
      }
    });

    const getAmountChange = (p: any) => {
      if (p.entityType === 'CUSTOMER') return p.paidAmount;
      if (p.entityType === 'VENDOR') return -p.paidAmount;
      if (p.sourceModule === 'EXPENSE') return -p.paidAmount;
      if (p.type === 'INTERNAL_TRANSFER') {
        if (p.paymentNumber && p.paymentNumber.endsWith('-IN')) return p.paidAmount;
        return -p.paidAmount;
      }
      return 0; // fallback
    };

    pastPayments.forEach((p: any) => {
      runningBalance += getAmountChange(p);
    });

    const data = payments.map((p: any) => {
      const change = getAmountChange(p);
      runningBalance += change;
      return {
        date: p.createdAt.toISOString(),
        description: p.transactionRef || p.paymentNumber || "Bank Transaction",
        withdrawalAmount: change < 0 ? Math.abs(change) : 0,
        depositAmount: change > 0 ? change : 0,
        balanceAmount: runningBalance
      };
    });

    return { data, closingBalance: runningBalance };
  }

  static async getDiscountReportData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const sales = await prisma.order.findMany({
      where: {
        franchiseId,
        discountAmount: { gt: 0 },
        status: 'COMPLETED',
        ...dateFilter
      },
      include: { customer: true },
      orderBy: { createdAt: 'desc' }
    });

    const data = sales.map((s: any) => ({
      date: s.createdAt.toISOString(),
      invoiceNo: s.invoiceNum,
      partyName: s.customer?.name || "Cash Customer",
      totalAmount: s.totalAmount + s.discountAmount, // original before discount
      discountAmount: s.discountAmount,
      finalAmount: s.totalAmount
    }));

    const totalDiscount = data.reduce((acc: number, r: any) => acc + r.discountAmount, 0);
    return { data, totalDiscount };
  }

  static async getGSTR1Data(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const orders = await prisma.order.findMany({
      where: {
        franchiseId,
        status: { in: ['COMPLETED', 'REFUNDED'] as any },
        ...dateFilter
      },
      include: { customer: true, orderItems: { include: { product: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const toRow = (o: any) => ({
      invoiceNo: o.invoiceNum || o.id,
      date: o.createdAt.toISOString().split('T')[0],
      partyName: o.customer?.name || 'Cash Customer',
      taxableValue: o.subTotal || 0,
      igst: 0,
      cgst: Number(((o.taxAmount || 0) / 2).toFixed(2)),
      sgst: Number(((o.taxAmount || 0) / 2).toFixed(2)),
      totalTax: o.taxAmount || 0,
      totalAmount: o.totalAmount
    });

    const sale = orders.filter((o: any) => o.status === 'COMPLETED').map(toRow);
    const saleReturn = orders.filter((o: any) => o.status === 'REFUNDED').map(toRow);

    return {
      sale,
      saleReturn,
      totalTaxableValue: sale.reduce((s, r) => s + r.taxableValue, 0),
      totalOutputGST: sale.reduce((s, r) => s + r.totalTax, 0)
    };
  }

  static async getGSTR2Data(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const purchases = await prisma.procurementOrder.findMany({
      where: { franchiseId, status: { not: 'CANCELLED' as any }, ...dateFilter },
      include: { vendor: true, poItems: true },
      orderBy: { createdAt: 'desc' }
    });

    const data = purchases.map(po => ({
      poNumber: po.poNumber || po.id,
      date: po.createdAt.toISOString().split('T')[0],
      vendorName: po.vendor?.name || '—',
      vendorGstin: po.vendor?.gstNumber || '—',
      taxableValue: po.subtotal || 0,
      igst: po.igst || 0,
      cgst: po.cgst || 0,
      sgst: po.sgst || 0,
      totalTax: (po.igst || 0) + (po.cgst || 0) + (po.sgst || 0),
      totalAmount: po.totalAmount,
      status: po.status
    }));

    return {
      data,
      totalTaxableValue: data.reduce((s, r) => s + r.taxableValue, 0),
      totalInputGST: data.reduce((s, r) => s + r.totalTax, 0)
    };
  }

  static async getGSTR3BData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [salesAgg, purchasesAgg] = await Promise.all([
      prisma.order.aggregate({
        where: { franchiseId, status: 'COMPLETED', ...dateFilter },
        _sum: { subTotal: true, taxAmount: true, totalAmount: true }
      }),
      prisma.procurementOrder.aggregate({
        where: { franchiseId, status: { not: 'CANCELLED' as any }, ...dateFilter },
        _sum: { subtotal: true, cgst: true, sgst: true, igst: true, totalAmount: true }
      })
    ]);

    const outputTaxable = salesAgg._sum.subTotal || 0;
    const outputTax = salesAgg._sum.taxAmount || 0;
    const inputCgst = purchasesAgg._sum.cgst || 0;
    const inputSgst = purchasesAgg._sum.sgst || 0;
    const inputIgst = purchasesAgg._sum.igst || 0;
    const totalInputTax = inputCgst + inputSgst + inputIgst;
    const netGstPayable = Math.max(0, outputTax - totalInputTax);

    return {
      outwardSupplies: [
        {
          description: 'Outward taxable supplies (other than zero rated, nil rated and exempted)',
          taxableValue: outputTaxable,
          igst: 0,
          cgst: Number((outputTax / 2).toFixed(2)),
          sgst: Number((outputTax / 2).toFixed(2)),
          cess: 0
        }
      ],
      interStateSupplies: [],
      eligibleITC: {
        available: [
          { description: 'All other ITC', igst: inputIgst, cgst: inputCgst, sgst: inputSgst, cess: 0 }
        ],
        ineligible: []
      },
      exemptSupplies: [],
      summary: { totalOutputTax: outputTax, totalInputTax, netGstPayable }
    };
  }

  static async getGSTR9Data(franchiseId: string, financialYear?: string) {
    const fy = financialYear || '2025-2026';
    const [startYearStr] = fy.split('-');
    const startYear = parseInt(startYearStr, 10);
    const fyStart = new Date(startYear, 3, 1);
    const fyEnd = new Date(startYear + 1, 2, 31, 23, 59, 59);

    const franchise = await prisma.franchise.findUnique({ where: { id: franchiseId } });

    const [salesAgg, purchasesAgg] = await Promise.all([
      prisma.order.aggregate({
        where: { franchiseId, status: 'COMPLETED', createdAt: { gte: fyStart, lte: fyEnd } },
        _sum: { subTotal: true, taxAmount: true, totalAmount: true }
      }),
      prisma.procurementOrder.aggregate({
        where: { franchiseId, status: { not: 'CANCELLED' as any }, createdAt: { gte: fyStart, lte: fyEnd } },
        _sum: { subtotal: true, cgst: true, sgst: true, igst: true, totalAmount: true }
      })
    ]);

    const outputTax = salesAgg._sum.taxAmount || 0;
    const inputTax = (purchasesAgg._sum.cgst || 0) + (purchasesAgg._sum.sgst || 0) + (purchasesAgg._sum.igst || 0);

    return {
      basicDetails: {
        financialYear: fy,
        gstin: '',
        legalName: franchise?.name || '',
        tradeName: franchise?.name || ''
      },
      outwardAndInwardSupplies: [
        {
          section: '4A',
          description: 'Supplies made to registered/unregistered persons',
          taxableValue: salesAgg._sum.subTotal || 0,
          centralTax: Number((outputTax / 2).toFixed(2)),
          stateTax: Number((outputTax / 2).toFixed(2)),
          integratedTax: 0,
          cess: 0
        },
        {
          section: '4C',
          description: 'Inward supplies liable to reverse charge',
          taxableValue: purchasesAgg._sum.subtotal || 0,
          centralTax: purchasesAgg._sum.cgst || 0,
          stateTax: purchasesAgg._sum.sgst || 0,
          integratedTax: purchasesAgg._sum.igst || 0,
          cess: 0
        }
      ],
      summary: {
        totalOutputTax: outputTax,
        totalInputTax: inputTax,
        netTaxPayable: Math.max(0, outputTax - inputTax)
      }
    };
  }

  static async getHsnSummaryData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const orders = await prisma.order.findMany({
      where: { franchiseId, status: 'COMPLETED', ...dateFilter },
      include: { orderItems: { include: { product: true } } }
    });

    const hsnMap: Record<string, {
      hsn: string; totalValue: number; taxableValue: number;
      igstAmount: number; cgstAmount: number; sgstAmount: number;
    }> = {};

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const hsn = item.product?.hsnCode || 'NA';
        if (!hsnMap[hsn]) hsnMap[hsn] = { hsn, totalValue: 0, taxableValue: 0, igstAmount: 0, cgstAmount: 0, sgstAmount: 0 };
        const itemSubtotal = (item.quantity || 0) * (item.price || 0);
        const itemTax = item.taxAmount || 0;
        hsnMap[hsn].taxableValue += itemSubtotal;
        hsnMap[hsn].cgstAmount += itemTax / 2;
        hsnMap[hsn].sgstAmount += itemTax / 2;
        hsnMap[hsn].totalValue += item.totalAmount || 0;
      });
    });

    return Object.values(hsnMap).map(h => ({
      hsn: h.hsn,
      totalValue: Number(h.totalValue.toFixed(2)),
      taxableValue: Number(h.taxableValue.toFixed(2)),
      igstAmount: 0,
      cgstAmount: Number(h.cgstAmount.toFixed(2)),
      sgstAmount: Number(h.sgstAmount.toFixed(2)),
      addCess: null
    }));
  }

  static async getSacReportData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const expenses = await prisma.expense.findMany({
      where: { franchiseId, isCancelled: false, ...dateFilter },
      orderBy: { date: 'desc' }
    });

    const sacMap: Record<string, { sacCode: string; description: string; taxableValue: number; gstAmount: number; totalAmount: number }> = {};

    expenses.forEach(e => {
      const sac = e.category || 'GENERAL';
      if (!sacMap[sac]) sacMap[sac] = { sacCode: sac, description: e.category || 'General Service', taxableValue: 0, gstAmount: 0, totalAmount: 0 };
      sacMap[sac].taxableValue += e.amount;
      sacMap[sac].totalAmount += e.amount;
    });

    return Object.values(sacMap);
  }

  static async getItemDiscountReportData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const orders = await prisma.order.findMany({
      where: { franchiseId, discountAmount: { gt: 0 }, status: 'COMPLETED', ...dateFilter },
      include: { orderItems: { include: { product: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const itemMap: Record<string, { itemName: string; totalSaleQty: number; totalSaleAmount: number; totalDiscountAmount: number }> = {};

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const name = item.product?.name || item.productId;
        if (!itemMap[name]) itemMap[name] = { itemName: name, totalSaleQty: 0, totalSaleAmount: 0, totalDiscountAmount: 0 };
        itemMap[name].totalSaleQty += item.quantity || 0;
        itemMap[name].totalSaleAmount += item.totalAmount || 0;
        const itemSubtotal = (item.quantity || 0) * (item.price || 0);
        itemMap[name].totalDiscountAmount += itemSubtotal * ((item.discountPct || 0) / 100);
      });
    });

    const data = Object.values(itemMap).map(r => ({
      ...r,
      totalSaleQty: Number(r.totalSaleQty.toFixed(2)),
      totalSaleAmount: Number(r.totalSaleAmount.toFixed(2)),
      totalDiscountAmount: Number(r.totalDiscountAmount.toFixed(2))
    }));

    return { data, totalDiscount: data.reduce((s, r) => s + r.totalDiscountAmount, 0) };
  }

  static async getSalePurchaseByCategoryData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: { franchiseId, status: 'COMPLETED', ...dateFilter },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: { franchiseId, status: { not: 'CANCELLED' as any }, ...dateFilter },
        include: { poItems: { include: { inventoryItem: true } } }
      })
    ]);

    const categoryMap: Record<string, { category: string; saleAmount: number; purchaseAmount: number }> = {};

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const category = item.product?.category || 'Uncategorized';
        if (!categoryMap[category]) categoryMap[category] = { category, saleAmount: 0, purchaseAmount: 0 };
        categoryMap[category].saleAmount += item.totalAmount || 0;
      });
    });

    purchases.forEach(p => {
      p.poItems.forEach(item => {
        const category = item.inventoryItem?.category || 'Uncategorized';
        if (!categoryMap[category]) categoryMap[category] = { category, saleAmount: 0, purchaseAmount: 0 };
        categoryMap[category].purchaseAmount += item.total || 0;
      });
    });

    return Object.values(categoryMap);
  }

  static async getStockByCategoryData(franchiseId: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId, isActive: true },
      orderBy: { category: 'asc' }
    });

    const categoryMap: Record<string, { category: string; itemCount: number; totalStock: number; totalValue: number }> = {};

    items.forEach(item => {
      const cat = item.category as string;
      if (!categoryMap[cat]) categoryMap[cat] = { category: cat, itemCount: 0, totalStock: 0, totalValue: 0 };
      categoryMap[cat].itemCount += 1;
      categoryMap[cat].totalStock += item.currentStock || 0;
      categoryMap[cat].totalValue += (item.currentStock || 0) * (item.costPrice || 0);
    });

    return Object.values(categoryMap).map(r => ({
      ...r,
      totalStock: Number(r.totalStock.toFixed(2)),
      totalValue: Number(r.totalValue.toFixed(2))
    }));
  }

  static async getExpensesReportData(franchiseId?: string, startDate?: string, endDate?: string, category?: string) {
    const where: any = {
      ...(franchiseId ? { franchiseId } : {}),
      isCancelled: false
    };
    if (startDate || endDate) {
      where.date = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }
    if (category) where.category = category;

    const expenses = await prisma.expense.findMany({
      where,
      include: { account: true },
      orderBy: { date: 'desc' }
    });

    const categoryMap: Record<string, { category: string; count: number; totalAmount: number; paidAmount: number; unpaidAmount: number }> = {};

    expenses.forEach(e => {
      const cat = e.category || 'GENERAL';
      if (!categoryMap[cat]) categoryMap[cat] = { category: cat, count: 0, totalAmount: 0, paidAmount: 0, unpaidAmount: 0 };
      categoryMap[cat].count += 1;
      categoryMap[cat].totalAmount += e.amount;
      categoryMap[cat].paidAmount += e.paidAmount || 0;
      categoryMap[cat].unpaidAmount += e.amount - (e.paidAmount || 0);
    });

    const totalAmount = expenses.reduce((s, e) => s + e.amount, 0);
    const totalPaid = expenses.reduce((s, e) => s + (e.paidAmount || 0), 0);

    return {
      expenses,
      categoryBreakdown: Object.values(categoryMap),
      summary: {
        totalExpenses: Number(totalAmount.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalUnpaid: Number((totalAmount - totalPaid).toFixed(2)),
        count: expenses.length
      }
    };
  }

  static async getSalePurchaseByPartyGroupData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [customers, vendors] = await Promise.all([
      prisma.customer.findMany({
        where: { franchiseId },
        include: {
          orders: {
            where: { status: { not: 'CANCELLED' as any }, ...dateFilter }
          }
        }
      }),
      prisma.vendor.findMany({
        include: {
          orders: {
            where: { franchiseId, status: { not: 'CANCELLED' as any }, ...dateFilter }
          }
        }
      })
    ]);

    const groupMap: Record<string, { groupName: string; saleAmount: number; purchaseAmount: number }> = {};

    customers.forEach(c => {
      const group = 'Customers';
      if (!groupMap[group]) groupMap[group] = { groupName: group, saleAmount: 0, purchaseAmount: 0 };
      groupMap[group].saleAmount += c.orders.reduce((s, o) => s + o.totalAmount, 0);
    });

    vendors.forEach(v => {
      const group = v.category || 'Vendors';
      if (!groupMap[group]) groupMap[group] = { groupName: group, saleAmount: 0, purchaseAmount: 0 };
      groupMap[group].purchaseAmount += v.orders.reduce((s, o) => s + o.totalAmount, 0);
    });

    return Object.values(groupMap);
  }

  static async getAllPartiesData(franchiseId?: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [customers, vendors] = await Promise.all([
      prisma.customer.findMany({
        where: franchiseId ? { franchiseId } : undefined,
        include: { ledgerEntries: { where: dateFilter } }
      }),
      prisma.vendor.findMany({
        include: { ledgerEntries: { where: dateFilter } }
      })
    ]);

    const parties: any[] = [];

    customers.forEach(c => {
      const currentBalance = c.ledgerEntries.reduce((sum, entry) => {
        if (entry.type === 'DEBIT') return sum + entry.amount;
        if (entry.type === 'CREDIT') return sum - entry.amount;
        return sum;
      }, 0);

      parties.push({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        currentBalance,
        creditLimit: null
      });
    });

    vendors.forEach(v => {
      const currentBalance = v.ledgerEntries.reduce((sum, entry) => {
        if (entry.type === 'CREDIT') return sum - entry.amount;
        if (entry.type === 'DEBIT') return sum + entry.amount;
        return sum;
      }, 0);

      parties.push({
        id: v.id,
        name: v.name,
        email: v.email,
        phone: v.contact,
        currentBalance,
        creditLimit: v.creditLimit
      });
    });

    return parties.sort((a, b) => a.name.localeCompare(b.name));
  }

  static async getSalePurchaseByItemData(franchiseId: string, startDate?: string, endDate?: string) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: { franchiseId, status: 'COMPLETED', ...dateFilter },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: { franchiseId, status: { not: 'CANCELLED' as any }, ...dateFilter },
        include: { poItems: { include: { inventoryItem: true } } }
      })
    ]);

    const itemMap: Record<string, { itemName: string; category: string; saleQty: number; saleAmount: number; purchaseQty: number; purchaseAmount: number }> = {};

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const name = item.product?.name || 'Unknown Item';
        const category = item.product?.category || 'General';
        if (!itemMap[name]) itemMap[name] = { itemName: name, category, saleQty: 0, saleAmount: 0, purchaseQty: 0, purchaseAmount: 0 };
        itemMap[name].saleQty += item.quantity || 0;
        itemMap[name].saleAmount += item.totalAmount || 0;
      });
    });

    purchases.forEach(p => {
      p.poItems.forEach(item => {
        const name = item.inventoryItem?.name || 'Unknown Item';
        const category = item.inventoryItem?.category || 'Raw Material';
        if (!itemMap[name]) itemMap[name] = { itemName: name, category, saleQty: 0, saleAmount: 0, purchaseQty: 0, purchaseAmount: 0 };
        itemMap[name].purchaseQty += item.quantity || 0;
        itemMap[name].purchaseAmount += item.total || 0;
      });
    });

    return Object.values(itemMap).map(r => ({
      ...r,
      saleQty: Number(r.saleQty.toFixed(2)),
      saleAmount: Number(r.saleAmount.toFixed(2)),
      purchaseQty: Number(r.purchaseQty.toFixed(2)),
      purchaseAmount: Number(r.purchaseAmount.toFixed(2)),
      grossMargin: Number((r.saleAmount - r.purchaseAmount).toFixed(2))
    }));
  }

  static async getStockSummaryByItemData(franchiseId: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { franchiseId, isActive: true },
      orderBy: { name: 'asc' }
    });

    return items.map(item => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      category: item.category,
      unit: item.unit,
      currentStock: item.currentStock || 0,
      minStockLevel: item.minimumStock || 0,
      costPrice: item.costPrice || 0,
      sellingPrice: item.customerPrice || item.basePrice || 0,
      stockValue: Number(((item.currentStock || 0) * (item.costPrice || 0)).toFixed(2)),
      status: (item.currentStock || 0) <= (item.minimumStock || 0) ? 'LOW_STOCK' : 'ADEQUATE'
    }));
  }

  static async getProductionReportData(franchiseId?: string, startDate?: string, endDate?: string) {
    const where: any = {};
    if (franchiseId) where.franchiseId = franchiseId;
    if (startDate || endDate) {
      where.producedAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const productions = await prisma.production.findMany({
      where,
      include: {
        recipe: { include: { product: true } },
        operator: { include: { user: { select: { id: true, fullName: true, email: true } } } }
      },
      orderBy: { producedAt: 'desc' }
    });

    const totalBatches = productions.length;
    const completedBatches = productions.filter(p => p.status === 'COMPLETED').length;
    const inProgressBatches = productions.filter(p => p.status === 'IN_PROGRESS' || p.status === 'PENDING').length;
    const totalYieldQty = productions.reduce((s, p) => s + (p.actualYield || p.quantity || 0), 0);

    return {
      summary: {
        totalBatches,
        completedBatches,
        inProgressBatches,
        totalYieldQty: Number(totalYieldQty.toFixed(2))
      },
      productions
    };
  }

  static async getInventoryLedgerReportData(franchiseId?: string, itemId?: string, startDate?: string, endDate?: string) {
    const where: any = {};
    if (franchiseId) {
      where.item = { franchiseId };
    }
    if (itemId) {
      where.itemId = itemId;
    }
    if (startDate || endDate) {
      where.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const movements = await prisma.stockMovement.findMany({
      where,
      include: {
        item: { select: { id: true, name: true, sku: true, unit: true, category: true } },
        warehouse: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    return movements.map(m => ({
      id: m.id,
      date: m.createdAt,
      itemName: m.item?.name || 'Unknown',
      sku: m.item?.sku,
      category: m.item?.category,
      movementType: m.movementType,
      quantity: m.quantity,
      baseQty: m.baseQty,
      unit: m.item?.unit,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      note: m.note,
      warehouseName: m.warehouse?.name || 'Central',
      performedBy: m.createdBy || 'System'
    }));
  }

  static async getExpenseCategoryReportData(franchiseId?: string, startDate?: string, endDate?: string) {
    const res = await FinanceService.getExpensesReportData(franchiseId, startDate, endDate);
    return res.categoryBreakdown;
  }

  static async getExpenseItemReportData(franchiseId?: string, startDate?: string, endDate?: string, category?: string) {
    const res = await FinanceService.getExpensesReportData(franchiseId, startDate, endDate, category);
    return res.expenses;
  }

  static async getSaleOrdersReportData(filters: { franchiseId?: string; startDate?: string; endDate?: string; status?: string }) {
    const where: any = {};
    if (filters.franchiseId) where.franchiseId = filters.franchiseId;
    if (filters.status) where.status = filters.status;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {
        ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
        ...(filters.endDate ? { lte: new Date(filters.endDate) } : {})
      };
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        customer: true,
        orderItems: { include: { product: true } },
        payments: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const totalRevenue = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
    const totalPaid = orders.reduce((s, o) => s + (o.paymentStatus === 'PAID' ? (o.totalAmount || 0) : o.payments.reduce((ps, p) => ps + p.paidAmount, 0)), 0);

    return {
      summary: {
        totalOrders: orders.length,
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalPending: Number((totalRevenue - totalPaid).toFixed(2))
      },
      orders
    };
  }

  static async getSaleOrderItemsReportData(filters: { franchiseId?: string; startDate?: string; endDate?: string }) {
    const where: any = {};
    if (filters.franchiseId) where.order = { franchiseId: filters.franchiseId };
    if (filters.startDate || filters.endDate) {
      where.order = {
        ...(where.order || {}),
        createdAt: {
          ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
          ...(filters.endDate ? { lte: new Date(filters.endDate) } : {})
        }
      };
    }

    const items = await prisma.orderItem.findMany({
      where,
      include: {
        product: true,
        order: { select: { id: true, invoiceNum: true, createdAt: true, status: true, customer: { select: { name: true } } } }
      }
    });

    return items.map(item => ({
      id: item.id,
      orderId: item.orderId,
      orderNumber: item.order?.invoiceNum,
      orderDate: item.order?.createdAt,
      orderStatus: item.order?.status,
      customerName: item.order?.customer?.name || 'Walk-in',
      productName: item.product?.name || 'Item',
      productSku: item.product?.sku,
      quantity: item.quantity,
      unitPrice: item.price,
      totalAmount: item.totalAmount || (item.quantity * item.price),
      totalCost: item.totalCost || 0
    }));
  }

  static async getFranchiseReportData(franchiseId?: string) {
    const franchises = await prisma.franchise.findMany({
      where: franchiseId ? { id: franchiseId } : undefined,
      include: {
        orders: { where: { status: 'COMPLETED' } },
        expenses: { where: { isCancelled: false } },
        users: { select: { id: true } }
      },
      orderBy: { name: 'asc' }
    });

    return franchises.map(f => {
      const totalSales = f.orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
      const totalExpenses = f.expenses.reduce((s, e) => s + (e.amount || 0), 0);

      return {
        id: f.id,
        name: f.name,
        location: f.location,
        ownerName: f.ownerName,
        contactNum: f.contactNum,
        status: f.status,
        totalSales: Number(totalSales.toFixed(2)),
        totalExpenses: Number(totalExpenses.toFixed(2)),
        creditLimit: f.creditLimit || 0,
        outstandingAmount: f.outstandingAmount || 0,
        walletBalance: f.walletBalance || 0,
        ordersCount: f.orders.length,
        usersCount: f.users.length
      };
    });
  }
}

