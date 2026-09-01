import prisma from '../../lib/prisma';
import { AccountService } from './account.service';
import { POSService } from '../pos/pos.service';
import { ItemCategory, PaymentMode } from '@prisma/client';
import { PaymentValidationError } from '../../utils/errors';
import { splitGstAmount } from '../../utils/gst-tax.util';


function parseInclusiveDates(startDate?: string | Date, endDate?: string | Date): { start?: Date; end?: Date } {
  let start: Date | undefined = undefined;
  let end: Date | undefined = undefined;
  if (startDate) {
    start = new Date(startDate);
  }
  if (endDate) {
    end = new Date(endDate);
    if (end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0) {
      end.setHours(23, 59, 59, 999);
    }
  }
  return { start, end };
}

// Builds a Prisma date-range filter where `endDate` covers the whole day
// (up to 23:59:59.999 of that date) rather than cutting off at 00:00:00.
function buildCreatedAtFilter(startDate?: string | Date, endDate?: string | Date): { createdAt?: { gte?: Date; lte?: Date } } {
  if (!startDate && !endDate) return {};
  const { start, end } = parseInclusiveDates(startDate, endDate);
  const range: { gte?: Date; lte?: Date } = {};
  if (start) range.gte = start;
  if (end) range.lte = end;
  return { createdAt: range };
}

function normalizeReportFilters(param1?: any, param2?: any, param3?: any, param4?: any): {
  franchiseId?: string;
  startDate?: string | Date;
  endDate?: string | Date;
  category?: string;
  extra?: any;
} {
  if (typeof param1 === 'object' && param1 !== null && !(param1 instanceof Date)) {
    return {
      franchiseId: typeof param1.franchiseId === 'string' ? param1.franchiseId : undefined,
      startDate: param1.startDate || param1.fromDate,
      endDate: param1.endDate || param1.toDate,
      category: param1.category || param2,
      extra: param1
    };
  }
  return {
    franchiseId: typeof param1 === 'string' ? param1 : undefined,
    startDate: param2,
    endDate: param3,
    category: param4
  };
}

// A Tax Invoice (orderType 'TAX_INVOICE') is legally final at issuance — its
// GST liability exists regardless of downstream fulfillment status (nothing
// in this codebase ever moves a TAX_INVOICE order's status off PENDING; see
// sales.service.ts convertProformaToInvoice). A POS/walk-in order (any other
// orderType) is only final once COMPLETED/REFUNDED, same as before. CANCELLED
// is never final for either.
function finalSaleWhere(extra: Record<string, any> = {}) {
  return {
    ...extra,
    OR: [
      { orderType: 'TAX_INVOICE', status: { not: 'CANCELLED' as any } },
      { orderType: { not: 'TAX_INVOICE' }, status: { in: ['COMPLETED', 'REFUNDED'] as any } }
    ]
  };
}

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

      // 1. Calculate Tax & Final Amount directly from authoritative order record
      const subTotal = order.subTotal;
      const taxAmount = order.taxAmount ?? Number((subTotal * 0.05).toFixed(2));
      const finalAmount = order.totalAmount ?? (subTotal + taxAmount);
      const invoiceStatus = order.paymentStatus === 'PAID' ? 'PAID' : (order.status === 'COMPLETED' ? 'PAID' : 'UNPAID');

      // 2. Create Invoice
      const invoice = await tx.invoice.upsert({
        where: { orderId },
        update: {
          totalAmount: subTotal,
          taxAmount: taxAmount,
          finalAmount: finalAmount,
          status: invoiceStatus
        },
        create: {
          orderId,
          totalAmount: subTotal,
          taxAmount: taxAmount,
          finalAmount: finalAmount,
          status: invoiceStatus
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
    const { start, end } = parseInclusiveDates(filters.startDate, filters.endDate);
    const dateQuery = {
      ...(start || end ? {
        gte: start,
        lte: end
      } : {})
    };

    // 1. Revenue
    const sales = await prisma.invoice.findMany({
      where: {
        status: 'PAID',
        ...(start || end ? { createdAt: dateQuery } : {}),
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
      // Tax-exclusive net sales revenue (subTotal before tax)
      const subTotalRevenue = (inv.totalAmount !== undefined && inv.totalAmount !== null && inv.totalAmount > 0)
        ? inv.totalAmount
        : (inv.finalAmount - (inv.taxAmount || 0));
      totalRevenue += subTotalRevenue;
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
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      },
      _sum: { totalAmount: true, cgst: true, sgst: true, igst: true }
    });
    const totalPurchases = purchaseAggregate._sum.totalAmount || 0;
    const totalInputTax = (purchaseAggregate._sum.cgst || 0) + (purchaseAggregate._sum.sgst || 0) + (purchaseAggregate._sum.igst || 0);

    // 3. Expenses
    const expenses = await prisma.expense.aggregate({
      where: {
        ...(start || end ? { date: dateQuery } : {}),
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
      period: { franchiseId: filters.franchiseId, startDate: start, endDate: end }
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
    // Reuse AccountService.getAccounts — the exact source of truth the
    // Bank Accounts page already reads correctly — instead of re-querying
    // `prisma.account` with a literal `franchiseId: null` filter. That
    // literal-null query silently returned zero rows for SUPER_ADMIN/HQ
    // callers (the common case, since neither this endpoint nor its
    // frontend caller ever pass a franchiseId), because Account rows are
    // stored under the real HQ franchise id (see AccountService.getAccounts'
    // "literal-HQ-id convention" note), never franchiseId: null. That
    // mismatch — not bad type classification — is why every summary card
    // here showed ₹0 while Bank Accounts, which resolves the same `null`
    // input to the real HQ id first, showed correct balances.
    const accounts = await AccountService.getAccounts(franchiseId);

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

  // entityId is a foreign id into one of several master tables depending on
  // entityType (CUSTOMER/DEALER/FRANCHISE/VENDOR) — Payment has no FK/relation
  // for it (it's deliberately generic across modules), so resolving a display
  // name means a manual per-type lookup instead of an `include`.
  private static async resolvePartyName(entityType: string | null, entityId: string | null): Promise<string | null> {
    if (!entityId) return null;
    switch (entityType) {
      case 'CUSTOMER': return (await prisma.customer.findUnique({ where: { id: entityId } }))?.name || null;
      case 'DEALER': return (await prisma.dealer.findUnique({ where: { id: entityId } }))?.name || null;
      case 'FRANCHISE': return (await prisma.franchise.findUnique({ where: { id: entityId } }))?.name || null;
      case 'VENDOR': return (await prisma.vendor.findUnique({ where: { id: entityId } }))?.name || null;
      default: return null;
    }
  }

  static async getPayments(franchiseId?: string) {
    const payments = await prisma.payment.findMany({
      where: {
        ...(franchiseId ? { order: { franchiseId } } : {}),
      },
      include: { order: true, invoice: true, account: true },
      orderBy: { createdAt: 'desc' }
    });

    // Expense traceability — same additive-lookup pattern as
    // AccountService.getAccountById's `expenseById` join: linkedDocId has
    // no Prisma relation, so batch-resolve payee/category for every
    // EXPENSE-sourced payment here instead of leaving a fully-known source
    // (an Expense payment) to fall through to "Manual Entry".
    const expenseIds = Array.from(new Set(
      payments.filter(p => p.sourceModule === 'EXPENSE' && p.linkedDocId).map(p => p.linkedDocId as string)
    ));
    const linkedExpenses = expenseIds.length
      ? await prisma.expense.findMany({ where: { id: { in: expenseIds } }, select: { id: true, payee: true, category: true } })
      : [];
    const expenseById = new Map(linkedExpenses.map(e => [e.id, e]));

    return Promise.all(payments.map(async p => {
      const partyName = await this.resolvePartyName(p.entityType, p.entityId);

      // Fallback description for a payment whose party isn't resolvable via
      // resolvePartyName (Expense stores payee/category text in entityId,
      // not a Vendor id — see addExpense/recordExpensePayment — so the
      // VENDOR lookup above always misses for it) and has no transactionRef
      // either. Only used when both of those are already absent, so no
      // currently-correct entity string changes.
      let sourceLabel: string | null = null;
      if (p.sourceModule === 'EXPENSE') {
        const linkedExpense = p.linkedDocId ? expenseById.get(p.linkedDocId) : undefined;
        const payee = linkedExpense?.payee || p.entityId || null;
        const category = linkedExpense?.category || null;
        sourceLabel = payee ? `Expense - ${payee}` : category ? `Expense Payment - ${category}` : null;
      } else if (p.sourceModule === 'POS' && p.order?.customerName) {
        sourceLabel = `POS Payment - ${p.order.customerName}`;
      }

      return {
        id: p.id,
        paymentNumber: p.paymentNumber,
        // Both naming conventions are kept: `date`/`entity`/`method`/`amount`
        // for existing consumers (accounting/payments, franchise/payments),
        // `createdAt`/`paidAmount`/`paymentMode`/`entityId`/`entityType` for
        // consumers that read the raw Payment field names directly (sales
        // Payment-In list).
        date: p.createdAt.toISOString(),
        createdAt: p.createdAt.toISOString(),
        entity: partyName || p.transactionRef || sourceLabel || "Manual Entry",
        partyName: partyName,
        entityId: p.entityId,
        entityType: p.entityType,
        flow: p.entityType === 'VENDOR' ? 'OUT' : 'IN',
        method: p.paymentMode,
        paymentMode: p.paymentMode,
        amount: p.paidAmount,
        paidAmount: p.paidAmount,
        status: p.status,
        reference: p.transactionRef || "",
        type: p.type,
        sourceModule: p.sourceModule,
        linkedDocType: p.linkedDocType,
        linkedDocId: p.linkedDocId,
        invoiceId: p.invoiceId,
        orderId: p.order?.id || p.invoice?.orderId || null,
        invoiceNum: p.order?.invoiceNum || null,
        isCancelled: p.isCancelled,
        accountName: p.account?.name || "Unknown",
      };
    }));
  }

  static async getGstReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

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
          status: { not: 'CANCELLED' as any }
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

  static async getGstRateReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), ...dateFilter, status: 'COMPLETED' },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), ...dateFilter, status: { not: 'CANCELLED' as any } },
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
      (p.poItems || []).forEach(item => {
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

  static async getTcsReceivableData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

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

  static async getTdsPayableData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const purchases = await prisma.procurementOrder.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter,
        status: { not: 'CANCELLED' as any }
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

  static async getTdsReceivableData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

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

  static async getForm27eqData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

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
    // Server-side backstop for the ₹0/negative payment guard — the frontend
    // already checks this, but this is the only place that must actually
    // enforce it, since a client-supplied amount can never be trusted.
    if (!(amount > 0)) {
      throw new Error('Invalid payment amount: must be greater than zero.');
    }
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

      // 1. Resolve & Validate Account using AccountService rules
      const chequeDetails = {
        chequeNumber: data.chequeNumber,
        chequeDate: data.chequeDate,
        bankName: data.bankName
      };
      const account = await AccountService.validateAccountForPayment(
        data.method || resolvedPaymentMode,
        sourceId,
        data.franchiseId || null,
        chequeDetails,
        tx
      );

      // 2. Balance check for OUTFLOW + PAID
      if (flow === 'OUT' && status === 'PAID') {
        if (!account) throw new PaymentValidationError('INVALID_ACCOUNT_FOR_PAYMENT_MODE', `Source account not found.`);
        if (account.balance < amount) {
          throw new PaymentValidationError('INSUFFICIENT_FUNDS', `Insufficient balance in ${account.name}. Available: ₹${account.balance}`);
        }
      }

      // 2b. Overpayment guard for a Tax Invoice receipt — the invoice's
      // paid/outstanding split is computed by summing Payment rows (see
      // step 6 below), so a payment that pushes the total past what's owed
      // would silently produce a negative outstanding balance downstream.
      // Also resolves the Order this Invoice belongs to — Payment.orderId
      // is what franchise-scoped queries (FinanceService.getPayments) key
      // off, so a Payment with invoiceId set but orderId left null would
      // silently vanish from any franchise-filtered Payments list.
      let orderIdForInvoice: string | undefined;
      if (data.invoiceId) {
        const invoiceForGuard = await tx.invoice.findUnique({ where: { id: data.invoiceId } });
        if (!invoiceForGuard) throw new Error('Invoice not found.');
        orderIdForInvoice = invoiceForGuard.orderId;
        if (flow === 'IN' && status === 'PAID') {
          const paidSoFar = await tx.payment.aggregate({
            where: { invoiceId: data.invoiceId, status: 'PAID', isCancelled: false },
            _sum: { paidAmount: true },
          });
          const alreadyPaid = paidSoFar._sum.paidAmount || 0;
          const outstanding = invoiceForGuard.finalAmount - alreadyPaid;
          if (amount > outstanding + 0.01) {
            throw new Error(`Invalid payment amount: ₹${amount} exceeds the outstanding balance (₹${outstanding.toFixed(2)}) on this invoice.`);
          }
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
          orderId:        data.orderId || orderIdForInvoice || undefined,
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
    partyType?: string;
    partyId?: string;
    customerId?: string;
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
          partyType: (data.partyType || 'CUSTOMER') as any,
          partyId: data.partyId,
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

      // "Collect payment now" at invoice-creation time is routed through the
      // same central FinanceService.createPayment() mechanism the standalone
      // Record Payment flow (payment-in) already uses correctly, instead of
      // a bespoke inline Payment-create + Account.balance increment. This
      // was previously duplicated here and — critically — always wrote
      // status: 'PAID' and moved real money even when `received` only
      // partially covered the invoice, bypassing createPayment's overpayment
      // guard and its single source of truth for recomputing Invoice/Order
      // status from the real summed Payment rows. When received is 0 (the
      // honest default for a draft/credit invoice), nothing is created here
      // at all — no Payment row, no balance movement.
      if (received > 0) {
        const paymentMode = data.paymentMode || 'CASH';
        const accountTypeMap: Record<string, string> = {
          'CASH': 'CASH',
          'UPI': 'UPI',
          'CARD': 'BANK',
          'BANK_TRANSFER': 'BANK'
        };
        const targetType = accountTypeMap[paymentMode] || 'CASH';
        const isNonCustomerParty = !!data.partyType && data.partyType !== 'CUSTOMER';

        await this.createPayment({
          tx,
          amount: received,
          flow: 'IN',
          status: 'PAID',
          sourceAccount: targetType,
          method: paymentMode,
          franchiseId: data.franchiseId,
          invoiceId: invoice.id,
          orderId: order.id,
          entityType: isNonCustomerParty ? data.partyType : 'CUSTOMER',
          entityId: isNonCustomerParty ? data.partyId : data.customerId,
          type: 'INVOICE_LINKED',
          // PaymentSourceModule has no 'INVOICE' value — 'POS' is what the
          // previous inline Payment.create used here too, and getPayments'
          // party-name resolution (sourceModule === 'POS' && order.customerName)
          // and the Cash Flow report both key off it, so keeping it avoids
          // silently reclassifying every "collect payment now" Tax Invoice
          // payment out of the bucket both already handle correctly.
          sourceModule: 'POS',
          linkedDocType: 'INVOICE',
          linkedDocId: invoice.id,
          createdBy: data.createdBy || 'SYSTEM'
        });
      }

      if (data.customerId) {
        const resolveLedgerPaymentMode = (mode?: string): PaymentMode => {
          if (!mode || mode === 'CREDIT') return PaymentMode.CASH;
          if (mode === 'BANK') return PaymentMode.BANK_TRANSFER;
          if (Object.values(PaymentMode).includes(mode as PaymentMode)) {
            return mode as PaymentMode;
          }
          return PaymentMode.CASH;
        };

        const ledgerPaymentMode = resolveLedgerPaymentMode(data.paymentMode);

        await tx.customerLedger.create({
          data: {
            customerId: data.customerId,
            type: 'DEBIT',
            amount: totalAmount,
            paymentMode: ledgerPaymentMode,
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
              paymentMode: ledgerPaymentMode,
              referenceType: 'PAYMENT',
              referenceId: order.id,
              note: `Payment Received for Invoice #${invoiceNum}`
            }
          });
        }
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
    const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 50));
    const skip = (page - 1) * limit;

    const { start, end } = parseInclusiveDates(filters.startDate, filters.endDate);
    const dateQuery = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {})
    };

    const whereClause: any = {
      ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
      ...((start || end) ? { createdAt: dateQuery } : {}),
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
    startDate?: Date | string;
    endDate?: Date | string;
    vendorId?: string;
    status?: string;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = filters.search
      ? 1000
      : Math.max(1, Math.min(1000, Number(filters.limit) || 50));
    const skip = filters.search ? 0 : (page - 1) * limit;

    const { start: pStart, end: pEnd } = parseInclusiveDates(filters.startDate, filters.endDate);
    const poDateQuery = {
      ...(pStart ? { gte: pStart } : {}),
      ...(pEnd ? { lte: pEnd } : {})
    };

    const whereClause: any = {
      ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
      ...((pStart || pEnd) ? { createdAt: poDateQuery } : {}),
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
          },
          goodsReceipts: {
            include: {
              items: {
                include: {
                  inventoryItem: true
                }
              }
            }
          },
          invoices: true
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    const data = pos.map(po => {
      // Flatten all GRN items for this PO
      const allGrnItems = po.goodsReceipts.flatMap(grn => grn.items || []);

      const mappedItems = po.poItems.map(item => {
        const matchingGrnItem = allGrnItems.find(
          g => g.materialId === item.inventoryItemId || (g as any).inventoryItem?.name === item.inventoryItem?.name
        );

        const poPrice = item.price || 0;
        const actualGrnPrice = matchingGrnItem ? matchingGrnItem.price : poPrice;
        const priceVariance = Number((actualGrnPrice - poPrice).toFixed(2));
        const priceVariancePercent = poPrice > 0 ? Number((((actualGrnPrice - poPrice) / poPrice) * 100).toFixed(2)) : 0;

        const isFullyReceived = po.status === 'RECEIVED' || po.status === 'CLOSED';
        const receivedQty = matchingGrnItem
          ? (matchingGrnItem.acceptedQty || matchingGrnItem.receivedQty || 0)
          : (isFullyReceived ? item.quantity : 0);
        const rejectedQty = matchingGrnItem ? (matchingGrnItem.rejectedQty || 0) : 0;
        const pendingQty = Math.max(0, (item.quantity || 0) - receivedQty);

        const lineTaxableValue = Number(((matchingGrnItem ? receivedQty : item.quantity) * actualGrnPrice).toFixed(2));

        return {
          itemId: item.inventoryItemId || item.id,
          itemName: item.inventoryItem?.name || 'Unknown Material',
          unit: item.unit || item.inventoryItem?.unit || 'UNIT',
          orderedQty: item.quantity,
          receivedQty,
          rejectedQty,
          pendingQty,
          poPrice,
          actualGrnPrice,
          priceVariance,
          priceVariancePercent,
          priceOverridden: Boolean(matchingGrnItem?.priceOverridden),
          taxableValue: lineTaxableValue
        };
      });

      const totalBillAmount = po.invoices && po.invoices.length > 0
        ? po.invoices.reduce((sum, inv) => sum + (inv.amount || 0), 0)
        : po.totalAmount;

      return {
        id: po.id,
        createdAt: po.createdAt,
        poNumber: po.poNumber || po.id,
        vendorName: po.vendor?.name || '—',
        vendorGstin: po.vendor?.gstNumber || '—',
        vendorState: po.vendor?.state || '—',
        status: po.status,
        paymentMode: po.paymentStatus === 'PAID' ? 'CASH' : 'CREDIT',
        paymentStatus: po.paymentStatus,
        subtotal: po.subtotal || 0,
        cgst: po.cgst || 0,
        sgst: po.sgst || 0,
        igst: po.igst || 0,
        freight: po.freightCost || 0,
        totalAmount: po.totalAmount,
        finalBillAmount: totalBillAmount,
        advancePaid: po.paid || po.advancePaid || 0,
        balance: po.balance,
        items: mappedItems,
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
    startDate?: Date | string;
    endDate?: Date | string;
    paymentMode?: string;
    voucherType?: string;
    page?: number;
    limit?: number;
  }) {
    const franchiseWhere = this.paymentFranchiseWhere(filters.franchiseId);
    const { start, end } = parseInclusiveDates(filters.startDate, filters.endDate);

    let openingBalance = 0;
    if (start) {
      const preInflows = await prisma.payment.aggregate({
        where: {
          ...franchiseWhere,
          NOT: this.PAYMENT_OUTFLOW_FILTER,
          createdAt: { lt: start },
          status: 'PAID',
          isCancelled: false
        },
        _sum: { paidAmount: true }
      });

      const preOutflows = await prisma.payment.aggregate({
        where: {
          AND: [franchiseWhere, this.PAYMENT_OUTFLOW_FILTER],
          createdAt: { lt: start },
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
    const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 50));
    const skip = (page - 1) * limit;

    const dateQuery = {
      ...(start ? { gte: start } : {}),
      ...(end ? { lte: end } : {})
    };

    const whereClause: any = {
      ...franchiseWhere,
      status: 'PAID',
      isCancelled: false,
      ...((start || end) ? { createdAt: dateQuery } : {}),
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
    startDate?: Date | string;
    endDate?: Date | string;
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.max(1, Math.min(1000, Number(filters.limit) || 50));
    const skip = (page - 1) * limit;

    const { start: txStart, end: txEnd } = parseInclusiveDates(filters.startDate, filters.endDate);
    const dateQuery = {
      ...(txStart ? { gte: txStart } : {}),
      ...(txEnd ? { lte: txEnd } : {})
    };

    const whereClause: any = {
      ...this.paymentFranchiseWhere(filters.franchiseId),
      isCancelled: false,
      ...((txStart || txEnd) ? { createdAt: dateQuery } : {}),
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

  static async getTrialBalanceReport(filtersInput?: any) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(filtersInput);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    // 1. Fetch Cash, Bank, and UPI accounts
    const accounts = await prisma.account.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        status: "ACTIVE"
      }
    });

    const cashBalance = accounts.filter(a => a.type === "CASH").reduce((s, a) => s + (a.balance || 0), 0);
    const bankBalance = accounts.filter(a => a.type === "BANK").reduce((s, a) => s + (a.balance || 0), 0);
    const upiBalance = accounts.filter(a => a.type === "UPI").reduce((s, a) => s + (a.balance || 0), 0);

    // 2. Fetch Customer ledger entries for dynamic Sundry Debtors
    const customers = await prisma.customer.findMany({
      where: { ...(franchiseId ? { franchiseId } : {}) },
      include: {
        ledgerEntries: {
          where: dateFilter
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
        ...(franchiseId ? { franchiseId } : {}),
        status: { not: "CANCELLED" as any },
        ...dateFilter
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
        ...(franchiseId ? { franchiseId } : {}),
        status: { not: "CANCELLED" as any },
        ...dateFilter
      },
      _sum: { totalAmount: true }
    });
    const totalSales = salesAggregate._sum.totalAmount || 0;

    // 5. Calculate Purchase Costs
    const purchaseAggregate = await prisma.procurementOrder.aggregate({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        status: { not: "CANCELLED" as any },
        ...dateFilter
      },
      _sum: { totalAmount: true }
    });
    const totalPurchases = purchaseAggregate._sum.totalAmount || 0;

    // 6. Calculate Indirect Expenses
    const expenseDateFilter = (start || end) ? {
      date: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};
    const expenseAggregate = await prisma.expense.aggregate({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        isCancelled: false,
        ...expenseDateFilter
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

    // 2. Fetch Inventory Stock Valuation using operational costing (currentStock * costPrice)
    const invReport = await this.getInventoryValuationReport(filters.franchiseId);
    const inventoryValuation = invReport?.summary?.totalStockValue || 0;

    // 3. Fetch Customer ledger entries for dynamic Sundry Debtors
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

    // 4. Fetch Procurement Orders to calculate Sundry Creditors liability
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

    // 5. Fetch Profit & Loss metrics to align Net Profit accounting basis ((Revenue - COGS) - Expenses)
    const plReport = await this.getProfitAndLoss(filters);
    const totalSales = plReport.revenue;
    const totalCOGS = plReport.cogs;
    const totalExpenses = plReport.expenses;
    const netProfit = plReport.netProfit;

    const currentAssetsAmount = cashBalance + bankBalance + upiBalance + totalDebtorsDebit + inventoryValuation;
    const currentLiabilitiesAmount = sundryCreditorsBalance >= 0 ? sundryCreditorsBalance : 0;

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
        { name: "Current Assets", amount: currentAssetsAmount > 0 ? currentAssetsAmount : 0, notes: "Includes Cash, Bank, Debtors, and Inventory Valuation" },
        { name: "  • Cash & Bank Liquidity", amount: cashBalance + bankBalance + upiBalance, notes: "Cash, Bank, and UPI accounts" },
        { name: "  • Sundry Debtors", amount: totalDebtorsDebit, notes: "Customer outstanding receivables" },
        { name: "  • Inventory Stock Valuation", amount: inventoryValuation, notes: "Stock in hand valued at cost price" },
        { name: "Other Assets", amount: 0, notes: "—" }
      ],
      liabilities: [
        { name: "Capital Account", amount: 0, notes: "—" },
        { name: "Long-term Liabilities", amount: 0, notes: "—" },
        { name: "Current Liabilities", amount: currentLiabilitiesAmount, notes: "Includes Sundry Creditors / Vendor Payables" },
        { name: "Other Liabilities", amount: 0, notes: "—" },
        { name: "Retained Earnings / Profit & Loss Balance", amount: netProfit, notes: "Aligned with Profit & Loss Net Profit ((Revenue - COGS) - Expenses)" }
      ],
      details: {
        sundryDebtors,
        sundryCreditors,
        accounts: accountDetails,
        cashBalance,
        bankBalance,
        upiBalance,
        totalDebtorsDebit,
        inventoryValuation,
        sundryCreditorsBalance,
        totalSales,
        totalCOGS,
        totalExpenses,
        netProfit
      }
    };
  }

  static async getBillWiseProfitReport(filters: {
    franchiseId?: string;
    startDate?: Date | string;
    endDate?: Date | string;
  }) {
    const { start, end } = parseInclusiveDates(filters.startDate, filters.endDate);
    const orders = await prisma.order.findMany({
      where: {
        ...(filters.franchiseId ? { franchiseId: filters.franchiseId } : {}),
        status: "COMPLETED",
        ...((start || end) ? {
          createdAt: {
            ...(start ? { gte: start } : {}),
            ...(end ? { lte: end } : {})
          }
        } : {})
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

  static async getStockDetailData(franchiseId?: string, startDate?: string | Date, endDate?: string | Date) {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    const items = await prisma.inventoryItem.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        isActive: true
      },
      orderBy: { name: 'asc' }
    });

    const itemIds = items.map(i => i.id);

    const [priorMovements, periodMovements] = await Promise.all([
      start ? prisma.stockMovement.findMany({
        where: {
          itemId: { in: itemIds },
          createdAt: { lt: start }
        }
      }) : Promise.resolve([]),
      prisma.stockMovement.findMany({
        where: {
          itemId: { in: itemIds },
          ...(start || end ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          } : {})
        }
      })
    ]);

    const priorInwardTypes = ['PURCHASE_IN', 'PRODUCTION_IN', 'TRANSFER_IN', 'RECALL_RETURN_IN'];
    const priorOutwardTypes = ['SALES_OUT', 'PRODUCTION_OUT', 'WASTE_OUT', 'TRANSFER_OUT', 'RETURN_OUT', 'RETURN_QUARANTINE_IN'];

    const priorMap: Record<string, number> = {};
    priorMovements.forEach(m => {
      if (!priorMap[m.itemId]) priorMap[m.itemId] = 0;
      if (priorInwardTypes.includes(m.movementType) || (m.movementType === 'ADJUSTMENT' && m.quantity > 0)) {
        priorMap[m.itemId] += m.quantity;
      } else if (priorOutwardTypes.includes(m.movementType) || (m.movementType === 'ADJUSTMENT' && m.quantity < 0)) {
        priorMap[m.itemId] -= Math.abs(m.quantity);
      }
    });

    const periodInMap: Record<string, number> = {};
    const periodOutMap: Record<string, number> = {};
    periodMovements.forEach(m => {
      if (!periodInMap[m.itemId]) periodInMap[m.itemId] = 0;
      if (!periodOutMap[m.itemId]) periodOutMap[m.itemId] = 0;

      if (priorInwardTypes.includes(m.movementType) || (m.movementType === 'ADJUSTMENT' && m.quantity > 0)) {
        periodInMap[m.itemId] += m.quantity;
      } else if (priorOutwardTypes.includes(m.movementType) || (m.movementType === 'ADJUSTMENT' && m.quantity < 0)) {
        periodOutMap[m.itemId] += Math.abs(m.quantity);
      }
    });

    return items.map(item => {
      const beginningQuantity = start ? (priorMap[item.id] || 0) : 0;
      const quantityIn = periodInMap[item.id] || 0;
      const quantityOut = periodOutMap[item.id] || 0;
      const closingQuantity = beginningQuantity + quantityIn - quantityOut;

      const purchasePrice = item.costPrice || 0;
      const salePrice = item.customerPrice || item.basePrice || 0;

      return {
        itemName: item.name,
        beginningQuantity: Number(beginningQuantity.toFixed(2)),
        quantityIn: Number(quantityIn.toFixed(2)),
        purchaseAmount: Number((quantityIn * purchasePrice).toFixed(2)),
        quantityOut: Number(quantityOut.toFixed(2)),
        saleAmount: Number((quantityOut * salePrice).toFixed(2)),
        closingQuantity: Number(closingQuantity.toFixed(2))
      };
    });
  }

  static async getItemDetailData(franchiseId?: string, itemName?: string, startDate?: string | Date, endDate?: string | Date) {
    const whereClause: any = { isActive: true };
    if (franchiseId) whereClause.franchiseId = franchiseId;
    if (itemName) whereClause.name = { contains: itemName, mode: 'insensitive' };

    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;

    const items = await prisma.inventoryItem.findMany({
      where: whereClause,
      include: {
        vendor: true,
        movements: {
          where: {
            ...(start || end ? {
              createdAt: {
                ...(start ? { gte: start } : {}),
                ...(end ? { lte: end } : {})
              }
            } : {})
          },
          orderBy: { createdAt: 'desc' }
        }
      },
      orderBy: { name: 'asc' }
    });

    const itemIds = items.map(i => i.id);
    const priorMovements = start ? await prisma.stockMovement.findMany({
      where: {
        itemId: { in: itemIds },
        createdAt: { lt: start }
      }
    }) : [];

    const priorInwardTypes = ['PURCHASE_IN', 'PRODUCTION_IN', 'TRANSFER_IN', 'RECALL_RETURN_IN'];
    const priorOutwardTypes = ['SALES_OUT', 'PRODUCTION_OUT', 'WASTE_OUT', 'TRANSFER_OUT', 'RETURN_OUT', 'RETURN_QUARANTINE_IN'];

    const priorMap: Record<string, number> = {};
    priorMovements.forEach(m => {
      if (!priorMap[m.itemId]) priorMap[m.itemId] = 0;
      if (priorInwardTypes.includes(m.movementType) || (m.movementType === 'ADJUSTMENT' && m.quantity > 0)) {
        priorMap[m.itemId] += m.quantity;
      } else if (priorOutwardTypes.includes(m.movementType) || (m.movementType === 'ADJUSTMENT' && m.quantity < 0)) {
        priorMap[m.itemId] -= Math.abs(m.quantity);
      }
    });

    return items.map(item => {
      const beginningQuantity = start ? (priorMap[item.id] || 0) : 0;
      return {
        id: item.id,
        name: item.name,
        sku: item.sku,
        category: item.category,
        unit: item.unit,
        hsnCode: item.hsnCode,
        gstRate: item.gstRate,
        currentStock: item.currentStock,
        minimumStock: item.minimumStock,
        beginningQuantity: Number(beginningQuantity.toFixed(2)),
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
      };
    });
  }

  static async getBankStatementData(franchiseIdOrFilters?: any, accountIdParam?: string, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate, extra } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const accountId = typeof franchiseIdOrFilters === 'object' && franchiseIdOrFilters !== null ? franchiseIdOrFilters.accountId : accountIdParam;
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    let accountIds: string[] = [];
    if (accountId && accountId !== 'NONE') {
      accountIds = [accountId];
    } else {
      const bankAccounts = await prisma.account.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), type: 'BANK' }
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
        ...(start ? { createdAt: { lt: start } } : {})
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

  static async getDiscountReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const sales = await prisma.order.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
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

  static async getGSTR1Data(franchiseIdOrFilters?: any, startDateParam?: string | Date, endDateParam?: string | Date) {
    const { franchiseId, startDate, endDate, extra } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const dateFilter = buildCreatedAtFilter(startDate, endDate);
    const partyId = extra?.partyId;
    const gstRate = extra?.gstRate !== undefined && extra?.gstRate !== '' ? Number(extra.gstRate) : undefined;

    const orders = await prisma.order.findMany({
      where: finalSaleWhere({
        ...(franchiseId ? { franchiseId } : {}),
        ...(partyId ? { customerId: partyId } : {}),
        ...dateFilter
      }),
      include: { customer: true, franchise: { select: { location: true } }, orderItems: { include: { product: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const toRow = (o: any) => {
      const split = splitGstAmount(o.taxAmount || 0, o.stateOfSupply, o.franchise?.location || null);
      const isB2B = Boolean(o.customer?.gstNumber && o.customer.gstNumber.trim() !== '');
      const taxableValue = o.subTotal || 0;
      const taxAmount = o.taxAmount || 0;
      const taxRate = taxableValue > 0 ? Number(((taxAmount / taxableValue) * 100).toFixed(2)) : 0;

      return {
        invoiceNo: o.invoiceNum || o.id,
        date: o.createdAt.toISOString().split('T')[0],
        partyName: o.customer?.name || 'Cash Customer',
        gstin: o.customer?.gstNumber || '—',
        customerGstin: o.customer?.gstNumber || '—',
        b2bType: isB2B ? 'B2B' : 'B2C',
        placeOfSupply: o.stateOfSupply || '—',
        value: o.totalAmount || 0,
        taxRate,
        cessRate: 0,
        taxableValue: Number(taxableValue.toFixed(2)),
        igst: Number(split.igst.toFixed(2)),
        cgst: Number(split.cgst.toFixed(2)),
        sgst: Number(split.sgst.toFixed(2)),
        integratedTax: Number(split.igst.toFixed(2)),
        centralTax: Number(split.cgst.toFixed(2)),
        stateTax: Number(split.sgst.toFixed(2)),
        cessAmount: 0,
        totalTax: Number(taxAmount.toFixed(2)),
        totalAmount: Number((o.totalAmount || 0).toFixed(2))
      };
    };

    // A TAX_INVOICE order is final at any non-REFUNDED status (see
    // finalSaleWhere) — only a REFUNDED POS order is a "return" row here.
    let sale = orders.filter((o: any) => o.status !== 'REFUNDED').map(toRow);
    let saleReturn = orders.filter((o: any) => o.status === 'REFUNDED').map(toRow);
    if (gstRate !== undefined && !Number.isNaN(gstRate)) {
      sale = sale.filter((r) => r.taxRate === gstRate);
      saleReturn = saleReturn.filter((r) => r.taxRate === gstRate);
    }

    // Applicable Sales Credit Notes (approved returns with a backfilled tax
    // split) adjust GSTR-1 as negative rows rather than mutating the
    // original Tax Invoice.
    const creditNoteRows = await prisma.returnOrder.findMany({
      where: {
        // APPROVED and COMPLETED (refunded) both count — recordRefund moves
        // a return from APPROVED to COMPLETED, and it must not drop out of
        // GSTR-1 just because the refund was paid out.
        status: { in: ['APPROVED', 'COMPLETED'] },
        taxAmount: { not: null },
        ...(franchiseId ? { franchiseId } : {}),
        ...(partyId ? { customerId: partyId } : {}),
        ...dateFilter
      },
      include: { customer: true }
    });
    const creditNotes = creditNoteRows.map((r) => ({
      invoiceNo: r.returnNumber,
      date: r.createdAt.toISOString().split('T')[0],
      partyName: r.customer?.name || 'Cash Customer',
      gstin: r.customer?.gstNumber || '—',
      taxableValue: -(r.taxableValue || 0),
      cgst: -(r.cgst || 0),
      sgst: -(r.sgst || 0),
      igst: -(r.igst || 0),
      totalTax: -(r.taxAmount || 0)
    }));

    const totalTaxableValue = sale.reduce((s, r) => s + r.taxableValue, 0) + creditNotes.reduce((s, r) => s + r.taxableValue, 0);
    const totalOutputGST = sale.reduce((s, r) => s + r.totalTax, 0) + creditNotes.reduce((s, r) => s + r.totalTax, 0);

    return {
      sale,
      saleReturn,
      creditNotes,
      totalTaxableValue,
      totalOutputGST
    };
  }

  static async getGSTR2Data(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate, extra } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const dateFilter = buildCreatedAtFilter(startDate, endDate);
    const partyId = extra?.partyId;
    const gstRate = extra?.gstRate !== undefined && extra?.gstRate !== '' ? Number(extra.gstRate) : undefined;

    // Queries VendorInvoice (the Purchase Bill) directly — a PO or GRN with
    // no bill against it never appears here, satisfying "PO/GRN alone must
    // not create GST entries."
    const invoices = await prisma.vendorInvoice.findMany({
      where: {
        procurementOrder: { ...(franchiseId ? { franchiseId } : {}), status: { not: 'CANCELLED' as any } },
        ...(partyId ? { vendorId: partyId } : {}),
        ...dateFilter
      },
      include: { vendor: true, procurementOrder: { select: { poNumber: true } } },
      orderBy: { createdAt: 'desc' }
    });

    let data = invoices.map(inv => {
      const taxableValue = inv.subtotal || 0;
      const totalTax = (inv.igst || 0) + (inv.cgst || 0) + (inv.sgst || 0);
      return {
        invoiceNumber: inv.invoiceNumber,
        poNumber: inv.procurementOrder?.poNumber || inv.poId,
        date: (inv.billDate || inv.createdAt).toISOString().split('T')[0],
        vendorName: inv.vendor?.name || '—',
        vendorGstin: inv.vendor?.gstNumber || '—',
        taxableValue,
        taxRate: taxableValue > 0 ? Number(((totalTax / taxableValue) * 100).toFixed(2)) : 0,
        igst: inv.igst || 0,
        cgst: inv.cgst || 0,
        sgst: inv.sgst || 0,
        totalTax,
        eligibleItc: totalTax,
        totalAmount: inv.amount,
        status: inv.status
      };
    });
    if (gstRate !== undefined && !Number.isNaN(gstRate)) {
      data = data.filter((r) => r.taxRate === gstRate);
    }

    // Applicable Purchase Debit Notes adjust GSTR-2 as negative rows rather
    // than mutating the original Purchase Bill.
    const debitNoteRows = await prisma.purchaseReturn.findMany({
      where: {
        status: { in: ['APPROVED', 'COMPLETED'] },
        taxAmount: { not: null },
        ...(partyId ? { vendorId: partyId } : {}),
        ...dateFilter
      },
      include: { vendor: true }
    });
    const debitNotes = debitNoteRows.map((r) => ({
      returnNumber: r.returnNumber,
      date: r.createdAt.toISOString().split('T')[0],
      vendorName: r.vendor?.name || '—',
      vendorGstin: r.vendor?.gstNumber || '—',
      taxableValue: -(r.taxableValue || 0),
      cgst: -(r.cgst || 0),
      sgst: -(r.sgst || 0),
      igst: -(r.igst || 0),
      totalTax: -(r.taxAmount || 0)
    }));

    const totalTaxableValue = data.reduce((s, r) => s + r.taxableValue, 0) + debitNotes.reduce((s, r) => s + r.taxableValue, 0);
    const totalInputGST = data.reduce((s, r) => s + r.totalTax, 0) + debitNotes.reduce((s, r) => s + r.totalTax, 0);

    return {
      data,
      debitNotes,
      totalTaxableValue,
      totalInputGST
    };
  }

  static async getGSTR3BData(franchiseIdOrFilters?: any, startDateParam?: string | Date, endDateParam?: string | Date) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const dateFilter = buildCreatedAtFilter(startDate, endDate);

    const [orders, purchasesAgg, creditNoteAgg, debitNoteAgg] = await Promise.all([
      prisma.order.findMany({
        where: finalSaleWhere({ ...(franchiseId ? { franchiseId } : {}), ...dateFilter }),
        select: { subTotal: true, taxAmount: true, totalAmount: true, stateOfSupply: true, franchise: { select: { location: true } } }
      }),
      prisma.vendorInvoice.aggregate({
        where: {
          procurementOrder: { ...(franchiseId ? { franchiseId } : {}), status: { not: 'CANCELLED' as any } },
          ...dateFilter
        },
        _sum: { subtotal: true, cgst: true, sgst: true, igst: true }
      }),
      prisma.returnOrder.aggregate({
        where: { status: { in: ['APPROVED', 'COMPLETED'] }, taxAmount: { not: null }, ...(franchiseId ? { franchiseId } : {}), ...dateFilter },
        _sum: { taxableValue: true, cgst: true, sgst: true, igst: true, taxAmount: true }
      }),
      prisma.purchaseReturn.aggregate({
        where: { status: { in: ['APPROVED', 'COMPLETED'] }, taxAmount: { not: null }, ...dateFilter },
        _sum: { taxableValue: true, cgst: true, sgst: true, igst: true, taxAmount: true }
      })
    ]);

    let outputTaxable = 0;
    let outputTax = 0;
    let outputIgst = 0;
    let outputCgst = 0;
    let outputSgst = 0;

    orders.forEach(o => {
      outputTaxable += o.subTotal || 0;
      const t = o.taxAmount || 0;
      outputTax += t;
      const split = splitGstAmount(t, o.stateOfSupply, o.franchise?.location || null);
      outputIgst += split.igst;
      outputCgst += split.cgst;
      outputSgst += split.sgst;
    });

    // Net approved Sales Credit Notes against output tax/taxable value.
    outputTaxable -= creditNoteAgg._sum.taxableValue || 0;
    outputTax -= creditNoteAgg._sum.taxAmount || 0;
    outputIgst -= creditNoteAgg._sum.igst || 0;
    outputCgst -= creditNoteAgg._sum.cgst || 0;
    outputSgst -= creditNoteAgg._sum.sgst || 0;

    // Net approved Purchase Debit Notes against input tax (ITC reversal).
    const inputCgst = (purchasesAgg._sum.cgst || 0) - (debitNoteAgg._sum.cgst || 0);
    const inputSgst = (purchasesAgg._sum.sgst || 0) - (debitNoteAgg._sum.sgst || 0);
    const inputIgst = (purchasesAgg._sum.igst || 0) - (debitNoteAgg._sum.igst || 0);
    const totalInputTax = inputCgst + inputSgst + inputIgst;
    const netGstPayable = Math.max(0, outputTax - totalInputTax);

    return {
      outwardSupplies: [
        {
          description: 'Outward taxable supplies (other than zero rated, nil rated and exempted)',
          taxableValue: Number(outputTaxable.toFixed(2)),
          igst: Number(outputIgst.toFixed(2)),
          cgst: Number(outputCgst.toFixed(2)),
          sgst: Number(outputSgst.toFixed(2)),
          cess: 0
        }
      ],
      interStateSupplies: outputIgst > 0 ? [
        {
          description: 'Supplies made to Unregistered Persons',
          taxableValue: Number(outputTaxable.toFixed(2)),
          integratedTax: Number(outputIgst.toFixed(2))
        }
      ] : [],
      eligibleITC: {
        available: [
          { description: 'All other ITC', igst: Number(inputIgst.toFixed(2)), cgst: Number(inputCgst.toFixed(2)), sgst: Number(inputSgst.toFixed(2)), cess: 0 }
        ],
        ineligible: []
      },
      exemptSupplies: [],
      summary: {
        totalOutputTax: Number(outputTax.toFixed(2)),
        totalInputTax: Number(totalInputTax.toFixed(2)),
        netGstPayable: Number(netGstPayable.toFixed(2))
      }
    };
  }

  static async getGSTR9Data(franchiseIdOrFilters?: any, financialYearParam?: string) {
    const franchiseId = typeof franchiseIdOrFilters === 'string' ? franchiseIdOrFilters : (franchiseIdOrFilters?.franchiseId);
    const financialYear = typeof franchiseIdOrFilters === 'object' && franchiseIdOrFilters?.financialYear ? franchiseIdOrFilters.financialYear : financialYearParam;
    // The frontend always sends an explicit FY now; this fallback only
    // covers a caller that genuinely omits it, derived from today's date
    // (April-start FY) rather than a stale hardcoded year.
    const fy = financialYear || (() => {
      const now = new Date();
      const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      return `${y}-${y + 1}`;
    })();
    const [startYearStr] = fy.split('-');
    const startYear = parseInt(startYearStr, 10);
    const fyStart = new Date(startYear, 3, 1);
    const fyEnd = new Date(startYear + 1, 2, 31, 23, 59, 59);

    const franchise = franchiseId
      ? await prisma.franchise.findUnique({ where: { id: franchiseId } })
      : null;

    const [orders, purchasesAgg, creditNoteAgg, debitNoteAgg] = await Promise.all([
      prisma.order.findMany({
        where: finalSaleWhere({ ...(franchiseId ? { franchiseId } : {}), createdAt: { gte: fyStart, lte: fyEnd } }),
        select: { subTotal: true, taxAmount: true, stateOfSupply: true, franchise: { select: { location: true } } }
      }),
      prisma.vendorInvoice.aggregate({
        where: {
          procurementOrder: { ...(franchiseId ? { franchiseId } : {}), status: { not: 'CANCELLED' as any } },
          createdAt: { gte: fyStart, lte: fyEnd }
        },
        _sum: { subtotal: true, cgst: true, sgst: true, igst: true }
      }),
      prisma.returnOrder.aggregate({
        where: { status: { in: ['APPROVED', 'COMPLETED'] }, taxAmount: { not: null }, ...(franchiseId ? { franchiseId } : {}), createdAt: { gte: fyStart, lte: fyEnd } },
        _sum: { taxableValue: true, cgst: true, sgst: true, igst: true, taxAmount: true }
      }),
      prisma.purchaseReturn.aggregate({
        where: { status: { in: ['APPROVED', 'COMPLETED'] }, taxAmount: { not: null }, createdAt: { gte: fyStart, lte: fyEnd } },
        _sum: { taxableValue: true, cgst: true, sgst: true, igst: true, taxAmount: true }
      })
    ]);

    let outputTaxable = 0;
    let outputTax = 0;
    let outputIgst = 0;
    let outputCgst = 0;
    let outputSgst = 0;
    orders.forEach(o => {
      outputTaxable += o.subTotal || 0;
      const t = o.taxAmount || 0;
      outputTax += t;
      const split = splitGstAmount(t, o.stateOfSupply, o.franchise?.location || null);
      outputIgst += split.igst;
      outputCgst += split.cgst;
      outputSgst += split.sgst;
    });

    // Net approved credit/debit notes into the same annual totals GSTR-1/2/3B use.
    outputTaxable -= creditNoteAgg._sum.taxableValue || 0;
    outputTax -= creditNoteAgg._sum.taxAmount || 0;
    outputIgst -= creditNoteAgg._sum.igst || 0;
    outputCgst -= creditNoteAgg._sum.cgst || 0;
    outputSgst -= creditNoteAgg._sum.sgst || 0;

    const inputCgstNet = (purchasesAgg._sum.cgst || 0) - (debitNoteAgg._sum.cgst || 0);
    const inputSgstNet = (purchasesAgg._sum.sgst || 0) - (debitNoteAgg._sum.sgst || 0);
    const inputIgstNet = (purchasesAgg._sum.igst || 0) - (debitNoteAgg._sum.igst || 0);
    const inputTax = inputCgstNet + inputSgstNet + inputIgstNet;

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
          taxableValue: Number(outputTaxable.toFixed(2)),
          centralTax: Number(outputCgst.toFixed(2)),
          stateTax: Number(outputSgst.toFixed(2)),
          integratedTax: Number(outputIgst.toFixed(2)),
          cess: 0
        },
        {
          section: '4C',
          description: 'Inward supplies liable to reverse charge',
          taxableValue: (purchasesAgg._sum.subtotal || 0) - (debitNoteAgg._sum.taxableValue || 0),
          centralTax: Number(inputCgstNet.toFixed(2)),
          stateTax: Number(inputSgstNet.toFixed(2)),
          integratedTax: Number(inputIgstNet.toFixed(2)),
          cess: 0
        }
      ],
      summary: {
        totalOutputTax: Number(outputTax.toFixed(2)),
        totalInputTax: Number(inputTax.toFixed(2)),
        netTaxPayable: Number(Math.max(0, outputTax - inputTax).toFixed(2))
      }
    };
  }

  static async getHsnSummaryData(franchiseIdOrFilters?: any, startDateParam?: string | Date, endDateParam?: string | Date) {
    const { franchiseId, startDate, endDate, extra } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};
    const partyId = extra?.partyId;
    const gstRate = extra?.gstRate !== undefined && extra?.gstRate !== '' ? Number(extra.gstRate) : undefined;

    const orders = await prisma.order.findMany({
      where: finalSaleWhere({
        ...(franchiseId ? { franchiseId } : {}),
        ...(partyId ? { customerId: partyId } : {}),
        // Goods only — service lines belong to the SAC report, never HSN.
        orderItems: { some: { product: { productType: { not: 'SERVICE' } } } },
        ...dateFilter
      }),
      include: {
        orderItems: { include: { product: true } },
        franchise: { select: { location: true } }
      }
    });

    const hsnMap: Record<string, {
      hsn: string; productName: string; unit: string; gstRate: number; quantity: number;
      totalValue: number; taxableValue: number;
      igstAmount: number; cgstAmount: number; sgstAmount: number;
    }> = {};

    orders.forEach(o => {
      const orderSubTotal = o.subTotal || 0;
      const orderTax = o.taxAmount || 0;
      const franchiseLocation = o.franchise?.location || null;

      o.orderItems.forEach(item => {
        // Service lines never appear in the goods (HSN) summary, even on an
        // order that also has goods lines.
        if (item.product?.productType === 'SERVICE') return;

        const hsn = item.product?.hsnCode || 'NA';
        const key = `${hsn}|${item.product?.id || 'unknown'}|${item.unit || 'UNIT'}`;
        if (!hsnMap[key]) {
          hsnMap[key] = {
            hsn,
            productName: item.product?.name || 'Unknown Product',
            unit: item.unit || 'UNIT',
            gstRate: item.product?.taxPercent || 0,
            quantity: 0,
            totalValue: 0,
            taxableValue: 0,
            igstAmount: 0,
            cgstAmount: 0,
            sgstAmount: 0
          };
        }

        const lineSubtotal = (item.quantity || 0) * (item.price || 0);
        const discountRatio = orderSubTotal > 0 ? (lineSubtotal / orderSubTotal) : 0;
        const lineDiscount = (o.discountAmount || 0) * discountRatio;
        const lineTaxable = Math.max(0, lineSubtotal - lineDiscount);

        let lineTax = 0;
        if (typeof item.taxAmount === 'number' && item.taxAmount > 0) {
          lineTax = item.taxAmount;
        } else if (orderSubTotal > 0) {
          lineTax = (lineTaxable / orderSubTotal) * orderTax;
        }

        const split = splitGstAmount(lineTax, o.stateOfSupply, franchiseLocation);

        hsnMap[key].quantity += item.quantity || 0;
        hsnMap[key].taxableValue += lineTaxable;
        hsnMap[key].igstAmount += split.igst;
        hsnMap[key].cgstAmount += split.cgst;
        hsnMap[key].sgstAmount += split.sgst;
        hsnMap[key].totalValue += (item.totalAmount || (lineTaxable + lineTax));
      });
    });

    let rows = Object.values(hsnMap);
    if (gstRate !== undefined && !Number.isNaN(gstRate)) {
      rows = rows.filter((r) => r.gstRate === gstRate);
    }

    return rows.map(h => ({
      hsn: h.hsn,
      productName: h.productName,
      unit: h.unit,
      quantity: Number(h.quantity.toFixed(3)),
      gstRate: h.gstRate,
      totalValue: Number(h.totalValue.toFixed(2)),
      taxableValue: Number(h.taxableValue.toFixed(2)),
      igstAmount: Number(h.igstAmount.toFixed(2)),
      cgstAmount: Number(h.cgstAmount.toFixed(2)),
      sgstAmount: Number(h.sgstAmount.toFixed(2)),
      addCess: null
    }));
  }

  static async getSaleSummaryByHSNData(franchiseIdOrFilters?: any, startDateParam?: string | Date, endDateParam?: string | Date) {
    return this.getHsnSummaryData(franchiseIdOrFilters, startDateParam, endDateParam);
  }

  // Services sold through the normal sales flow (Product.productType ===
  // 'SERVICE', with a sacCode), grouped by SAC — replaces the old
  // Expense-category-as-fake-SAC version, which never matched a real
  // service sale and never computed any GST. Correctly returns [] until
  // real service products exist and are sold.
  static async getSacReportData(franchiseIdOrFilters?: any, startDateParam?: string | Date, endDateParam?: string | Date) {
    const { franchiseId, startDate, endDate, extra } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const dateFilter = buildCreatedAtFilter(startDate, endDate);
    const partyId = extra?.partyId;
    const gstRate = extra?.gstRate !== undefined && extra?.gstRate !== '' ? Number(extra.gstRate) : undefined;

    const orders = await prisma.order.findMany({
      where: finalSaleWhere({
        ...(franchiseId ? { franchiseId } : {}),
        ...(partyId ? { customerId: partyId } : {}),
        orderItems: { some: { product: { productType: 'SERVICE' } } },
        ...dateFilter
      }),
      include: { orderItems: { include: { product: true } }, franchise: { select: { location: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const sacMap: Record<string, {
      sacCode: string; serviceName: string; taxableValue: number; gstRate: number;
      cgst: number; sgst: number; igst: number; totalTax: number;
    }> = {};

    orders.forEach(o => {
      const orderSubTotal = o.subTotal || 0;
      const orderTax = o.taxAmount || 0;

      o.orderItems.forEach(item => {
        if (item.product?.productType !== 'SERVICE') return;

        const sac = item.product?.sacCode || 'NA';
        const key = `${sac}|${item.product?.id}`;
        if (!sacMap[key]) {
          sacMap[key] = { sacCode: sac, serviceName: item.product?.name || 'Service', taxableValue: 0, gstRate: item.product?.taxPercent || 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
        }

        const lineSubtotal = (item.quantity || 0) * (item.price || 0);
        const lineTax = typeof item.taxAmount === 'number' && item.taxAmount > 0
          ? item.taxAmount
          : (orderSubTotal > 0 ? (lineSubtotal / orderSubTotal) * orderTax : 0);
        const split = splitGstAmount(lineTax, o.stateOfSupply, o.franchise?.location || null);

        sacMap[key].taxableValue += lineSubtotal;
        sacMap[key].cgst += split.cgst;
        sacMap[key].sgst += split.sgst;
        sacMap[key].igst += split.igst;
        sacMap[key].totalTax += lineTax;
      });
    });

    let rows = Object.values(sacMap);
    if (gstRate !== undefined && !Number.isNaN(gstRate)) {
      rows = rows.filter((r) => r.gstRate === gstRate);
    }

    return rows.map(r => ({
      sacCode: r.sacCode,
      serviceName: r.serviceName,
      taxableValue: Number(r.taxableValue.toFixed(2)),
      gstRate: r.gstRate,
      cgst: Number(r.cgst.toFixed(2)),
      sgst: Number(r.sgst.toFixed(2)),
      igst: Number(r.igst.toFixed(2)),
      totalTax: Number(r.totalTax.toFixed(2))
    }));
  }

  static async getItemDiscountReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const orders = await prisma.order.findMany({
      where: { ...(franchiseId ? { franchiseId } : {}), discountAmount: { gt: 0 }, status: 'COMPLETED', ...dateFilter },
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

  static async getSalePurchaseByCategoryData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), status: 'COMPLETED', ...dateFilter },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: { ...(franchiseId ? { franchiseId } : {}), status: { not: 'CANCELLED' as any }, ...dateFilter },
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

  static async getStockByCategoryData(franchiseId?: string) {
    const items = await prisma.inventoryItem.findMany({
      where: { ...(franchiseId ? { franchiseId } : {}), isActive: true },
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

  static async getExpensesReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string, categoryParam?: string) {
    const { franchiseId, startDate, endDate, category } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam, categoryParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const where: any = {
      ...(franchiseId ? { franchiseId } : {}),
      isCancelled: false
    };
    if (start || end) {
      where.date = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
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

  static async getExpenseCategoryReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    return this.getExpensesReportData(franchiseIdOrFilters, startDateParam, endDateParam);
  }

  static async getExpenseItemReportData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string, categoryParam?: string) {
    return this.getExpensesReportData(franchiseIdOrFilters, startDateParam, endDateParam, categoryParam);
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

  /**
   * Receivables side of getAllPartiesData (CUSTOMER/DEALER/FRANCHISE) — real
   * outstanding balance summed per party from actual Tax Invoices (Order+
   * Invoice+Payment), NOT CustomerLedger. Deliberately not ledger-sourced:
   * POSService.checkout and the fixed FinanceService.createInvoice never
   * reliably post SALE/PAYMENT ledger entries for every flow (see
   * CustomerService.getOutstandingBalances, which this generalizes to
   * DEALER/FRANCHISE using the same partyType/partyId fields
   * DealerService.getTransactions already keys off).
   *
   * Per-order outstanding = order.totalAmount − Σ(non-cancelled
   * Payment.paidAmount for that order/invoice). Orders with no resolvable
   * real party (Walk-in: partyType CUSTOMER with no customerId, or a
   * Dealer/Franchise sale with no partyId) are excluded — there is no real
   * debtor identity to attach that balance to, and lumping every Walk-in
   * sale into one shared fake "Walk-in Customer" bucket would mix unrelated
   * people's debts. In practice this exclusion is close to a no-op: POS
   * checkout (the only flow that creates Walk-in orders) always writes
   * paymentStatus: 'PAID', so a real unpaid Walk-in balance should not occur
   * — see PosService.checkout.
   */
  private static async getPartyReceivables(params: {
    franchiseId?: string;
    dateFilter: any;
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
  }): Promise<Array<{ id: string; partyType: string; name: string; email: string | null; phone: string | null; currentBalance: number; creditLimit: number | null }>> {
    const { franchiseId, dateFilter, partyType } = params;

    const orders = await prisma.order.findMany({
      where: {
        status: { not: 'CANCELLED' },
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter
      },
      select: {
        partyType: true,
        partyId: true,
        customerId: true,
        totalAmount: true,
        payments: { select: { paidAmount: true, isCancelled: true, status: true } }
      }
    });

    // key = `${partyType}:${partyId}`
    const balances = new Map<string, number>();
    for (const o of orders) {
      const resolvedType = o.partyType || 'CUSTOMER';
      const resolvedId = resolvedType === 'CUSTOMER' ? o.customerId : o.partyId;
      if (!resolvedId) continue; // No real master-table row for this party (Walk-in etc) — not trackable.
      if (partyType && resolvedType !== partyType) continue;

      const paid = o.payments
        .filter((p) => !p.isCancelled && p.status !== 'CANCELLED')
        .reduce((sum, p) => sum + (p.paidAmount || 0), 0);
      const due = (o.totalAmount || 0) - paid;
      if (due <= 0.01) continue; // Fully-paid (or overpaid, which the createPayment guard should prevent) — nothing outstanding.

      const key = `${resolvedType}:${resolvedId}`;
      balances.set(key, (balances.get(key) || 0) + due);
    }

    if (balances.size === 0) return [];

    const customerIds: string[] = [];
    const dealerIds: string[] = [];
    const franchiseIds: string[] = [];
    for (const key of balances.keys()) {
      const [pt, id] = key.split(':');
      if (pt === 'CUSTOMER') customerIds.push(id);
      else if (pt === 'DEALER') dealerIds.push(id);
      else if (pt === 'FRANCHISE') franchiseIds.push(id);
    }

    // Empty `in: []` simply returns no rows in Prisma — always issuing all
    // three queries (instead of conditionally skipping empty id lists) keeps
    // the return types uniform, which is what lets TS infer the Map
    // constructions below correctly.
    const [customers, dealers, franchises] = await Promise.all([
      prisma.customer.findMany({ where: { id: { in: customerIds } } }),
      prisma.dealer.findMany({ where: { id: { in: dealerIds } } }),
      prisma.franchise.findMany({ where: { id: { in: franchiseIds } } })
    ]);
    const customerMap = new Map(customers.map((c) => [c.id, c] as const));
    const dealerMap = new Map(dealers.map((d) => [d.id, d] as const));
    const franchiseMap = new Map(franchises.map((f) => [f.id, f] as const));

    const rows: Array<{ id: string; partyType: string; name: string; email: string | null; phone: string | null; currentBalance: number; creditLimit: number | null }> = [];
    for (const [key, balance] of balances.entries()) {
      const [pt, id] = key.split(':');
      if (pt === 'CUSTOMER') {
        const c = customerMap.get(id);
        if (!c) continue; // Customer record no longer exists — skip rather than show an orphaned row.
        rows.push({ id, partyType: pt, name: c.name, email: c.email, phone: c.phone, currentBalance: Number(balance.toFixed(2)), creditLimit: c.creditLimit ?? null });
      } else if (pt === 'DEALER') {
        const d = dealerMap.get(id);
        if (!d) continue;
        // Dealer has no creditLimit column in the schema — return null rather
        // than fabricating a value (Customer/Franchise both have a real one).
        rows.push({ id, partyType: pt, name: d.name, email: d.email, phone: d.phone, currentBalance: Number(balance.toFixed(2)), creditLimit: null });
      } else if (pt === 'FRANCHISE') {
        const f = franchiseMap.get(id);
        if (!f) continue;
        rows.push({ id, partyType: pt, name: f.name, email: null, phone: f.contactNum, currentBalance: Number(balance.toFixed(2)), creditLimit: f.creditLimit ?? null });
      }
    }

    return rows;
  }

  /**
   * Receivables drill-down: every individual invoice (Order+Payment) for one
   * CUSTOMER/DEALER/FRANCHISE party, not just the aggregate getPartyReceivables
   * returns. Same outstanding-balance formula (order.totalAmount − Σ
   * non-cancelled Payment.paidAmount) applied per-order instead of summed
   * across orders, so a paid-off invoice and a still-outstanding one for the
   * same party are both visible with their own status. Each invoice also
   * carries its full payment history (including cancelled payments, flagged
   * via isCancelled, for traceability) — paymentNumber/date/method/account
   * are all real Payment/Account fields, never a raw id. Read-only —
   * touches no Payment/Order rows.
   */
  static async getPartyInvoices(params: {
    franchiseId?: string;
    partyType: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId: string;
  }) {
    const { franchiseId, partyType, partyId } = params;
    const idFilter = partyType === 'CUSTOMER'
      ? { customerId: partyId }
      : { partyId, partyType: partyType as any };

    const orders = await prisma.order.findMany({
      where: {
        status: { not: 'CANCELLED' },
        ...(franchiseId ? { franchiseId } : {}),
        ...idFilter
      },
      include: {
        payments: { include: { account: true }, orderBy: { createdAt: 'asc' } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return orders.map((o) => {
      const validPayments = o.payments.filter((p) => !p.isCancelled && p.status !== 'CANCELLED');
      const paid = Number(validPayments.reduce((sum, p) => sum + (p.paidAmount || 0), 0).toFixed(2));
      const rawBalance = Number(((o.totalAmount || 0) - paid).toFixed(2));
      const balance = rawBalance < 0 ? 0 : rawBalance;
      const status: 'PAID' | 'PARTIAL' | 'UNPAID' = balance <= 0.01 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID');

      return {
        orderId: o.id, // Internal key only — never render this in the UI, render invoiceNumber instead.
        invoiceNumber: o.invoiceNum,
        createdAt: o.createdAt,
        invoiceTotal: o.totalAmount,
        paidAmount: paid,
        balance,
        status,
        payments: o.payments.map((p) => ({
          paymentNumber: p.paymentNumber || '—',
          date: p.createdAt,
          method: p.paymentMode,
          account: p.account?.name || 'Unknown',
          amount: p.paidAmount,
          isCancelled: p.isCancelled,
          status: p.status
        }))
      };
    });
  }

  static async getAllPartiesData(
    franchiseId?: string,
    startDate?: string,
    endDate?: string,
    opts?: { partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE' | 'ALL'; search?: string; datasetType?: 'RECEIVABLE' | 'PAYABLE' }
  ) {
    const dateFilter: any = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {
        ...(startDate ? { gte: new Date(startDate) } : {}),
        ...(endDate ? { lte: new Date(endDate) } : {})
      };
    }

    const requestedPartyType = opts?.partyType && opts.partyType !== 'ALL' ? opts.partyType : undefined;

    // datasetType is an explicit, required-in-practice partition between the
    // Receivables view (CUSTOMER/DEALER/FRANCHISE only — Vendor must NEVER
    // appear here, even under "All Party Types") and the Payables view
    // (VENDOR only). This is a query-layer constraint, not a downstream
    // balance-sign heuristic: previously "All Party Types" on the
    // Receivables page sent no partyType at all, which fell through to the
    // same "give me everything" default the generic Reports > All Parties
    // page relies on — so a Vendor with a positive ledger balance leaked
    // into the Receivables table. Reports > All Parties (the only caller
    // that omits datasetType) still gets the original combined
    // customers+vendors dataset, unchanged.
    const includeReceivables = opts?.datasetType !== 'PAYABLE';
    const includeVendors = opts?.datasetType !== 'RECEIVABLE' && !requestedPartyType;

    const [receivableRows, vendors] = await Promise.all([
      includeReceivables
        ? this.getPartyReceivables({ franchiseId, dateFilter, partyType: requestedPartyType })
        : Promise.resolve([]),
      includeVendors
        ? prisma.vendor.findMany({ include: { ledgerEntries: { where: dateFilter } } })
        : Promise.resolve([])
    ]);

    const parties: any[] = receivableRows.map((r) => ({
      id: r.id,
      partyType: r.partyType,
      name: r.name,
      email: r.email,
      phone: r.phone,
      currentBalance: r.currentBalance,
      creditLimit: r.creditLimit
    }));

    vendors.forEach((v: any) => {
      const currentBalance = v.ledgerEntries.reduce((sum: number, entry: any) => {
        if (entry.type === 'CREDIT') return sum - entry.amount;
        if (entry.type === 'DEBIT') return sum + entry.amount;
        return sum;
      }, 0);

      parties.push({
        id: v.id,
        partyType: 'VENDOR',
        name: v.name,
        email: v.email,
        phone: v.contact,
        currentBalance,
        creditLimit: v.creditLimit
      });
    });

    const search = opts?.search?.trim().toLowerCase();
    const filtered = search
      ? parties.filter((p) =>
          (p.name || '').toLowerCase().includes(search) ||
          (p.phone || '').toLowerCase().includes(search) ||
          (p.email || '').toLowerCase().includes(search)
        )
      : parties;

    return filtered.sort((a, b) => a.name.localeCompare(b.name));
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

  static async getStockSummaryByItemData(franchiseId?: string) {
    const items = await prisma.inventoryItem.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        isActive: true
      },
      orderBy: { name: 'asc' }
    });

    return items.map(item => {
      const currentStock = item.currentStock || 0;
      const costPrice = item.costPrice || 0;
      const sellingPrice = item.customerPrice || item.basePrice || 0;
      const stockValue = Number((currentStock * costPrice).toFixed(2));
      const potentialRetailValue = Number((currentStock * sellingPrice).toFixed(2));
      const potentialMargin = Number((potentialRetailValue - stockValue).toFixed(2));

      return {
        id: item.id,
        name: item.name,
        sku: item.sku,
        category: item.category,
        unit: item.unit,
        currentStock,
        minStockLevel: item.minimumStock || 0,
        costPrice,
        sellingPrice,
        stockValue,
        potentialRetailValue,
        potentialMargin,
        status: currentStock <= (item.minimumStock || 0) ? 'LOW_STOCK' : 'ADEQUATE'
      };
    });
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

  static async getInventoryLedgerReportData(
    franchiseId?: string,
    itemId?: string,
    startDate?: string | Date,
    endDate?: string | Date,
    page?: number,
    pageSize?: number
  ) {
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

    const total = await prisma.stockMovement.count({ where });

    const movements = await prisma.stockMovement.findMany({
      where,
      include: {
        item: { select: { id: true, name: true, sku: true, unit: true, category: true, costPrice: true, currentStock: true } },
        warehouse: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' },
      ...(page && pageSize ? {
        skip: (page - 1) * pageSize,
        take: pageSize
      } : {})
    });

    const data = movements.map(m => {
      const unitCost = m.item?.costPrice || 0;
      const qtyIn = m.quantity > 0 ? m.quantity : 0;
      const qtyOut = m.quantity < 0 ? Math.abs(m.quantity) : 0;
      const totalCostIn = Number((qtyIn * unitCost).toFixed(2));
      const totalCostOut = Number((qtyOut * unitCost).toFixed(2));
      const valuationImpact = Number((m.quantity * unitCost).toFixed(2));
      const runningStock = m.item?.currentStock || 0;
      const runningStockValue = Number((runningStock * unitCost).toFixed(2));

      return {
        id: m.id,
        date: m.createdAt,
        itemName: m.item?.name || 'Unknown',
        sku: m.item?.sku,
        category: m.item?.category,
        movementType: m.movementType,
        quantity: m.quantity,
        quantityIn: qtyIn,
        quantityOut: qtyOut,
        baseQty: m.baseQty,
        unit: m.item?.unit,
        unitCost: Number(unitCost.toFixed(2)),
        totalCostIn,
        totalCostOut,
        valuationImpact,
        runningStock,
        runningStockValue,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        batchNumber: m.referenceId || '—',
        note: m.note,
        warehouseName: m.warehouse?.name || 'Central',
        performedBy: m.createdBy || 'System'
      };
    });

    if (page && pageSize) {
      return {
        data,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize)
      };
    }

    return data;
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

    const franchise = filters.franchiseId
      ? await prisma.franchise.findUnique({ where: { id: filters.franchiseId }, select: { location: true } })
      : null;
    const franchiseLocation = franchise?.location || null;

    const orders = await prisma.order.findMany({
      where,
      include: {
        customer: true,
        orderItems: { include: { product: true } },
        payments: true
      },
      orderBy: { createdAt: 'desc' }
    });

    let totalSubTotal = 0;
    let totalDiscount = 0;
    let totalTaxableValue = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    let totalTax = 0;
    let totalRevenue = 0;
    let totalPaid = 0;

    const mappedOrders = orders.map((o: any) => {
      const subTotal = o.subTotal || 0;
      const discountAmount = o.discountAmount || 0;
      const taxableValue = Math.max(0, subTotal - discountAmount);
      const taxAmount = o.taxAmount || 0;
      const split = splitGstAmount(taxAmount, o.stateOfSupply, franchiseLocation);
      const grandTotal = o.totalAmount || (taxableValue + taxAmount);
      const paid = o.paymentStatus === 'PAID'
        ? grandTotal
        : (o.payments ? o.payments.reduce((ps: number, p: any) => ps + (p.paidAmount || 0), 0) : 0);

      totalSubTotal += subTotal;
      totalDiscount += discountAmount;
      totalTaxableValue += taxableValue;
      totalCgst += split.cgst;
      totalSgst += split.sgst;
      totalIgst += split.igst;
      totalTax += taxAmount;
      totalRevenue += grandTotal;
      totalPaid += paid;

      return {
        id: o.id,
        orderNumber: o.invoiceNum || o.id,
        createdAt: o.createdAt,
        customerName: o.customer?.name || 'Walk-in Customer',
        customerPhone: o.customer?.phone || '—',
        customerGstin: o.customer?.gstNumber || '—',
        stateOfSupply: o.stateOfSupply || '—',
        status: o.status,
        paymentStatus: o.paymentStatus || 'PAID',
        paymentMode: o.paymentType || 'CASH',
        subTotal: Number(subTotal.toFixed(2)),
        discountAmount: Number(discountAmount.toFixed(2)),
        taxableValue: Number(taxableValue.toFixed(2)),
        cgst: Number(split.cgst.toFixed(2)),
        sgst: Number(split.sgst.toFixed(2)),
        igst: Number(split.igst.toFixed(2)),
        cess: 0,
        taxAmount: Number(taxAmount.toFixed(2)),
        totalAmount: Number(grandTotal.toFixed(2)),
        paidAmount: Number(paid.toFixed(2)),
        balanceAmount: Number(Math.max(0, grandTotal - paid).toFixed(2))
      };
    });

    return {
      summary: {
        totalOrders: orders.length,
        totalSubTotal: Number(totalSubTotal.toFixed(2)),
        totalDiscount: Number(totalDiscount.toFixed(2)),
        totalTaxableValue: Number(totalTaxableValue.toFixed(2)),
        totalCgst: Number(totalCgst.toFixed(2)),
        totalSgst: Number(totalSgst.toFixed(2)),
        totalIgst: Number(totalIgst.toFixed(2)),
        totalTax: Number(totalTax.toFixed(2)),
        totalRevenue: Number(totalRevenue.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalPending: Number(Math.max(0, totalRevenue - totalPaid).toFixed(2))
      },
      orders: mappedOrders,
      data: mappedOrders
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

  static async getSaleOrderItemReportData(filters: any) {
    return this.getSaleOrderItemsReportData(filters || {});
  }

  static async getLoanStatementData(filters: any) {
    return this.getLoanStatement(filters || {});
  }

  static async getTDSReceivableData(franchiseId?: any, startDate?: any, endDate?: any) {
    return this.getTdsReceivableData(franchiseId, startDate, endDate);
  }

  static async getTrialBalance(filters: any) {
    return this.getTrialBalanceReport(filters || {});
  }

  static async getSACReportData(a?: any, b?: any, c?: any) {
    return this.getSacReportData(a, b, c);
  }

  static async getGSTReportData(a?: any, b?: any, c?: any) {
    return this.getGstReportData(a, b, c);
  }

  static async getGSTRateReportData(a?: any, b?: any, c?: any) {
    return this.getGstRateReportData(a, b, c);
  }

  static async getForm27EQData(a?: any, b?: any, c?: any) {
    return this.getForm27eqData(a, b, c);
  }

  static async getTCSReceivableData(a?: any, b?: any, c?: any) {
    return this.getTcsReceivableData(a, b, c);
  }

  static async getTDSPayableData(a?: any, b?: any, c?: any) {
    return this.getTdsPayableData(a, b, c);
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

