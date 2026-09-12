function formatReferenceType(ref: string): string {
  if (!ref) return '—';
  return ref.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
import prisma from '../../lib/prisma';
import SocketService from '../../lib/socket';
import { AccountService } from './account.service';
import { POSService } from '../pos/pos.service';
import { FranchiseService } from '../franchise/franchise.service';
import { ItemCategory, PaymentMode, LedgerType, FranchiseLedgerRefType } from '@prisma/client';
import { PaymentValidationError } from '../../utils/errors';
import { splitGstAmount, computeGstUtilization, resolveSellerStatesFor } from '../../utils/gst-tax.util';


function parseInclusiveDates(startDate?: string | Date, endDate?: string | Date): { start?: Date; end?: Date } {
  let start: Date | undefined = undefined;
  let end: Date | undefined = undefined;
  if (startDate) {
    start = new Date(startDate);
  }
  if (endDate) {
    end = new Date(endDate);
    // A bare "YYYY-MM-DD" (what every <input type="date"> sends) always
    // parses as UTC midnight, per spec, regardless of server timezone.
    // This must use the UTC accessors, not the local ones: on a server
    // whose local timezone isn't UTC (this one runs in Asia/Calcutta,
    // UTC+5:30), end.getHours() reads back 5, never 0, so the bump below
    // silently never fired — `end` stayed pinned at UTC midnight (5:30 AM
    // IST) instead of end-of-day, cutting every report's "today" filter
    // off a few hours after it started and hiding the rest of the day's
    // real transactions (confirmed against INV-2026-00001..00008, all
    // created well after UTC midnight on their own calendar day).
    if (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0) {
      end.setUTCHours(23, 59, 59, 999);
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

// VendorInvoice (Purchase Bill) date filter, for GST reporting purposes.
// A Purchase Bill's real GST/reporting date is its own `billDate` — the
// date the bill actually carries — not `createdAt` (when the DB row
// happened to be inserted, which can be a different day than the bill's
// own date, e.g. a bill entered a day late). Falls back to `createdAt`
// only for the rare row where `billDate` was never set, mirroring the
// same fallback already used when displaying a bill's date
// (`inv.billDate || inv.createdAt`) — filtering must agree with display.
function buildBillDateFilter(startDate?: string | Date, endDate?: string | Date): any {
  if (!startDate && !endDate) return {};
  const { start, end } = parseInclusiveDates(startDate, endDate);
  const range: { gte?: Date; lte?: Date } = {};
  if (start) range.gte = start;
  if (end) range.lte = end;
  return {
    OR: [
      { billDate: range },
      { billDate: null, createdAt: range }
    ]
  };
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
  static async createInvoiceFromOrder(orderId: string, externalTx?: any) {
    const run = async (tx: any) => {
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
    };

    return externalTx ? run(externalTx) : prisma.$transaction(run);
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

    // 2. Purchases — the actually recognized liability (VendorInvoice),
    // whose amount/cgst/sgst/igst are derived from the GRN's actual price
    // via VendorInvoiceService.computeCommercialsFromPO + recognizeLiability
    // — not ProcurementOrder.totalAmount, which is only ever the PO's
    // ordered commitment and never reflects a GRN price override. Same
    // vendorInvoice-aggregate + buildBillDateFilter pattern already used by
    // GSTR-2/GSTR-3B/GSTR-9 for the identical reason (see those below), so
    // this report now agrees with GST reporting on what "Purchase" means.
    // A PO with no VendorInvoice yet (never received/billed) correctly
    // contributes ₹0 here, instead of counting its full ordered value as an
    // already-incurred purchase.
    const purchaseAggregate = await prisma.vendorInvoice.aggregate({
      where: {
        procurementOrder: { franchiseId: filters.franchiseId, status: { not: 'CANCELLED' } },
        ...buildBillDateFilter(filters.startDate, filters.endDate)
      },
      _sum: { amount: true, cgst: true, sgst: true, igst: true }
    });
    const totalPurchases = purchaseAggregate._sum.amount || 0;
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

  static async getInvoices(filters?: { franchiseId?: string; startDate?: string; endDate?: string; search?: string; status?: string } | string) {
    const opts = typeof filters === 'string' ? { franchiseId: filters } : (filters || {});
    const where: any = {};
    if (opts.franchiseId) {
      where.order = { franchiseId: opts.franchiseId };
    }
    if (opts.startDate || opts.endDate) {
      where.createdAt = {};
      if (opts.startDate) where.createdAt.gte = new Date(opts.startDate);
      if (opts.endDate) {
        const end = new Date(opts.endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }
    if (opts.status && opts.status !== 'ALL') {
      where.status = opts.status;
    }
    if (opts.search) {
      where.OR = [
        { order: { invoiceNum: { contains: opts.search, mode: 'insensitive' } } },
        { order: { customerName: { contains: opts.search, mode: 'insensitive' } } },
        { order: { customer: { name: { contains: opts.search, mode: 'insensitive' } } } },
      ];
    }

    const invoices = await prisma.invoice.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      include: {
        order: {
          include: {
            customer: true,
            franchise: true,
            orderItems: {
              include: {
                product: true
              }
            }
          }
        },
        payments: true,
        allocations: { include: { payment: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    return invoices.map((inv) => this.mergeAllocationsIntoPayments(inv));
  }

  static async getInvoiceById(id: string) {
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [
          { id },
          { orderId: id }
        ]
      },
      include: {
        order: {
          include: {
            customer: true,
            franchise: true,
            orderItems: {
              include: {
                product: true
              }
            }
          }
        },
        payments: true,
        allocations: { include: { payment: true } }
      }
    });
    return this.mergeAllocationsIntoPayments(invoice);
  }

  // A multi-invoice receipt attributes its per-invoice share via
  // PaymentAllocation rather than Payment.invoiceId (see
  // FinanceService.createPayment), so `Invoice.payments` alone misses that
  // money. Every consumer of an Invoice's payment history (Payment-In's own
  // outstanding calc, the Tax Invoice detail view) reads `invoice.payments`
  // — normalizing here means none of them need to know PaymentAllocation
  // exists at all.
  private static mergeAllocationsIntoPayments(invoice: any): any {
    if (!invoice) return invoice;
    const allocationPayments = (invoice.allocations || [])
      .filter((a: any) => a.payment?.invoiceId !== invoice.id)
      .map((a: any) => ({
        id: a.payment?.id,
        paidAmount: a.amount,
        status: a.payment?.status,
        isCancelled: a.payment?.isCancelled,
        createdAt: a.payment?.createdAt,
        paymentMode: a.payment?.paymentMode,
        paymentNumber: a.payment?.paymentNumber,
        accountId: a.payment?.accountId,
        isAllocation: true,
      }));
    return { ...invoice, payments: [...(invoice.payments || []), ...allocationPayments] };
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

  static async cancelInvoice(invoiceId: string, user?: any) {
    return prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new Error("Invoice not found");
      if (invoice.status === "CANCELLED") throw new Error("Invoice is already cancelled");

      const activePayments = await tx.payment.findMany({
        where: { invoiceId, status: "PAID", isCancelled: false }
      });
      // Also block if this invoice received money as part of a multi-invoice
      // receipt (PaymentAllocation) — that money is real and allocated here
      // even though the parent Payment.invoiceId points at no single invoice.
      const activeAllocations = await tx.paymentAllocation.findMany({
        where: { invoiceId, payment: { status: "PAID", isCancelled: false } }
      });
      if (activePayments.length > 0 || activeAllocations.length > 0) {
        throw new Error("Cannot cancel an invoice with active payments. Please cancel payments first.");
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: "CANCELLED" }
      });

      if (invoice.orderId) {
        await tx.order.update({
          where: { id: invoice.orderId },
          data: { status: "CANCELLED", paymentStatus: "CANCELLED" }
        });
      }

      return { success: true, message: "Invoice cancelled successfully" };
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
        // A multi-invoice receipt has orderId=null (it doesn't belong to
        // one order), so the plain `order: { franchiseId }` filter below
        // would silently exclude it from every franchise-scoped query —
        // match via its allocated invoices' orders too.
        ...(franchiseId ? {
          OR: [
            { order: { franchiseId } },
            { allocations: { some: { invoice: { order: { franchiseId } } } } },
          ],
        } : {}),
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
    const dateFilter = buildCreatedAtFilter(startDate, endDate);
    const billDateFilter = buildBillDateFilter(startDate, endDate);

    // Sales: use the same canonical source as GSTR-1 — finalSaleWhere covers
    // both TAX_INVOICE (any non-CANCELLED status) and POS (COMPLETED/REFUNDED).
    const orders = await prisma.order.findMany({
      where: finalSaleWhere({
        ...(franchiseId ? { franchiseId } : {}),
        ...dateFilter
      }),
      select: { subTotal: true, taxAmount: true }
    });

    // Purchases: use VendorInvoice (Purchase Bill) — the canonical source for
    // GSTR-2. A PO/GRN alone never has real GST tax amounts until a bill is
    // raised against it; querying procurementOrder.poItems yields zeros.
    const invoices = await prisma.vendorInvoice.findMany({
      where: {
        procurementOrder: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { not: 'CANCELLED' as any }
        },
        ...billDateFilter
      },
      select: { subtotal: true, cgst: true, sgst: true, igst: true }
    });

    const knownBrackets = [5, 12, 18, 28];
    type RateRow = {
      taxName: string;
      taxPercent: number;
      taxableSaleAmount: number;
      taxIn: number;
      taxablePurchaseAmount: number;
      taxOut: number;
    };
    const rateMap: Record<number, RateRow> = {};
    knownBrackets.forEach(b => {
      rateMap[b] = { taxName: `GST ${b}%`, taxPercent: b, taxableSaleAmount: 0, taxIn: 0, taxablePurchaseAmount: 0, taxOut: 0 };
    });

    const nearestBracket = (rate: number) =>
      knownBrackets.reduce((prev, curr) => (Math.abs(curr - rate) < Math.abs(prev - rate) ? curr : prev), 5);

    // Aggregate sales: derive effective rate from order-level subTotal / taxAmount
    // (the same fields GSTR-1 uses), bucket to nearest standard GST bracket.
    orders.forEach(o => {
      const taxableValue = o.subTotal || 0;
      const taxAmount = o.taxAmount || 0;
      if (taxableValue <= 0) return;
      const effectiveRate = Number(((taxAmount / taxableValue) * 100).toFixed(2));
      const bracket = nearestBracket(effectiveRate);
      if (rateMap[bracket]) {
        rateMap[bracket].taxableSaleAmount += taxableValue;
        rateMap[bracket].taxIn += taxAmount;
      }
    });

    // Aggregate purchases: derive effective rate from VendorInvoice totals
    // (the same fields GSTR-2 uses).
    invoices.forEach(inv => {
      const taxableValue = inv.subtotal || 0;
      const totalTax = (inv.cgst || 0) + (inv.sgst || 0) + (inv.igst || 0);
      if (taxableValue <= 0) return;
      const effectiveRate = Number(((totalTax / taxableValue) * 100).toFixed(2));
      const bracket = nearestBracket(effectiveRate);
      if (rateMap[bracket]) {
        rateMap[bracket].taxablePurchaseAmount += taxableValue;
        rateMap[bracket].taxOut += totalTax;
      }
    });

    // Only return rows that have actual data; suppress empty bracket placeholders.
    const data = Object.values(rateMap)
      .filter(r => r.taxableSaleAmount > 0 || r.taxablePurchaseAmount > 0 || r.taxIn > 0 || r.taxOut > 0)
      .map(r => ({
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

  // NOTE: There is no persisted TDS applicability/section/rate model anywhere in the
  // schema (no TdsConfig, no vendor PAN/threshold tracking, no deduction recorded at
  // payment time). This previously fabricated a "TDS" row for every single
  // ProcurementOrder at a flat, unconditional 1% of subtotal under a hardcoded
  // section 194Q — regardless of whether TDS actually applied to that vendor/order.
  // That produced misleading reports (e.g. TDS Amount > 0 with no real TDS base,
  // every row stamped "194Q"). Until genuine TDS applicability/rate/section data is
  // captured on real transactions, this must return no rows rather than invented ones.
  static async getTdsPayableData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    void franchiseIdOrFilters;
    void startDateParam;
    void endDateParam;
    return { data: [] as any[], totalPurchaseWithTds: 0, totalTds: 0 };
  }

  // NOTE: Same issue as getTdsPayableData above — this previously fabricated a "TDS"
  // row for every single completed Order at a flat, unconditional 1% of subTotal
  // under a hardcoded section 194Q, with no real TDS applicability/rate data behind
  // it. Returns no rows until genuine TDS tracking exists.
  static async getTdsReceivableData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string) {
    void franchiseIdOrFilters;
    void startDateParam;
    void endDateParam;
    return { data: [] as any[], totalSaleWithTds: 0, totalTds: 0 };
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
  // Total actually paid toward one Invoice, from BOTH sources of truth:
  // a direct single-invoice Payment (Payment.invoiceId) and any
  // PaymentAllocation rows from a multi-invoice receipt that included this
  // invoice. Used everywhere "how much has this invoice collected" is
  // decided (overpayment guard, status recompute, cancel-invoice guard) so
  // an invoice's history is correct regardless of which path it was paid
  // through.
  private static async getInvoicePaidAmount(tx: any, invoiceId: string): Promise<number> {
    const [direct, allocated] = await Promise.all([
      tx.payment.aggregate({
        where: { invoiceId, status: 'PAID', isCancelled: false },
        _sum: { paidAmount: true },
      }),
      tx.paymentAllocation.aggregate({
        where: { 
          invoiceId, 
          payment: { 
            status: 'PAID', 
            isCancelled: false,
            OR: [
              { invoiceId: null },
              { invoiceId: { not: invoiceId } }
            ]
          } 
        },
        _sum: { amount: true },
      }),
    ]);
    return (direct._sum.paidAmount || 0) + (allocated._sum.amount || 0);
  }

  // Report-query counterpart to getInvoicePaidAmount, for the many read
  // paths that already fetch an Order with `payments` included and sum
  // `paidAmount` in memory (Sales Report, Receivables, All Transactions,
  // customer/dealer balances, ...). Those sums silently missed a
  // multi-invoice receipt's share, since that Payment's orderId is null —
  // its money is only visible via `order.invoice.allocations`. Callers pass
  // their own already-loaded `order.payments` plus (optionally)
  // `order.invoice.allocations` — see callers for the required `include`
  // shape — and the SAME validity predicate they already apply to
  // `payments`, so this only adds the missing term and changes no other
  // behavior at any call site.
  private static sumOrderPaidWithAllocations(
    payments: { id?: string; paidAmount: number; isCancelled: boolean; status: string }[] | null | undefined,
    allocations: { amount: number; payment: { id?: string; invoiceId?: string | null; status: string; isCancelled: boolean } }[] | null | undefined,
    isValid: (p: { status: string; isCancelled: boolean }) => boolean
  ): number {
    const directIds = new Set((payments || []).map((p: any) => p.id).filter(Boolean));
    const direct = (payments || [])
      .filter((p) => isValid(p))
      .reduce((s, p) => s + (p.paidAmount || 0), 0);
    const allocated = (allocations || [])
      .filter((a) => {
        if (!isValid(a.payment)) return false;
        // If payment id is available, ensure we don't double count a payment already in the direct list
        if ((a.payment as any).id && directIds.has((a.payment as any).id)) return false;
        // If the payment was created with an explicit invoiceId (legacy single invoice path),
        // its paidAmount is already fully counted in the direct `payments` list.
        if ((a.payment as any).invoiceId) return false;
        return true;
      })
      .reduce((s, a) => s + (a.amount || 0), 0);
    return direct + allocated;
  }

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

    // Multi-invoice receipt support: `data.allocations` is an optional
    // [{invoiceId, amount}] list. A single-entry list behaves EXACTLY like
    // the legacy `data.invoiceId` field (normalized into `singleInvoiceId`
    // below, so every pre-existing single-invoice code path — Payment.
    // invoiceId/orderId, the overpayment guard, the status recompute — is
    // untouched and unaware anything changed). Only 2+ entries take the new
    // PaymentAllocation path, where Payment.invoiceId/orderId are left null
    // because the receipt doesn't belong to one invoice/order.
    const rawAllocations: { invoiceId: string; amount: number }[] | undefined =
      Array.isArray(data.allocations) && data.allocations.length > 0 ? data.allocations : undefined;
    const isMultiInvoice = !!rawAllocations && rawAllocations.length >= 2;
    const singleInvoiceId: string | undefined =
      data.invoiceId || (rawAllocations && rawAllocations.length === 1 ? rawAllocations[0].invoiceId : undefined);

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

      // 2b. Overpayment guard for a TRUE legacy single-invoice call — only
      // when the caller sent `data.invoiceId` directly and no `allocations`
      // field at all. Untouched from before this feature existed: `amount`
      // IS the invoice's paid amount here, there's no separate figure to
      // reconcile it against. Also resolves the Order this Invoice belongs
      // to — Payment.orderId is what franchise-scoped queries
      // (FinanceService.getPayments) key off, so a Payment with invoiceId
      // set but orderId left null would silently vanish from any
      // franchise-filtered Payments list.
      let orderIdForInvoice: string | undefined;
      if (data.invoiceId && !rawAllocations) {
        const invoiceForGuard = await tx.invoice.findUnique({ where: { id: data.invoiceId } });
        if (!invoiceForGuard) throw new Error('Invoice not found.');
        // A cancelled invoice's balance can still read as > 0 (cancelInvoice
        // only permits cancelling an invoice with zero active payments, so
        // nothing here retroactively zeroes finalAmount) — without this
        // check a stale UI or a direct API call could record a real Payment
        // (and CustomerLedger entry, and account balance movement) against
        // a bill that no longer represents a valid sale. Checked before any
        // of Payment/CustomerLedger/account-balance writes below.
        if (invoiceForGuard.status === 'CANCELLED') {
          throw new PaymentValidationError(
            'INVOICE_CANCELLED',
            'Cannot receive payment for a cancelled invoice.'
          );
        }
        orderIdForInvoice = invoiceForGuard.orderId;
        if (flow === 'IN' && status === 'PAID') {
          const alreadyPaid = await this.getInvoicePaidAmount(tx, data.invoiceId);
          const outstanding = invoiceForGuard.finalAmount - alreadyPaid;
          if (amount > outstanding + 0.01) {
            throw new Error(`Invalid payment amount: ₹${amount} exceeds the outstanding balance (₹${outstanding.toFixed(2)}) on this invoice.`);
          }
        }
      }

      // 2c. Allocation-based receipt validation — runs for ANY caller using
      // `allocations`, whether it's a single entry (the new UI's one-invoice
      // case, still normalized into Payment.invoiceId below via
      // singleInvoiceId) or a true multi-invoice (2+) list. Unlike the bare
      // `invoiceId` path above, a caller stating `allocations` is asserting
      // a distinct per-invoice figure that must actually reconcile with the
      // payment amount — never trust it. Every invoice is re-fetched here
      // (inside the transaction) and re-validated: belongs to the same
      // party as this payment's entityId, not cancelled, allocation within
      // [0, outstanding], and the allocations must sum to exactly the
      // payment amount. All of this runs BEFORE the Payment row (and
      // therefore any PaymentAllocation row) is created, so a rejected
      // request writes nothing at all.
      if (rawAllocations && flow === 'IN' && status === 'PAID') {
        const seen = new Set<string>();
        let allocatedTotal = 0;
        for (const alloc of rawAllocations!) {
          const allocAmount = parseFloat(alloc.amount as any);
          if (!alloc.invoiceId || seen.has(alloc.invoiceId)) {
            throw new PaymentValidationError('DUPLICATE_ALLOCATION', 'Each invoice may only be allocated once in a single receipt.');
          }
          seen.add(alloc.invoiceId);
          if (!(allocAmount > 0)) {
            throw new PaymentValidationError('INVALID_ALLOCATION_AMOUNT', 'Each invoice allocation must be a positive amount.');
          }

          const invoiceForGuard = await tx.invoice.findUnique({
            where: { id: alloc.invoiceId },
            include: { order: { select: { customerId: true, partyId: true, partyType: true } } },
          });
          if (!invoiceForGuard) {
            throw new PaymentValidationError('INVOICE_NOT_FOUND', `Invoice ${alloc.invoiceId} not found.`);
          }
          if (invoiceForGuard.status === 'CANCELLED') {
            throw new PaymentValidationError(
              'INVOICE_CANCELLED',
              'Cannot receive payment for a cancelled invoice.'
            );
          }
          // Cross-customer guard: an invoice's owner is its Order's
          // partyId (or customerId, for the CUSTOMER party type — the same
          // fallback the Payment-In page's own invoice filter already
          // uses), and it must match this payment's entityId exactly.
          const order = invoiceForGuard.order as any;
          const ownerId = order?.partyType === 'CUSTOMER' ? (order?.partyId || order?.customerId) : order?.partyId;
          if (!entityId || ownerId !== entityId) {
            throw new PaymentValidationError(
              'INVOICE_PARTY_MISMATCH',
              `Invoice ${alloc.invoiceId} does not belong to the selected party.`
            );
          }

          const alreadyPaid = await this.getInvoicePaidAmount(tx, alloc.invoiceId);
          const outstanding = invoiceForGuard.finalAmount - alreadyPaid;
          if (allocAmount > outstanding + 0.01) {
            throw new PaymentValidationError(
              'ALLOCATION_EXCEEDS_OUTSTANDING',
              `Invalid allocation: ₹${allocAmount} exceeds the outstanding balance (₹${outstanding.toFixed(2)}) on invoice ${alloc.invoiceId}.`
            );
          }
          allocatedTotal += allocAmount;
          // A single-entry allocations list still populates Payment.orderId
          // directly (see singleInvoiceId/Payment.create below) — capture it
          // here since this loop already fetched the invoice.
          if (!isMultiInvoice) orderIdForInvoice = invoiceForGuard.orderId;
        }
        if (Math.abs(allocatedTotal - amount) > 0.01) {
          throw new PaymentValidationError(
            'ALLOCATION_TOTAL_MISMATCH',
            `Total allocation (₹${allocatedTotal.toFixed(2)}) must equal the payment amount (₹${amount.toFixed(2)}).`
          );
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
          // A multi-invoice receipt (isMultiInvoice) doesn't belong to one
          // Invoice/Order, so both stay null here — its per-invoice
          // attribution lives in the PaymentAllocation rows created below.
          invoiceId:      !isMultiInvoice ? (singleInvoiceId || undefined) : undefined,
          orderId:        !isMultiInvoice ? (data.orderId || orderIdForInvoice || undefined) : undefined,
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

      // 4b. Multi-invoice receipt: persist the per-invoice split validated
      // in step 2c. Each invoice's own status is recomputed in step 5b
      // below using FinanceService.getInvoicePaidAmount, which already
      // includes these rows.
      if (isMultiInvoice) {
        await tx.paymentAllocation.createMany({
          data: rawAllocations!.map((alloc) => ({
            paymentId: payment.id,
            invoiceId: alloc.invoiceId,
            amount: parseFloat(alloc.amount as any),
          })),
        });
      }

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

      // 5a. If this is a Customer Payment, record in CustomerLedger. CREDIT
      // for an inflow (they paid us, reducing what they owe — mirrors the
      // DEBIT=owed-to-us/CREDIT=paid-to-us convention CustomerService.create's
      // opening-balance entry already establishes), DEBIT for an outflow
      // (e.g. a refund, which increases what we owe them). Only fires on an
      // exact 'CUSTOMER' match — same reasoning as the VendorLedger block
      // above: CustomerLedger.customerId is a required FK into Customer, so
      // a DEALER/FRANCHISE entityId here would violate it.
      if (data.entityType === 'CUSTOMER') {
        const customerId = entityId;
        if (customerId) {
          await tx.customerLedger.create({
            data: {
              customerId,
              type: flow === 'IN' ? 'CREDIT' : 'DEBIT',
              amount,
              paymentMode: resolvedPaymentMode as any,
              referenceType: 'PAYMENT',
              referenceId: payment.id,
              accountId: account?.id,
              note: data.note || `Payment #${paymentNumber} recorded`,
              createdAt: data.createdAt ? new Date(data.createdAt) : undefined,
            },
          });
        }
      }

      // 5b. Customer payment against a Tax Invoice — recompute paid/
      // outstanding/status from the actual sum of Payment (+ PaymentAllocation
      // for a multi-invoice receipt) rows every time (never trust a client-
      // supplied status), and mirror it onto the Order the Invoice belongs
      // to so both records agree. This is the ONLY place a Tax Invoice's
      // payment status is allowed to change — it is never settable directly
      // by the frontend. Multi-invoice receipts recompute EVERY allocated
      // invoice, not just one.
      const invoiceIdsToRecompute = isMultiInvoice
        ? rawAllocations!.map((a) => a.invoiceId)
        : (singleInvoiceId ? [singleInvoiceId] : []);
      if (invoiceIdsToRecompute.length > 0 && status === 'PAID') {
        for (const invId of invoiceIdsToRecompute) {
          const invoiceRow = await tx.invoice.findUnique({ where: { id: invId } });
          if (!invoiceRow) continue;
          const paidSoFar = await this.getInvoicePaidAmount(tx, invId);
          // 'PARTIAL' (not 'PARTIALLY_PAID') to match the existing status
          // vocabulary already used by /sales/invoices' status badge map.
          const newStatus = paidSoFar >= invoiceRow.finalAmount - 0.01
            ? 'PAID'
            : paidSoFar > 0
            ? 'PARTIAL'
            : 'UNPAID';
          await tx.invoice.update({ where: { id: invId }, data: { status: newStatus } });
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
      productId?: string;
      productName?: string;
      qty?: number;
      quantity?: number;
      unit?: string;
      rate?: number;
      price?: number;
      gst?: number;
      taxPercent?: number;
      discount?: number;
      discountPct?: number;
      discountAmount?: number;
      batchNumber?: string;
    }[];
    receivedAmount?: number;
    paymentMode?: any;
    discountAmount?: number;
    deliveryCharge?: number;
    deliveryCharges?: number;
    sourceFranchiseOrderId?: string;
    sourceQuotationId?: string;
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

      // Trust boundary: this was the least-guarded financially-significant
      // endpoint in the system — it accepted item.rate/gst verbatim from
      // the request body with zero lookup of InventoryItem/Product master
      // data. For every line with a resolvable product, re-derive the
      // authoritative channel price and GST rate here, mirroring
      // POSService.checkout's price/tax resolution. A line with no
      // resolvable product (a hand-typed custom line) keeps whatever the
      // client sent, since there's nothing authoritative to check it
      // against. Discount is left as the pre-existing, legitimate
      // manual/negotiated value — this chain has never had a separate
      // InventoryItem-configured "Customer Retail Discount" wired in, and
      // this fix does not introduce one.
      const scopeFranchiseId = await FranchiseService.toInventoryScopeId(tx, data.franchiseId);
      const resolvedInvoicePartyType: 'CUSTOMER' | 'DEALER' | 'FRANCHISE' =
        data.partyType === 'DEALER' ? 'DEALER' : data.partyType === 'FRANCHISE' ? 'FRANCHISE' : 'CUSTOMER';

      for (const item of data.items) {
        const qty = Number(item.qty ?? item.quantity ?? 0);
        let rate = Number(item.rate ?? item.price ?? 0);
        let gst = Number(item.gst ?? item.taxPercent ?? 0);
        // "Customer Retail Discount" default — CUSTOMER channel only, and
        // only used below if the client sent no explicit discount at all.
        let autoDiscountType = 'PERCENT';
        let autoDiscountValue = 0;

        if (item.productId) {
          let product = await tx.product.findUnique({ where: { id: item.productId } });
          let inv: any = null;
          if (product) {
            inv = product.sku
              ? await tx.inventoryItem.findFirst({ where: { sku: product.sku, franchiseId: scopeFranchiseId } })
              : await tx.inventoryItem.findFirst({ where: { name: { equals: product.name, mode: 'insensitive' }, franchiseId: scopeFranchiseId } });
          } else {
            // Some callers reference an InventoryItem.id directly rather
            // than a Product.id (e.g. picked from the raw InventoryItem
            // catalog) — resolve that identity too.
            inv = await tx.inventoryItem.findUnique({ where: { id: item.productId } });
          }
          if (!product && !inv) {
            // A productId was supplied but resolves to nothing — accepting
            // the client-submitted rate here would silently reopen the
            // exact trust hole this resolver exists to close (a real
            // Dealer price of ₹40 with a resolution failure otherwise
            // accepting a submitted ₹1). Reject instead of guessing.
            throw new Error(`Cannot price line item "${item.productName || item.productId}" — productId "${item.productId}" does not match any known Product or InventoryItem. Remove the reference to use a free-text price, or fix the id.`);
          }
          const channelPrice =
            resolvedInvoicePartyType === 'DEALER' ? inv?.dealerPrice :
            resolvedInvoicePartyType === 'FRANCHISE' ? inv?.franchisePrice :
            inv?.customerPrice;
          rate = channelPrice && channelPrice > 0 ? channelPrice : (inv?.basePrice || product?.basePrice || 0);
          gst = inv?.gstRate ?? product?.taxPercent ?? 0;
          if (resolvedInvoicePartyType === 'CUSTOMER') {
            autoDiscountType = inv?.discountType || product?.discountType || 'PERCENT';
            autoDiscountValue = Number(inv?.discountValue ?? product?.discountValue ?? 0);
          }
        }

        // A negotiated discount is legitimate but can never exceed the
        // line/document it's discounting, and never be negative — that's
        // what keeps this a "manual discount" rather than a way to
        // fabricate a negative or inflated invoice total.
        const hasExplicitDiscount = item.discountAmount !== undefined || item.discount !== undefined || item.discountPct !== undefined;
        let discountPct = Number(item.discount ?? item.discountPct ?? 0);
        discountPct = Math.max(0, Math.min(discountPct, 100));

        const itemSubtotal = qty * rate;
        let itemDiscount: number;
        if (item.discountAmount !== undefined) {
          itemDiscount = Number(item.discountAmount);
        } else if (hasExplicitDiscount) {
          itemDiscount = itemSubtotal * discountPct / 100;
        } else if (autoDiscountValue > 0) {
          // No explicit discount sent at all — fall back to the Item
          // Master's Customer Retail Discount (already gated to CUSTOMER
          // above; stays 0 for Dealer/Franchise).
          itemDiscount = autoDiscountType === 'FLAT'
            ? autoDiscountValue * qty
            : itemSubtotal * autoDiscountValue / 100;
        } else {
          itemDiscount = 0;
        }
        itemDiscount = Math.max(0, Math.min(itemDiscount, itemSubtotal));
        // Reflect whatever discount actually got applied (including the
        // Customer Retail Discount auto-fill above) in the stored percent,
        // not just an explicitly-submitted one — keeps OrderItem.discountPct
        // consistent with the dollar amount for record-keeping.
        discountPct = itemSubtotal > 0 ? (itemDiscount / itemSubtotal) * 100 : 0;
        const itemTaxableAmount = Math.max(0, itemSubtotal - itemDiscount);
        const itemTax = itemTaxableAmount * (gst / 100);

        subTotal += itemSubtotal;
        if (!data.discountAmount) {
          totalDiscount += itemDiscount;
        }
        totalTax += itemTax;

        orderItemsData.push({
          productId: item.productId || '',
          quantity: qty,
          unit: item.unit || 'NONE',
          price: rate,
          discountPct: discountPct,
          taxAmount: itemTax,
          totalAmount: itemTaxableAmount + itemTax,
          batchNumber: item.batchNumber || null
        });
      }

      const deliveryCharge = Number(data.deliveryCharge ?? data.deliveryCharges ?? 0);
      // Bound the aggregate discount (whether an explicit data.discountAmount
      // or the summed item discounts above) to what's actually on the bill,
      // and floor the final total at zero — the same clamp POSService.checkout
      // applies to its manualDiscount, closing the equivalent hole here.
      totalDiscount = Math.max(0, Math.min(totalDiscount, subTotal + totalTax));
      const totalAmount = Math.max(0, subTotal + totalTax - totalDiscount + deliveryCharge);
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

      let resolvedCustomerName = (data as any).customerName || null;
      if (!resolvedCustomerName && data.partyType === 'FRANCHISE' && data.partyId) {
        const fr = await tx.franchise.findUnique({ where: { id: data.partyId } });
        if (fr) resolvedCustomerName = fr.name;
      } else if (!resolvedCustomerName && data.partyType === 'CUSTOMER' && data.customerId) {
        const cust = await tx.customer.findUnique({ where: { id: data.customerId } });
        if (cust) resolvedCustomerName = cust.name;
      }

      const order = await tx.order.create({
        data: {
          invoiceNum,
          sourceQuotationId: data.sourceFranchiseOrderId || (data as any).sourceQuotationId || null,
          partyType: (data.partyType || 'CUSTOMER') as any,
          partyId: data.partyId,
          customerId: data.customerId,
          customerName: resolvedCustomerName,
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

      // If created from a Franchise Order, update the related FranchiseOrder with the final approved amount
      if (data.sourceFranchiseOrderId) {
        const fOrder = await tx.franchiseOrder.findUnique({
          where: { id: data.sourceFranchiseOrderId },
        });

        if (fOrder) {
          const oldTotal = fOrder.totalAmount;
          const newTotal = finalAmount;
          const difference = newTotal - oldTotal;

          const statusToSet = fOrder.status === 'PENDING' ? 'APPROVED' : fOrder.status;

          await tx.franchiseOrder.update({
            where: { id: data.sourceFranchiseOrderId },
            data: {
              status: statusToSet,
              subtotal: subTotal - totalDiscount,
              taxAmount: totalTax,
              deliveryCharges: deliveryCharge,
              totalAmount: newTotal,
            }
          });

          if (Math.abs(difference) > 0.001) {
            const currentFranchise = await tx.franchise.findUnique({ where: { id: fOrder.franchiseId } });
            const newOutstanding = (currentFranchise?.outstandingAmount || 0) + difference;

            await tx.franchiseLedger.create({
              data: {
                franchiseId: fOrder.franchiseId,
                type: difference > 0 ? LedgerType.DEBIT : LedgerType.CREDIT,
                amount: Math.abs(difference),
                balanceAfter: newOutstanding,
                referenceType: FranchiseLedgerRefType.ORDER,
                referenceId: fOrder.orderNumber,
                note: `Invoice ${invoiceNum} adjustment (Delivery: ₹${deliveryCharge}, Tax: ₹${totalTax.toFixed(2)})`,
              }
            });

            await tx.franchise.update({
              where: { id: fOrder.franchiseId },
              data: { outstandingAmount: newOutstanding }
            });
          }

          try {
            SocketService.io.emit('franchise-order-updated', {
              id: fOrder.id,
              status: 'APPROVED',
              totalAmount: newTotal,
            });
          } catch (err) {
            console.error('[Socket] Failed to emit franchise-order-updated', err);
          }
        }
      }

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
      if (!data.sourceFranchiseOrderId && data.partyType !== 'FRANCHISE') {
        await POSService.deductInventoryIfNecessary(order.id, tx);
      }

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
          // A multi-invoice receipt's share of this order isn't in
          // `payments` (that Payment's orderId is null) — it's here, on the
          // Invoice this order owns. See sumOrderPaidWithAllocations.
          invoice: { select: { allocations: { select: { amount: true, payment: { select: { status: true, isCancelled: true } } } } } },
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
      // Matches this site's pre-existing (unfiltered) summation exactly —
      // only the missing allocation term is added, nothing else changes.
      const paidAmount = order.paymentStatus === 'PAID'
        ? order.totalAmount
        : this.sumOrderPaidWithAllocations(order.payments, order.invoice?.allocations, () => true);
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
          invoice: true,
          account: true,
          vendorInvoice: {
            include: { vendor: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.payment.aggregate({ where: { ...whereClause, NOT: this.PAYMENT_OUTFLOW_FILTER }, _sum: { paidAmount: true } }),
      prisma.payment.aggregate({ where: { AND: [whereClause, this.PAYMENT_OUTFLOW_FILTER] }, _sum: { paidAmount: true } })
    ]);

    const expenseIds = Array.from(new Set(
      payments.filter(p => p.sourceModule === 'EXPENSE' && p.linkedDocId).map(p => p.linkedDocId as string)
    ));
    const linkedExpenses = expenseIds.length
      ? await prisma.expense.findMany({ where: { id: { in: expenseIds } }, select: { id: true, payee: true, category: true } })
      : [];
    const expenseById = new Map(linkedExpenses.map(e => [e.id, e]));

    const data = await Promise.all(payments.map(async p => {
      const flow = p.entityType === 'VENDOR' || p.sourceModule === 'EXPENSE' || p.type === 'INTERNAL_TRANSFER' ? 'OUT' : 'IN';
      let partyName = await this.resolvePartyName(p.entityType, p.entityId);

      if (!partyName) {
        if (p.order?.customerName) {
          partyName = p.order.customerName;
        } else if (p.order?.customer?.name) {
          partyName = p.order.customer.name;
        } else if (p.vendorInvoice?.vendor?.name) {
          partyName = p.vendorInvoice.vendor.name;
        } else if (p.sourceModule === 'EXPENSE') {
          const linkedExpense = p.linkedDocId ? expenseById.get(p.linkedDocId) : undefined;
          partyName = linkedExpense?.payee || (p.entityId ? p.entityId : linkedExpense?.category ? linkedExpense.category : null);
        }
      }

      let transactionType = 'Payment';
      if (p.vendorInvoice || p.entityType === 'VENDOR') {
        transactionType = 'Purchase';
      } else if (p.sourceModule === 'POS' || p.order || p.invoice) {
        transactionType = 'Sale';
      } else if (p.sourceModule === 'EXPENSE') {
        transactionType = 'Expense';
      } else if (p.type === 'INTERNAL_TRANSFER') {
        transactionType = 'Transfer';
      } else if (p.entityType === 'CUSTOMER') {
        transactionType = flow === 'IN' ? 'Receipt' : 'Payment';
      }

      const total = Number(p.order?.totalAmount ?? p.invoice?.totalAmount ?? p.vendorInvoice?.amount ?? p.paidAmount);
      const moneyIn = flow === 'IN' ? Number(p.paidAmount) : null;
      const moneyOut = flow === 'OUT' ? Number(p.paidAmount) : null;
      const refNo = p.paymentNumber || p.transactionRef || (p.order?.invoiceNum ? `INV-${p.order.invoiceNum}` : p.id?.slice(-8) || p.id);

      return {
        id: p.id,
        createdAt: p.createdAt,
        date: p.createdAt,
        time: p.createdAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        name: partyName || null,
        partyName: partyName || null,
        refNo,
        paymentNumber: p.paymentNumber,
        type: transactionType,
        transactionType,
        paymentType: p.paymentMode,
        paymentMode: p.paymentMode,
        total,
        moneyIn,
        moneyOut,
        amount: p.paidAmount,
        paidAmount: p.paidAmount,
        accountingType: flow === 'IN' ? 'DEBIT' : 'CREDIT',
        flow,
        particulars: p.transactionRef || (transactionType === 'Purchase' ? 'Vendor Purchase Payment' : transactionType === 'Sale' ? 'Sales Payment Receipt' : transactionType === 'Expense' ? 'Expense Payment' : `${transactionType} Voucher`),
        status: p.status,
        isCancelled: p.isCancelled,
        createdBy: p.createdBy || 'System',
        approvedBy: p.approvedBy || 'System',
        accountName: p.account?.name || null,
        orderId: p.orderId,
        invoiceId: p.invoiceId,
        vendorInvoiceId: p.vendorInvoiceId
      };
    }));

    const rangeInflows = rangeInAgg._sum.paidAmount || 0;
    const rangeOutflows = rangeOutAgg._sum.paidAmount || 0;

    return {
      data,
      openingBalance,
      closingBalance: openingBalance + rangeInflows - rangeOutflows,
      totalDebit: rangeInflows,
      totalCredit: rangeOutflows,
      totalMoneyIn: rangeInflows,
      totalMoneyOut: rangeOutflows,
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
        include: {
          order: {
            include: {
              customer: true,
              payments: true,
              // See sumOrderPaidWithAllocations — a multi-invoice receipt's
              // share of this order lives here, not in `order.payments`
              // (that Payment's orderId is null).
              invoice: { select: { allocations: { select: { amount: true, payment: { select: { status: true, isCancelled: true } } } } } }
            }
          },
          invoice: true,
          account: true,
          vendorInvoice: { include: { vendor: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.payment.aggregate({ where: { ...whereClause, NOT: this.PAYMENT_OUTFLOW_FILTER }, _sum: { paidAmount: true } }),
      prisma.payment.aggregate({ where: { AND: [whereClause, this.PAYMENT_OUTFLOW_FILTER] }, _sum: { paidAmount: true } })
    ]);

    const expenseIds = Array.from(new Set(
      payments.filter(p => p.sourceModule === 'EXPENSE' && p.linkedDocId).map(p => p.linkedDocId as string)
    ));
    const linkedExpenses = expenseIds.length
      ? await prisma.expense.findMany({ where: { id: { in: expenseIds } }, select: { id: true, payee: true, category: true } })
      : [];
    const expenseById = new Map(linkedExpenses.map(e => [e.id, e]));

    const data = await Promise.all(payments.map(async p => {
      const flow = p.entityType === 'VENDOR' || p.sourceModule === 'EXPENSE' || p.type === 'INTERNAL_TRANSFER' ? 'OUT' : 'IN';
      let partyName = await this.resolvePartyName(p.entityType, p.entityId);

      if (!partyName) {
        if (p.order?.customerName) {
          partyName = p.order.customerName;
        } else if (p.order?.customer?.name) {
          partyName = p.order.customer.name;
        } else if (p.vendorInvoice?.vendor?.name) {
          partyName = p.vendorInvoice.vendor.name;
        } else if (p.sourceModule === 'EXPENSE') {
          const linkedExpense = p.linkedDocId ? expenseById.get(p.linkedDocId) : undefined;
          partyName = linkedExpense?.payee || (p.entityId ? p.entityId : linkedExpense?.category ? linkedExpense.category : null);
        }
      }

      const particulars =
        p.transactionRef ||
        (p.order?.invoiceNum ? `POS Sale #${p.order.invoiceNum}` : null) ||
        (p.sourceModule === 'EXPENSE' ? 'Expense Payment' : null) ||
        (p.sourceModule === 'POS' ? 'Counter Billing Payment' : null) ||
        (p.entityType === 'VENDOR' ? 'Vendor Payment' : p.entityType === 'CUSTOMER' ? 'Customer Payment' : p.sourceModule ? `${p.sourceModule} Payment` : 'Payment Voucher');

      const orderTotal = Number(p.order?.totalAmount ?? p.invoice?.totalAmount ?? p.vendorInvoice?.amount ?? p.paidAmount);
      const paidForOrder = p.order?.payments?.length
        ? this.sumOrderPaidWithAllocations(
            p.order.payments,
            (p.order as any).invoice?.allocations,
            (x) => !x.isCancelled && (x.status === 'PAID' || x.status === 'SUCCESS')
          )
        : Number(p.paidAmount);
      const receivableAmount = Number(p.paidAmount);
      const balanceAmount = Math.max(0, orderTotal - paidForOrder);

      return {
        id: p.id,
        createdAt: p.createdAt,
        refNo: p.paymentNumber || p.id,
        paymentNumber: p.paymentNumber,
        name: partyName || null,
        partyName: partyName || null,
        particulars,
        description: particulars,
        entity: partyName || particulars,
        entityType: p.entityType,
        entityId: p.entityId,
        paymentMode: p.paymentMode,
        method: p.paymentMode,
        paymentType: p.paymentMode,
        type: p.paymentMode,
        accountingType: flow === 'IN' ? 'DEBIT' : 'CREDIT',
        flow,
        amount: receivableAmount,
        paidAmount: receivableAmount,
        orderTotal,
        totalAmount: orderTotal,
        receivableAmount,
        balanceAmount,
        status: p.status,
        isCancelled: p.isCancelled,
        createdBy: p.createdBy || 'System',
        approvedBy: p.approvedBy || 'System',
        accountName: p.account?.name || null
      };
    }));

    const totalTransactionAmount = payments.reduce((s, p) => s + Number(p.order?.totalAmount ?? p.invoice?.totalAmount ?? p.vendorInvoice?.amount ?? p.paidAmount), 0);
    const totalReceivedAmount = Number(inAgg._sum.paidAmount || 0);
    const totalRemainingBalance = Math.max(0, totalTransactionAmount - totalReceivedAmount);

    return {
      data,
      totalAmount: totalTransactionAmount,
      receivableAmount: totalReceivedAmount,
      balanceAmount: totalRemainingBalance,
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

    // 3. Fetch Procurement Orders to calculate Sundry Creditors liability.
    // The liability owed per PO is the recognized VendorInvoice amount
    // (GRN-actual-price-derived, via VendorInvoiceService.recognizeLiability)
    // — not po.totalAmount, which is only the PO's ordered commitment and
    // never reflects a GRN price override. po.paid is unaffected (already
    // tracks real payments/advances against this PO) — only the liability
    // side of the netting changes. A PO with no invoice yet (nothing
    // received/billed) correctly contributes ₹0, not its full ordered value.
    const pos = await prisma.procurementOrder.findMany({
      where: {
        ...(franchiseId ? { franchiseId } : {}),
        status: { not: "CANCELLED" as any },
        ...dateFilter
      },
      include: { invoices: true }
    });

    let sundryCreditorsBalance = 0;
    for (const po of pos) {
      const recognizedLiability = (po.invoices || []).reduce((sum, inv) => sum + (inv.amount || 0), 0);
      const unpaid = recognizedLiability - (po.paid || po.advancePaid || 0);
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

    // 5. Calculate Purchase Costs — same VendorInvoice-based source as
    // getProfitAndLoss's Purchases line (see there for the full rationale),
    // so P&L and Trial Balance can no longer disagree on this figure.
    const purchaseAggregate = await prisma.vendorInvoice.aggregate({
      where: {
        procurementOrder: { ...(franchiseId ? { franchiseId } : {}), status: { not: "CANCELLED" as any } },
        ...buildBillDateFilter(startDate, endDate)
      },
      _sum: { amount: true }
    });
    const totalPurchases = purchaseAggregate._sum.amount || 0;

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

    // 4. Fetch Procurement Orders to calculate Sundry Creditors liability.
    // Same fix as getTrialBalanceReport: liability per PO is the recognized
    // VendorInvoice amount (GRN-actual-price-derived), not po.totalAmount
    // (the PO's ordered commitment) — po.paid is untouched. A PO with no
    // invoice yet correctly contributes ₹0.
    const pos = await prisma.procurementOrder.findMany({
      where: {
        franchiseId: filters.franchiseId,
        status: { not: "CANCELLED" },
        createdAt: {
          ...(filters.startDate ? { gte: filters.startDate } : {}),
          ...(filters.endDate ? { lte: filters.endDate } : {})
        }
      },
      include: { invoices: true }
    });

    let sundryCreditorsBalance = 0;
    for (const po of pos) {
      const recognizedLiability = (po.invoices || []).reduce((sum, inv) => sum + (inv.amount || 0), 0);
      const unpaid = recognizedLiability - (po.paid || po.advancePaid || 0);
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

    // Build sundry creditors breakdown — same recognized-liability source as above.
    const sundryCreditors: { name: string; amount: number }[] = [];
    for (const po of pos) {
      const recognizedLiability = (po.invoices || []).reduce((sum, inv) => sum + (inv.amount || 0), 0);
      const unpaid = recognizedLiability - (po.paid || po.advancePaid || 0);
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
        // Same VendorInvoice-based source as getProfitAndLoss/
        // getTrialBalanceReport's Purchase Accounts line — the actually
        // recognized (GRN-actual-price-derived) liability, not the PO's
        // ordered commitment.
        const purchAgg = await prisma.vendorInvoice.aggregate({
          where: {
            procurementOrder: { franchiseId, status: { not: 'CANCELLED' } },
            ...buildBillDateFilter(month.from, month.to)
          },
          _sum: { amount: true }
        });
        debit = purchAgg._sum.amount || 0;
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
    vendorId?: string;
    dealerId?: string;
    partyId?: string;
    partyType?: 'CUSTOMER' | 'DEALER' | 'VENDOR';
    partyName?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, startDate, endDate } = filters;
    const targetPartyId = (filters.partyId || filters.customerId || '').trim();
    const targetPartyName = (filters.partyName || '').trim();
    const { start, end } = parseInclusiveDates(startDate, endDate);

    // Fetch all customers, dealers, and vendors to populate dropdown & identify requested party
    const [customersList, dealersList, vendorsList] = await Promise.all([
      prisma.customer.findMany({
        where: franchiseId ? { franchiseId } : {},
        select: { id: true, name: true, phone: true }
      }),
      prisma.dealer.findMany({
        where: franchiseId ? { franchiseId } : {},
        select: { id: true, name: true, phone: true }
      }),
      prisma.vendor.findMany({
        select: { id: true, name: true, contact: true }
      })
    ]);

    const combinedParties = [
      ...customersList.map(c => ({ id: c.id, name: c.name, phone: c.phone, partyType: 'CUSTOMER' })),
      ...dealersList.map(d => ({ id: d.id, name: d.name, phone: d.phone, partyType: 'DEALER' })),
      ...vendorsList.map(v => ({ id: v.id, name: v.name, phone: v.contact, partyType: 'VENDOR' }))
    ];

    // Determine target party
    let resolvedParty: { id: string; name: string; partyType: 'CUSTOMER' | 'DEALER' | 'VENDOR' } | null = null;

    if (targetPartyId) {
      const match = combinedParties.find(p => p.id === targetPartyId);
      if (match) {
        resolvedParty = match as any;
      }
    }

    if (!resolvedParty && targetPartyName) {
      const nameMatch = combinedParties.find(p => p.name.toLowerCase() === targetPartyName.toLowerCase())
        || combinedParties.find(p => p.name.toLowerCase().includes(targetPartyName.toLowerCase()));
      if (nameMatch) {
        resolvedParty = nameMatch as any;
      }
    }

    if (!resolvedParty) {
      return {
        customers: combinedParties,
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

    const { id: partyId, partyType } = resolvedParty;

    // --- 1. DEALER (RECEIVABLE: Debits increase receivable, Credits decrease receivable) ---
    if (partyType === 'DEALER') {
      const dealer = await prisma.dealer.findUnique({ where: { id: partyId } });
      const openingBal = Number(dealer?.openingBalance) || 0;
      let runningBalance = openingBal;

      const [orders, payments, challans] = await Promise.all([
        prisma.order.findMany({
          where: {
            partyType: 'DEALER',
            partyId,
            status: { not: 'CANCELLED' },
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          },
          include: {
            payments: { where: { isCancelled: false } }
          },
          orderBy: { createdAt: 'asc' }
        }),
        prisma.payment.findMany({
          where: {
            entityType: 'DEALER',
            entityId: partyId,
            isCancelled: false,
            status: 'SUCCESS',
            orderId: null, // Avoid double counting payments directly on orders
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          },
          orderBy: { createdAt: 'asc' }
        }),
        prisma.deliveryChallan.findMany({
          where: {
            dealerId: partyId,
            challanDate: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          },
          orderBy: { challanDate: 'asc' }
        })
      ]);

      type RawTxn = {
        date: Date;
        txnType: string;
        refNo: string;
        paymentType: string;
        debit: number;
        credit: number;
        total: number;
        note?: string;
      };

      const rawTxns: RawTxn[] = [];

      // Opening balance entry if within range or as first row
      if (openingBal !== 0 && (!start || (dealer?.asOfDate && new Date(dealer.asOfDate) >= start))) {
        rawTxns.push({
          date: dealer?.asOfDate ? new Date(dealer.asOfDate) : (dealer?.createdAt || new Date()),
          txnType: 'Opening Balance',
          refNo: 'OB-0001',
          paymentType: '—',
          debit: openingBal > 0 ? openingBal : 0,
          credit: openingBal < 0 ? Math.abs(openingBal) : 0,
          total: Math.abs(openingBal),
          note: 'Dealer Opening Balance'
        });
      }

      for (const o of orders) {
        rawTxns.push({
          date: o.createdAt,
          txnType: 'POS Sale',
          refNo: o.invoiceNum || o.id.slice(0, 8).toUpperCase(),
          paymentType: o.paymentType || 'CASH',
          debit: o.totalAmount,
          credit: 0,
          total: o.totalAmount
        });

        for (const p of o.payments) {
          rawTxns.push({
            date: p.createdAt,
            txnType: 'Payment-In',
            refNo: p.paymentNumber || p.transactionRef || p.id.slice(0, 8).toUpperCase(),
            paymentType: p.paymentMode || 'CASH',
            debit: 0,
            credit: p.paidAmount,
            total: p.paidAmount
          });
        }
      }

      for (const p of payments) {
        rawTxns.push({
          date: p.createdAt,
          txnType: 'Payment-In',
          refNo: p.paymentNumber || p.transactionRef || p.id.slice(0, 8).toUpperCase(),
          paymentType: p.paymentMode || 'CASH',
          debit: 0,
          credit: p.paidAmount,
          total: p.paidAmount
        });
      }

      for (const c of challans) {
        rawTxns.push({
          date: c.challanDate,
          txnType: 'Delivery Challan',
          refNo: c.challanNumber || c.id.slice(0, 8).toUpperCase(),
          paymentType: '—',
          debit: 0,
          credit: 0,
          total: c.totalAmount
        });
      }

      rawTxns.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let totalSale = 0;
      let totalMoneyIn = 0;
      runningBalance = 0;

      const transactions = rawTxns.map(t => {
        totalSale += t.debit;
        totalMoneyIn += t.credit;
        // Receivable increases with debits (sales), decreases with credits (payments)
        runningBalance += t.debit - t.credit;

        return {
          date: new Date(t.date).toISOString().split('T')[0],
          txnType: t.txnType,
          refNo: t.refNo,
          paymentType: t.paymentType,
          total: t.total,
          debit: t.debit,
          credit: t.credit,
          receivedPaid: t.credit > 0 ? t.credit : t.debit,
          txnBalance: t.total,
          receivableBalance: runningBalance >= 0 ? runningBalance : 0,
          payableBalance: runningBalance < 0 ? Math.abs(runningBalance) : 0,
          runningBalance
        };
      });

      return {
        customers: combinedParties,
        partyType: 'DEALER',
        partyName: resolvedParty.name,
        accountingType: 'RECEIVABLE',
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

    // --- 2. CUSTOMER (RECEIVABLE: Debits increase receivable, Credits decrease receivable) ---
    if (partyType === 'CUSTOMER') {
      const customer = await prisma.customer.findUnique({ where: { id: partyId } });
      const openingBal = Number(customer?.openingBalance) || 0;

      const [ledgers, orders] = await Promise.all([
        prisma.customerLedger.findMany({
          where: {
            customerId: partyId,
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          },
          orderBy: { createdAt: 'asc' }
        }),
        prisma.order.findMany({
          where: {
            customerId: partyId,
            status: { not: 'CANCELLED' },
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          },
          include: {
            payments: { where: { isCancelled: false } }
          },
          orderBy: { createdAt: 'asc' }
        })
      ]);

      let rawTxns: Array<{
        date: Date;
        txnType: string;
        refNo: string;
        paymentType: string;
        debit: number;
        credit: number;
        total: number;
      }> = [];

      if (ledgers.length > 0) {
        rawTxns = ledgers.map(l => ({
          date: l.createdAt,
          txnType: l.referenceType === 'SALE' ? 'POS Sale' : l.referenceType === 'OPENING_BALANCE' ? 'Opening Balance' : 'Payment-In',
          refNo: l.referenceId ? l.referenceId.slice(0, 8).toUpperCase() : '—',
          paymentType: l.paymentMode || '—',
          debit: l.type === 'DEBIT' ? l.amount : 0,
          credit: l.type === 'CREDIT' ? l.amount : 0,
          total: l.amount
        }));
      } else {
        // Synthesize from orders & payments & opening balance
        if (openingBal !== 0) {
          rawTxns.push({
            date: customer?.asOfDate ? new Date(customer.asOfDate) : (customer?.createdAt || new Date()),
            txnType: 'Opening Balance',
            refNo: 'OB-0001',
            paymentType: '—',
            debit: openingBal > 0 ? openingBal : 0,
            credit: openingBal < 0 ? Math.abs(openingBal) : 0,
            total: Math.abs(openingBal)
          });
        }

        for (const o of orders) {
          rawTxns.push({
            date: o.createdAt,
            txnType: 'Sale',
            refNo: o.invoiceNum || o.id.slice(0, 8).toUpperCase(),
            paymentType: o.paymentType || 'CASH',
            debit: o.totalAmount,
            credit: 0,
            total: o.totalAmount
          });

          for (const p of o.payments) {
            rawTxns.push({
              date: p.createdAt,
              txnType: 'Payment-In',
              refNo: p.paymentNumber || p.transactionRef || p.id.slice(0, 8).toUpperCase(),
              paymentType: p.paymentMode || 'CASH',
              debit: 0,
              credit: p.paidAmount,
              total: p.paidAmount
            });
          }
        }
      }

      rawTxns.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let totalSale = 0;
      let totalMoneyIn = 0;
      let runningBalance = 0;

      const transactions = rawTxns.map(t => {
        totalSale += t.debit;
        totalMoneyIn += t.credit;
        runningBalance += t.debit - t.credit;

        return {
          date: new Date(t.date).toISOString().split('T')[0],
          txnType: t.txnType,
          refNo: t.refNo,
          paymentType: t.paymentType,
          total: t.total,
          debit: t.debit,
          credit: t.credit,
          receivedPaid: t.credit > 0 ? t.credit : t.debit,
          txnBalance: t.total,
          receivableBalance: runningBalance >= 0 ? runningBalance : 0,
          payableBalance: runningBalance < 0 ? Math.abs(runningBalance) : 0,
          runningBalance
        };
      });

      return {
        customers: combinedParties,
        partyType: 'CUSTOMER',
        partyName: resolvedParty.name,
        accountingType: 'RECEIVABLE',
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

    // --- 3. VENDOR (PAYABLE: Credits increase payable, Debits decrease payable) ---
    const vendorLedgers = await prisma.vendorLedger.findMany({
      where: {
        vendorId: partyId,
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    let totalPurchase = 0;
    let totalMoneyOut = 0;
    let runningPayable = 0;

    const transactions = vendorLedgers.map(entry => {
      const isCredit = entry.type === 'CREDIT'; // Purchase Bill / Invoice increases payable
      const isDebit = entry.type === 'DEBIT';   // Payment Out / Purchase Return decreases payable
      const amount = Number(entry.amount) || 0;

      if (isCredit) totalPurchase += amount;
      if (isDebit) totalMoneyOut += amount;

      runningPayable += isCredit ? amount : -amount;

      return {
        date: entry.createdAt.toISOString().split('T')[0],
        txnType: entry.referenceType ? formatReferenceType(entry.referenceType) : 'Payment Out',
        refNo: entry.referenceId ? entry.referenceId.slice(0, 8).toUpperCase() : '—',
        paymentType: entry.paymentMode || '—',
        total: amount,
        debit: isDebit ? amount : 0,
        credit: isCredit ? amount : 0,
        receivedPaid: isDebit ? amount : 0,
        txnBalance: amount,
        receivableBalance: runningPayable < 0 ? Math.abs(runningPayable) : 0,
        payableBalance: runningPayable >= 0 ? runningPayable : 0,
        runningBalance: runningPayable
      };
    });

    return {
      customers: combinedParties,
      partyType: 'VENDOR',
      partyName: resolvedParty.name,
      accountingType: 'PAYABLE',
      transactions,
      summary: {
        totalSale: 0,
        totalPurchase,
        totalExpense: 0,
        totalMoneyIn: 0,
        totalMoneyOut,
        totalReceivable: runningPayable < 0 ? Math.abs(runningPayable) : 0,
        totalPayable: runningPayable >= 0 ? runningPayable : 0
      }
    };
  }

  static async getPartyProfitLoss(filters: {
    franchiseId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const { franchiseId, startDate, endDate } = filters;
    const { start, end } = parseInclusiveDates(startDate, endDate);

    // Fetch all final sales for the franchise
    const orders = await prisma.order.findMany({
      where: finalSaleWhere({
        franchiseId,
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      }),
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
      }
    });

    const partyMap = new Map<string, { partyName: string; phoneNo: string; totalSaleAmount: number; totalCost: number }>();

    for (const order of orders) {
      const partyId = order.customerId || 'CASH_CUSTOMER';
      const partyName = order.customer ? order.customer.name : (order.customerName || 'Cash Customer');
      const phoneNo = order.customer ? (order.customer.phone || '—') : '—';
      
      if (!partyMap.has(partyId)) {
        partyMap.set(partyId, { partyName, phoneNo, totalSaleAmount: 0, totalCost: 0 });
      }
      
      const partyData = partyMap.get(partyId)!;
      
      // Use tax-exclusive sales for P&L
      const taxExclusiveAmount = order.totalAmount - (order.taxAmount || 0);
      partyData.totalSaleAmount += taxExclusiveAmount;
      
      for (const item of order.orderItems) {
        if (item.totalCost !== null && item.totalCost !== undefined) {
          partyData.totalCost += item.totalCost;
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
        partyData.totalCost += itemCost * item.quantity;
      }
    }

    const reportRows = Array.from(partyMap.values()).map(data => {
      return {
        partyName: data.partyName,
        phoneNo: data.phoneNo,
        totalSaleAmount: data.totalSaleAmount,
        profit: data.totalSaleAmount - data.totalCost
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
    const { start, end } = parseInclusiveDates(startDate, endDate);

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
    const { start, end } = parseInclusiveDates(startDate, endDate);

    const partyMap = new Map<string, { partyName: string; partyType: string; totalSale: number; totalPurchase: number; net: number }>();

    // Fetch Sales
    const orders = await prisma.order.findMany({
      where: finalSaleWhere({
        franchiseId,
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      }),
      include: { customer: true }
    });

    const dealerIds = [...new Set(orders.filter(o => o.partyType === 'DEALER' && o.partyId).map(o => o.partyId!))];
    const franchiseIds = [...new Set(orders.filter(o => o.partyType === 'FRANCHISE' && o.partyId).map(o => o.partyId!))];
    
    const dealers = dealerIds.length > 0 ? await prisma.dealer.findMany({ where: { id: { in: dealerIds } } }) : [];
    const franchises = franchiseIds.length > 0 ? await prisma.franchise.findMany({ where: { id: { in: franchiseIds } } }) : [];
    
    const dealerMap = new Map(dealers.map(d => [d.id, d.name]));
    const franchiseMap = new Map(franchises.map(f => [f.id, f.name]));

    for (const order of orders) {
      let partyName = 'Walk-in Customer';
      let partyType = 'Cash Customers';
      
      const pType = order.partyType || 'CUSTOMER';
      
      if (pType === 'CUSTOMER') {
        if (order.customerId && order.customer) {
          partyName = order.customer.name;
          partyType = 'Customers';
        } else if (order.customerName) {
          partyName = order.customerName;
          partyType = 'Cash Customers';
        }
      } else if (pType === 'DEALER' && order.partyId && dealerMap.has(order.partyId)) {
        partyName = dealerMap.get(order.partyId)!;
        partyType = 'Dealers';
      } else if (pType === 'FRANCHISE' && order.partyId && franchiseMap.has(order.partyId)) {
        partyName = franchiseMap.get(order.partyId)!;
        partyType = 'Franchises';
      }

      if (!partyMap.has(partyName)) {
        partyMap.set(partyName, { partyName, partyType, totalSale: 0, totalPurchase: 0, net: 0 });
      }
      partyMap.get(partyName)!.totalSale += order.totalAmount;
    }

    // Fetch Purchases — actually recognized liability (VendorInvoice,
    // GRN-actual-price-derived), not po.totalAmount (the PO's ordered
    // commitment). Queried directly off VendorInvoice (bill-level, keyed by
    // its own billDate — see buildBillDateFilter) since ProcurementOrder has
    // no billDate field of its own; same source/rationale as
    // getProfitAndLoss/getTrialBalanceReport's Purchase line. A PO with no
    // invoice yet (nothing received/billed) correctly contributes nothing.
    const invoices = await prisma.vendorInvoice.findMany({
      where: {
        procurementOrder: { franchiseId, status: { not: 'CANCELLED' } },
        ...buildBillDateFilter(startDate, endDate)
      },
      include: { procurementOrder: { include: { vendor: true } } }
    });

    for (const inv of invoices) {
      const partyName = inv.procurementOrder?.vendor?.name || 'Unknown Vendor';
      const partyType = 'Vendors';
      if (!partyMap.has(partyName)) {
        partyMap.set(partyName, { partyName, partyType, totalSale: 0, totalPurchase: 0, net: 0 });
      }
      partyMap.get(partyName)!.totalPurchase += (inv.amount || 0);
    }

    const report = Array.from(partyMap.values())
      .map(r => ({
        ...r,
        net: r.totalSale - r.totalPurchase
      }))
      .filter(r => r.totalSale !== 0 || r.totalPurchase !== 0);

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
    franchiseId?: string,
    filters?: { category?: string; startDate?: Date; endDate?: Date }
  ) {
    const { category, startDate, endDate } = filters || {};
    const inclusiveEndDate = endDate ? new Date(endDate) : undefined;
    if (inclusiveEndDate) inclusiveEndDate.setHours(23, 59, 59, 999);

    const scopeFilter = franchiseId ? { OR: [{ franchiseId }, { franchiseId: null }] } : {};

    const items = await prisma.inventoryItem.findMany({
      where: {
        ...scopeFilter,
        isActive: true,
        ...(category && category !== 'ALL' ? { category: category as ItemCategory } : {})
      },
      orderBy: { name: 'asc' }
    });

    const itemIds = items.map(i => i.id);

    // Compute stock from movements as of inclusiveEndDate (or up to current if not provided)
    const movements = await prisma.stockMovement.findMany({
      where: {
        itemId: { in: itemIds },
        ...(inclusiveEndDate ? { createdAt: { lte: inclusiveEndDate } } : {})
      },
      select: { itemId: true, quantity: true, baseQty: true }
    });

    const stockMap = new Map<string, number>();
    for (const m of movements) {
      const val = m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity;
      stockMap.set(m.itemId, (stockMap.get(m.itemId) || 0) + val);
    }

    // Reserved quantity in active production runs (PENDING or IN_PROGRESS)
    const reservedAggs = await prisma.productionItem.groupBy({
      by: ['inventoryItemId'],
      where: {
        inventoryItemId: { in: itemIds },
        production: {
          status: { in: ['PENDING', 'IN_PROGRESS'] }
        }
      },
      _sum: { usedQuantity: true }
    });
    const reservedMap = new Map<string, number>();
    for (const r of reservedAggs) {
      if (r.inventoryItemId) {
        reservedMap.set(r.inventoryItemId, r._sum.usedQuantity || 0);
      }
    }

    const data = items.map(item => {
      const salePrice = Number(item.customerPrice || item.basePrice || item.franchisePrice || 0);
      const purchasePrice = Number(item.costPrice || 0);

      const hasMovements = stockMap.has(item.id);
      const stockQty = hasMovements
        ? (stockMap.get(item.id) ?? 0)
        : (inclusiveEndDate ? 0 : (item.currentStock || 0));

      const reservedQty = reservedMap.get(item.id) || 0;
      const availableQty = Math.max(0, stockQty - reservedQty);
      const qtyForSale = availableQty;
      const stockValue = stockQty > 0 ? stockQty * purchasePrice : 0;

      return {
        id: item.id,
        itemName: item.name,
        name: item.name,
        sku: item.sku,
        category: item.category,
        unit: item.unit,
        salePrice,
        sellingPrice: salePrice,
        purchasePrice,
        costPrice: purchasePrice,
        stockQty,
        currentStock: stockQty,
        availableQty,
        availableStock: availableQty,
        qtyForSale,
        reservedQty,
        reservedStock: reservedQty,
        stockValue,
        minimumStock: item.minimumStock || 10,
        status: stockQty <= (item.minimumStock || 10) ? 'LOW' : 'SAFE'
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

  static async getItemWiseProfitLoss(franchiseId?: string, startDate?: string | Date, endDate?: string | Date) {
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const productionDateFilter = (start || end) ? {
      producedAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const [orders, returnOrders, procurementOrders, purchaseReturns, inventoryItems, products, stockMovements, productions] = await Promise.all([
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { notIn: ['CANCELLED'] },
          ...dateFilter
        },
        include: {
          orderItems: {
            include: {
              product: {
                include: {
                  recipe: {
                    include: {
                      recipeItems: {
                        include: { inventoryItem: true }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.returnOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { notIn: ['REJECTED'] },
          ...dateFilter
        },
        include: {
          items: true
        }
      }),
      prisma.procurementOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { notIn: ['CANCELLED'] },
          ...dateFilter
        },
        include: {
          poItems: {
            include: { inventoryItem: true }
          },
          // Actual purchase value/cost must come from what was actually
          // received (GoodsReceiptItem.price), not the PO's ordered
          // commitment (ProcurementOrderItem.price) — GRN approval can
          // override the unit price. poItems above is kept only to look up
          // each material's GST rate (not stored on GoodsReceiptItem).
          goodsReceipts: {
            where: { status: 'COMPLETED' },
            include: { items: { include: { inventoryItem: true } } }
          }
        }
      }),
      prisma.purchaseReturn.findMany({
        where: {
          status: { notIn: ['REJECTED'] },
          ...dateFilter
        },
        include: {
          items: true
        }
      }),
      prisma.inventoryItem.findMany({
        where: franchiseId ? { OR: [{ franchiseId }, { franchiseId: null }] } : {}
      }),
      prisma.product.findMany(),
      prisma.stockMovement.findMany({
        where: end ? { createdAt: { lte: end } } : {},
        select: { itemId: true, quantity: true, baseQty: true, createdAt: true, unitCost: true }
      }),
      prisma.production.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { notIn: ['CANCELLED'] },
          ...productionDateFilter
        },
        include: {
          recipe: {
            include: { product: true }
          },
          items: {
            include: { inventoryItem: true }
          }
        }
      })
    ]);

    // Compute opening and closing stock quantities
    const openingStockQtyMap = new Map<string, number>();
    const closingStockQtyMap = new Map<string, number>();

    for (const m of stockMovements) {
      const val = m.baseQty !== null && m.baseQty !== undefined ? m.baseQty : m.quantity;
      if (start && m.createdAt < start) {
        openingStockQtyMap.set(m.itemId, (openingStockQtyMap.get(m.itemId) || 0) + val);
      }
      closingStockQtyMap.set(m.itemId, (closingStockQtyMap.get(m.itemId) || 0) + val);
    }

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
      quantitySold: number;
      quantityPurchased: number;
    }> = {};

    const getOrCreate = (rawName: string) => {
      const trimmed = (rawName || 'Unknown Item').trim() || 'Unknown Item';
      const key = trimmed.toLowerCase();
      if (!itemMap[key]) {
        itemMap[key] = {
          itemName: trimmed,
          sale: 0,
          saleReturn: 0,
          purchase: 0,
          purchaseReturn: 0,
          openingStock: 0,
          closingStock: 0,
          taxReceivable: 0,
          taxPayable: 0,
          mfgCost: 0,
          consumptionCost: 0,
          netProfitLoss: 0,
          quantitySold: 0,
          quantityPurchased: 0
        };
      }
      return itemMap[key];
    };

    // 1. Process Inventory Items (for opening and closing stock)
    for (const item of inventoryItems) {
      const cost = Number(item.costPrice || item.basePrice || 0);
      
      const opQty = openingStockQtyMap.get(item.id) ?? 0;
      const clQty = closingStockQtyMap.has(item.id) 
        ? (closingStockQtyMap.get(item.id) ?? 0) 
        : (end ? 0 : (item.currentStock || 0));

      const opVal = Number((opQty > 0 ? opQty * cost : 0).toFixed(2));
      const clVal = Number((clQty > 0 ? clQty * cost : 0).toFixed(2));

      if (opVal > 0 || clVal > 0) {
        const entry = getOrCreate(item.name);
        entry.openingStock += opVal;
        entry.closingStock += clVal;
      }
    }

    // 2. Process Sales (Orders)
    for (const order of orders) {
      for (const item of order.orderItems) {
        const name = item.product?.name || 'Unknown Item';
        const entry = getOrCreate(name);
        const qty = Number(item.quantity || 0);
        const lineTotal = Number(item.totalAmount ?? ((item.price || 0) * qty));
        const tax = Number(item.taxAmount || 0);

        entry.sale += lineTotal;
        entry.taxPayable += tax;
        entry.quantitySold += qty;

        // Recipe-based raw material consumption tracking
        if (item.product?.recipe && item.product.recipe.recipeItems?.length) {
          const scalar = qty / (item.product.recipe.yieldQty || 1);
          for (const ri of item.product.recipe.recipeItems) {
            const rawCost = ri.inventoryItem?.costPrice || ri.inventoryItem?.basePrice || 0;
            const consumedVal = ri.quantityRequired * scalar * rawCost;
            entry.consumptionCost += Number(consumedVal.toFixed(2));
          }
        }
      }
    }

    // 3. Process Sale Returns / Credit Notes
    for (const ret of returnOrders) {
      for (const item of ret.items) {
        const entry = getOrCreate(item.productName || 'Unknown Item');
        const amt = Number(item.totalAmount ?? ((item.quantity || 0) * (item.rate || 0)));
        entry.saleReturn += amt;
      }
    }

    // 4. Process Purchases — actual received value from completed GRNs
    // (GoodsReceiptItem.price/acceptedQty), not the PO's ordered
    // commitment (ProcurementOrderItem.price/quantity). An un-received PO
    // contributes nothing here, which is correct: nothing was actually
    // purchased/incurred yet.
    for (const po of procurementOrders) {
      for (const grn of po.goodsReceipts || []) {
        for (const item of grn.items) {
          if (!item.acceptedQty) continue;
          const poItem = po.poItems.find(p => p.inventoryItemId === item.materialId);
          const name = item.inventoryItem?.name || poItem?.itemName || 'Unknown Item';
          const entry = getOrCreate(name);
          const qty = Number(item.acceptedQty || 0);
          const lineTotal = Number(qty * (item.price || 0));
          const gstRate = Number(poItem?.gstRate || 0);
          const tax = Number((lineTotal * gstRate) / 100);

          entry.purchase += lineTotal;
          entry.taxReceivable += tax;
          entry.quantityPurchased += qty;
        }
      }
    }

    // 5. Process Purchase Returns / Debit Notes
    for (const pr of purchaseReturns) {
      for (const item of pr.items) {
        const entry = getOrCreate(item.itemName || 'Unknown Item');
        const amt = Number(item.totalAmount ?? ((item.quantity || 0) * (item.rate || 0)));
        entry.purchaseReturn += amt;
      }
    }

    // 6. Process Production Manufacturing Cost
    for (const prod of productions) {
      const prodName = prod.recipe?.product?.name || prod.recipe?.name;
      if (prodName) {
        const entry = getOrCreate(prodName);
        const prodCost = Number(prod.totalCost ?? ((prod.materialCost || 0) + (prod.laborCost || 0) + (prod.overheadCost || 0)));
        entry.mfgCost += prodCost;
      }

      // Consumed raw materials in this production batch
      for (const pi of prod.items) {
        const rawName = pi.inventoryItem?.name;
        if (rawName) {
          const rawEntry = getOrCreate(rawName);
          const usedCost = Number(pi.totalCost ?? (pi.usedQuantity * (pi.unitCost || pi.inventoryItem?.costPrice || 0)));
          rawEntry.consumptionCost += usedCost;
        }
      }
    }

    // 7. Calculate Net Profit/Loss for each item
    const report = Object.values(itemMap)
      .map(row => {
        const sale = Number(row.sale.toFixed(2));
        const saleReturn = Number(row.saleReturn.toFixed(2));
        const purchase = Number(row.purchase.toFixed(2));
        const purchaseReturn = Number(row.purchaseReturn.toFixed(2));
        const openingStock = Number(row.openingStock.toFixed(2));
        const closingStock = Number(row.closingStock.toFixed(2));
        const taxReceivable = Number(row.taxReceivable.toFixed(2));
        const taxPayable = Number(row.taxPayable.toFixed(2));
        const mfgCost = Number(row.mfgCost.toFixed(2));
        const consumptionCost = Number(row.consumptionCost.toFixed(2));

        const netRevenue = sale - saleReturn;
        
        let costOfItem = 0;
        if (mfgCost > 0) {
          costOfItem = mfgCost;
        } else if (consumptionCost > 0) {
          costOfItem = consumptionCost;
        } else if (purchase > 0 || openingStock > 0) {
          const cogs = openingStock + (purchase - purchaseReturn) - closingStock;
          costOfItem = cogs > 0 ? cogs : Math.max(0, purchase - purchaseReturn);
        }

        const netProfitLoss = Number((netRevenue - costOfItem).toFixed(2));

        return {
          itemName: row.itemName,
          name: row.itemName,
          sale,
          saleReturn,
          creditNote: saleReturn,
          purchase,
          purchaseReturn,
          debitNote: purchaseReturn,
          openingStock,
          closingStock,
          taxReceivable,
          taxPayable,
          mfgCost,
          consumptionCost,
          netProfitLoss,
          profit: netProfitLoss,
          revenue: sale,
          cost: costOfItem,
          quantitySold: row.quantitySold,
          margin: sale > 0 ? Number(((netProfitLoss / sale) * 100).toFixed(2)) : 0
        };
      })
      .filter(r => r.sale > 0 || r.purchase > 0 || r.saleReturn > 0 || r.purchaseReturn > 0 || r.openingStock > 0 || r.closingStock > 0 || r.mfgCost > 0 || r.consumptionCost > 0)
      .sort((a, b) => b.sale - a.sale);

    return report;
  }

  static async getItemCategoryWiseProfitLoss(franchiseId?: string, startDate?: string | Date, endDate?: string | Date) {
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const [orders, inventoryItems] = await Promise.all([
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: 'COMPLETED',
          ...dateFilter
        },
        include: {
          orderItems: {
            include: {
              product: {
                include: {
                  recipe: {
                    include: {
                      recipeItems: {
                        include: { inventoryItem: true }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }),
      prisma.inventoryItem.findMany({
        where: franchiseId ? { franchiseId } : {}
      })
    ]);

    const invItemMap = new Map(inventoryItems.map(i => [i.sku, i]));
    const categoryMap: Record<string, { category: string; sale: number; revenue: number; cost: number; profit: number; netProfitLoss: number; margin: number }> = {};

    for (const order of orders) {
      for (const item of order.orderItems) {
        const category = item.product?.category || 'Uncategorized';
        if (!categoryMap[category]) {
          categoryMap[category] = { category, sale: 0, revenue: 0, cost: 0, profit: 0, netProfitLoss: 0, margin: 0 };
        }

        const qty = item.quantity || 0;
        const lineRevenue = (item.price * qty) || ((item.totalAmount || 0) - (item.taxAmount || 0)) || (item.totalAmount || 0);

        let lineCost = 0;
        if (item.totalCost !== null && item.totalCost !== undefined) {
          lineCost = item.totalCost;
        } else if (item.product?.recipe && item.product.recipe.recipeItems?.length) {
          const scalar = qty / (item.product.recipe.yieldQty || 1);
          for (const ri of item.product.recipe.recipeItems) {
            const unitCost = ri.inventoryItem?.costPrice || ri.inventoryItem?.basePrice || 0;
            lineCost += ri.quantityRequired * scalar * unitCost;
          }
        } else {
          const invItem = invItemMap.get(item.product?.sku || '');
          const unitCost = invItem?.costPrice || 0;
          lineCost = qty * unitCost;
        }

        categoryMap[category].sale += lineRevenue;
        categoryMap[category].revenue += lineRevenue;
        categoryMap[category].cost += lineCost;
      }
    }

    return Object.values(categoryMap).map(cat => {
      const profit = Number((cat.revenue - cat.cost).toFixed(2));
      const margin = cat.revenue > 0 ? Number(((profit / cat.revenue) * 100).toFixed(2)) : 0;
      return {
        ...cat,
        revenue: Number(cat.revenue.toFixed(2)),
        sale: Number(cat.sale.toFixed(2)),
        cost: Number(cat.cost.toFixed(2)),
        profit,
        netProfitLoss: profit,
        margin
      };
    });
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

  static async getItemDetailData(
    filtersOrFranchiseId?: string | { franchiseId?: string; itemName?: string; itemId?: string; productId?: string; startDate?: string | Date; endDate?: string | Date; search?: string; q?: string },
    itemNameArg?: string,
    startDateArg?: string | Date,
    endDateArg?: string | Date,
    itemIdArg?: string,
    searchArg?: string
  ): Promise<any> {
    let franchiseId: string | undefined;
    let itemName: string | undefined;
    let itemId: string | undefined;
    let startDate: string | Date | undefined;
    let endDate: string | Date | undefined;
    let search: string | undefined;

    if (typeof filtersOrFranchiseId === 'object' && filtersOrFranchiseId !== null) {
      franchiseId = filtersOrFranchiseId.franchiseId;
      itemName = filtersOrFranchiseId.itemName;
      itemId = filtersOrFranchiseId.itemId || filtersOrFranchiseId.productId;
      startDate = filtersOrFranchiseId.startDate;
      endDate = filtersOrFranchiseId.endDate;
      search = filtersOrFranchiseId.search || filtersOrFranchiseId.q;
    } else {
      franchiseId = filtersOrFranchiseId;
      itemName = itemNameArg;
      startDate = startDateArg;
      endDate = endDateArg;
      itemId = itemIdArg;
      search = searchArg;
    }

    const { start, end } = parseInclusiveDates(startDate, endDate);

    const itemWhere: any = { isActive: true };
    if (franchiseId) {
      itemWhere.OR = [
        { franchiseId },
        { franchiseId: null }
      ];
    }
    if (itemId) {
      itemWhere.id = itemId;
    } else if (itemName) {
      itemWhere.name = { contains: itemName, mode: 'insensitive' };
    }
    if (search) {
      itemWhere.AND = [
        ...(itemWhere.AND || []),
        {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } }
          ]
        }
      ];
    }

    const matchedItems = await prisma.inventoryItem.findMany({
      where: itemWhere,
      select: { id: true, name: true, sku: true, unit: true, currentStock: true }
    });

    const itemIds = matchedItems.map(i => i.id);

    if (itemIds.length === 0) {
      const emptyResult: any = [];
      emptyResult.summary = {
        openingQuantity: 0,
        beginningQuantity: 0,
        totalSaleQuantity: 0,
        totalPurchaseQuantity: 0,
        totalAdjustmentQuantity: 0,
        closingQuantity: 0,
        finalClosingQuantity: 0,
        totalMovements: 0,
        numberOfMovements: 0
      };
      emptyResult.data = [];
      emptyResult.items = [];
      emptyResult.movements = [];
      return emptyResult;
    }

    const purchaseTypes = ['PURCHASE_IN'];
    const saleTypes = ['SALES_OUT'];

    let priorBalance = 0;
    if (start) {
      const priorMovements = await prisma.stockMovement.findMany({
        where: {
          itemId: { in: itemIds },
          createdAt: { lt: start }
        },
        select: { movementType: true, quantity: true }
      });

      for (const m of priorMovements) {
        if (purchaseTypes.includes(m.movementType) || m.movementType === 'PRODUCTION_IN' || m.movementType === 'TRANSFER_IN' || m.movementType === 'RECALL_RETURN_IN') {
          priorBalance += Math.abs(m.quantity);
        } else if (saleTypes.includes(m.movementType) || m.movementType === 'PRODUCTION_OUT' || m.movementType === 'WASTE_OUT' || m.movementType === 'TRANSFER_OUT' || m.movementType === 'RETURN_OUT' || m.movementType === 'RETURN_QUARANTINE_IN') {
          priorBalance -= Math.abs(m.quantity);
        } else if (m.movementType === 'ADJUSTMENT') {
          priorBalance += m.quantity;
        } else {
          priorBalance += m.quantity;
        }
      }
    }

    const movements = await prisma.stockMovement.findMany({
      where: {
        itemId: { in: itemIds },
        ...(start || end ? {
          createdAt: {
            ...(start ? { gte: start } : {}),
            ...(end ? { lte: end } : {})
          }
        } : {})
      },
      include: {
        item: { select: { id: true, name: true, unit: true, sku: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    let runningBalance = priorBalance;
    let totalSaleQuantity = 0;
    let totalPurchaseQuantity = 0;
    let totalAdjustmentQuantity = 0;

    const data = movements.map(m => {
      let saleQty = 0;
      let purchaseQty = 0;
      let adjQty = 0;

      if (saleTypes.includes(m.movementType)) {
        saleQty = Math.abs(m.quantity);
        runningBalance -= saleQty;
        totalSaleQuantity += saleQty;
      } else if (purchaseTypes.includes(m.movementType)) {
        purchaseQty = Math.abs(m.quantity);
        runningBalance += purchaseQty;
        totalPurchaseQuantity += purchaseQty;
      } else if (m.movementType === 'ADJUSTMENT') {
        adjQty = m.quantity;
        runningBalance += adjQty;
        totalAdjustmentQuantity += adjQty;
      } else {
        adjQty = m.quantity;
        runningBalance += adjQty;
        totalAdjustmentQuantity += adjQty;
      }

      return {
        id: m.id,
        date: m.createdAt.toISOString(),
        transactionDate: m.createdAt.toISOString(),
        itemId: m.itemId,
        itemName: m.item?.name || '—',
        unit: m.item?.unit || 'PCS',
        movementType: m.movementType,
        saleQuantity: Number(saleQty.toFixed(2)),
        purchaseQuantity: Number(purchaseQty.toFixed(2)),
        adjustmentQuantity: Number(adjQty.toFixed(2)),
        closingQuantity: Number(runningBalance.toFixed(2)),
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        note: m.note
      };
    });

    const finalClosingQuantity = runningBalance;

    const summary = {
      openingQuantity: Number(priorBalance.toFixed(2)),
      beginningQuantity: Number(priorBalance.toFixed(2)),
      totalSaleQuantity: Number(totalSaleQuantity.toFixed(2)),
      totalPurchaseQuantity: Number(totalPurchaseQuantity.toFixed(2)),
      totalAdjustmentQuantity: Number(totalAdjustmentQuantity.toFixed(2)),
      closingQuantity: Number(finalClosingQuantity.toFixed(2)),
      finalClosingQuantity: Number(finalClosingQuantity.toFixed(2)),
      totalMovements: movements.length,
      numberOfMovements: movements.length
    };

    const result: any = data;
    result.summary = summary;
    result.items = data;
    result.data = data;
    result.movements = data;

    return result;
  }

  static async getBankStatementData(franchiseIdOrFilters?: any, accountIdParam?: string, startDateParam?: string, endDateParam?: string) {
    const { franchiseId, startDate, endDate, extra } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam);
    const accountId = typeof franchiseIdOrFilters === 'object' && franchiseIdOrFilters !== null ? franchiseIdOrFilters.accountId : (accountIdParam || extra?.accountId);
    const { start, end } = parseInclusiveDates(startDate, endDate);

    // 1. Fetch relevant Bank Account(s)
    const whereAccounts: any = { type: 'BANK', status: 'ACTIVE' };
    if (franchiseId) whereAccounts.franchiseId = franchiseId;
    if (accountId && accountId !== 'ALL' && accountId !== 'NONE' && accountId !== '') {
      whereAccounts.id = accountId;
    }

    const bankAccounts = await prisma.account.findMany({
      where: whereAccounts,
      orderBy: { name: 'asc' }
    });

    if (bankAccounts.length === 0) {
      return {
        data: [],
        summary: {
          openingBalance: 0,
          totalDeposits: 0,
          totalWithdrawals: 0,
          closingBalance: 0,
          totalTransactions: 0
        },
        openingBalance: 0,
        totalDeposits: 0,
        totalWithdrawals: 0,
        closingBalance: 0,
        totalTransactions: 0,
        accountName: 'No Bank Account Found'
      };
    }

    const targetAccountIds = bankAccounts.map(a => a.id);

    // 2. Fetch all non-cancelled payments for these bank accounts
    const allPayments = await prisma.payment.findMany({
      where: {
        accountId: { in: targetAccountIds },
        isCancelled: false,
        status: 'PAID'
      },
      include: {
        account: true,
        order: { include: { customer: true } },
        vendorInvoice: { include: { vendor: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    const getPaymentDirection = (p: any): 'IN' | 'OUT' => {
      if (p.entityType === 'CUSTOMER') return 'IN';
      if (p.entityType === 'VENDOR') return 'OUT';
      if (p.sourceModule === 'EXPENSE') return 'OUT';
      if (p.type === 'INTERNAL_TRANSFER') {
        if (p.paymentNumber && p.paymentNumber.endsWith('-IN')) return 'IN';
        return 'OUT';
      }
      return (p.flow === 'OUT' || p.flow === 'EXPENSE') ? 'OUT' : 'IN';
    };

    // Calculate initial base balance for each account before all historical payments
    const accountNetChange = new Map<string, number>();
    targetAccountIds.forEach(id => accountNetChange.set(id, 0));

    allPayments.forEach(p => {
      const accId = p.accountId || '';
      const dir = getPaymentDirection(p);
      const amt = Number(p.paidAmount || 0);
      const curr = accountNetChange.get(accId) || 0;
      accountNetChange.set(accId, curr + (dir === 'IN' ? amt : -amt));
    });

    const accountInitialBalance = new Map<string, number>();
    bankAccounts.forEach(acc => {
      const net = accountNetChange.get(acc.id) || 0;
      accountInitialBalance.set(acc.id, (acc.balance || 0) - net);
    });

    // Calculate opening balance per account at startDate
    const accountOpeningBalanceAtStart = new Map<string, number>();
    const accountRunningBalance = new Map<string, number>();

    bankAccounts.forEach(acc => {
      const initial = accountInitialBalance.get(acc.id) || 0;
      accountOpeningBalanceAtStart.set(acc.id, initial);
    });

    const priorPayments = start ? allPayments.filter(p => p.createdAt < start) : [];
    priorPayments.forEach(p => {
      const accId = p.accountId || '';
      const dir = getPaymentDirection(p);
      const amt = Number(p.paidAmount || 0);
      const curr = accountOpeningBalanceAtStart.get(accId) || 0;
      accountOpeningBalanceAtStart.set(accId, curr + (dir === 'IN' ? amt : -amt));
    });

    bankAccounts.forEach(acc => {
      accountRunningBalance.set(acc.id, accountOpeningBalanceAtStart.get(acc.id) || 0);
    });

    let totalOpeningBalance = 0;
    bankAccounts.forEach(acc => {
      totalOpeningBalance += accountOpeningBalanceAtStart.get(acc.id) || 0;
    });

    // Filter payments within the active period
    const periodPayments = allPayments.filter(p => {
      if (start && p.createdAt < start) return false;
      if (end && p.createdAt > end) return false;
      return true;
    });

    let totalDeposits = 0;
    let totalWithdrawals = 0;

    const data = periodPayments.map(p => {
      const accId = p.accountId || '';
      const dir = getPaymentDirection(p);
      const amt = Number(p.paidAmount || 0);
      const deposit = dir === 'IN' ? amt : 0;
      const withdrawal = dir === 'OUT' ? amt : 0;

      totalDeposits += deposit;
      totalWithdrawals += withdrawal;

      // Update account-specific running balance
      const currentAccBal = (accountRunningBalance.get(accId) || 0) + (deposit - withdrawal);
      accountRunningBalance.set(accId, currentAccBal);

      let description = '';
      if (p.entityType === 'CUSTOMER') {
        const custName = p.order?.customer?.name || p.order?.customerName || (p.entityId ? 'Customer' : 'Walk-in Customer');
        description = p.order?.invoiceNum ? `Customer Receipt - ${custName} (${p.order.invoiceNum})` : `Customer Receipt - ${custName}`;
      } else if (p.entityType === 'VENDOR') {
        const vendName = p.vendorInvoice?.vendor?.name || 'Vendor';
        description = p.vendorInvoice?.invoiceNumber ? `Vendor Payment - ${vendName} (${p.vendorInvoice.invoiceNumber})` : `Vendor Payment - ${vendName}`;
      } else if (p.sourceModule === 'EXPENSE') {
        description = p.transactionRef || 'Expense Payment';
      } else {
        description = p.transactionRef || p.paymentNumber || 'Bank Transaction';
      }

      const reference = p.paymentNumber || p.transactionRef || (p.linkedDocId ? `DOC-${p.linkedDocId.slice(0, 8)}` : '—');

      return {
        id: p.id,
        date: p.createdAt.toISOString(),
        transactionDate: p.createdAt.toISOString(),
        accountName: p.account?.name || 'Bank',
        accountId: p.accountId,
        description,
        particulars: description,
        reference,
        refNo: reference,
        referenceNo: reference,
        paymentNumber: p.paymentNumber,
        paymentMode: p.paymentMode,
        method: p.paymentMode,
        type: dir === 'IN' ? 'DEPOSIT' : 'WITHDRAWAL',
        flow: dir,
        debit: withdrawal,
        credit: deposit,
        withdrawal: withdrawal,
        deposit: deposit,
        withdrawalAmount: withdrawal,
        depositAmount: deposit,
        debitAmount: withdrawal,
        creditAmount: deposit,
        balance: Number(currentAccBal.toFixed(2)),
        balanceAmount: Number(currentAccBal.toFixed(2)),
        runningBalance: Number(currentAccBal.toFixed(2)),
        accountBalance: Number(currentAccBal.toFixed(2))
      };
    });

    let totalClosingBalance = 0;
    bankAccounts.forEach(acc => {
      totalClosingBalance += accountRunningBalance.get(acc.id) || 0;
    });

    totalOpeningBalance = Number(totalOpeningBalance.toFixed(2));
    totalDeposits = Number(totalDeposits.toFixed(2));
    totalWithdrawals = Number(totalWithdrawals.toFixed(2));
    totalClosingBalance = Number(totalClosingBalance.toFixed(2));

    const summary = {
      openingBalance: totalOpeningBalance,
      totalDeposits,
      totalWithdrawals,
      closingBalance: totalClosingBalance,
      totalTransactions: data.length
    };

    return {
      data,
      summary,
      openingBalance: totalOpeningBalance,
      totalDeposits,
      totalWithdrawals,
      closingBalance: totalClosingBalance,
      totalTransactions: data.length,
      accountName: bankAccounts.length === 1 ? bankAccounts[0].name : 'All Bank Accounts'
    };
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

    const sellerStates = await resolveSellerStatesFor(orders.map((o) => o.franchiseId));

    const toRow = (o: any) => {
      const split = splitGstAmount(o.taxAmount || 0, o.stateOfSupply, sellerStates.get(o.franchiseId) ?? null);
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
    // The Purchase Bill's own billDate is the GST-reporting date — not
    // createdAt (when the row was inserted, which can lag the bill's real
    // date). PurchaseReturn has no equivalent separate date field, so debit
    // notes below still filter on createdAt.
    const billDateFilter = buildBillDateFilter(startDate, endDate);
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
        ...billDateFilter
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
        // No placeOfSupply field is persisted anywhere for purchases (unlike
        // Order.stateOfSupply on the sales side) — the vendor's own master
        // state is the closest real, non-fabricated stand-in.
        placeOfSupply: inv.vendor?.state || '—',
        taxableValue,
        taxRate: taxableValue > 0 ? Number(((totalTax / taxableValue) * 100).toFixed(2)) : 0,
        igst: inv.igst || 0,
        cgst: inv.cgst || 0,
        sgst: inv.sgst || 0,
        // No cess field exists on VendorInvoice — 0 honestly reports "not
        // tracked," not a fabricated non-zero figure.
        cessAmount: 0,
        // No reverse-charge flag/config exists anywhere in this schema.
        // Defaulting to 'N' is the correct GST default (RCM is the
        // exception, not the rule, absent an explicit marking) — this must
        // never default to 'Y', which would be fabricating a compliance
        // classification with real legal weight.
        reverseCharge: 'N',
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
    const billDateFilter = buildBillDateFilter(startDate, endDate);

    const [orders, purchasesAgg, creditNoteAgg, debitNoteAgg] = await Promise.all([
      prisma.order.findMany({
        where: finalSaleWhere({ ...(franchiseId ? { franchiseId } : {}), ...dateFilter }),
        select: { subTotal: true, taxAmount: true, totalAmount: true, stateOfSupply: true, franchiseId: true }
      }),
      prisma.vendorInvoice.aggregate({
        where: {
          procurementOrder: { ...(franchiseId ? { franchiseId } : {}), status: { not: 'CANCELLED' as any } },
          ...billDateFilter
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

    const sellerStates = await resolveSellerStatesFor(orders.map((o) => o.franchiseId));

    let outputTaxable = 0;
    let outputTax = 0;
    let outputIgst = 0;
    let outputCgst = 0;
    let outputSgst = 0;

    orders.forEach(o => {
      outputTaxable += o.subTotal || 0;
      const t = o.taxAmount || 0;
      outputTax += t;
      const split = splitGstAmount(t, o.stateOfSupply, sellerStates.get(o.franchiseId) ?? null);
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
    // "Eligible ITC" has only one modeled bucket here — every Purchase
    // Bill's persisted CGST/SGST/IGST, under "All other ITC" — because
    // nothing in the schema classifies ITC into import-of-goods/services,
    // reverse-charge, ISD, or ineligible/blocked credit. Do not split this
    // into those categories without a real field to back them.
    const inputCgst = (purchasesAgg._sum.cgst || 0) - (debitNoteAgg._sum.cgst || 0);
    const inputSgst = (purchasesAgg._sum.sgst || 0) - (debitNoteAgg._sum.sgst || 0);
    const inputIgst = (purchasesAgg._sum.igst || 0) - (debitNoteAgg._sum.igst || 0);
    const totalInputTax = inputCgst + inputSgst + inputIgst;

    // Net GST Payable per statutory component-wise ITC utilization (IGST
    // ITC -> IGST -> CGST -> SGST liability; CGST ITC -> CGST -> IGST only;
    // SGST ITC -> SGST -> IGST only) — never a flat total-minus-total, which
    // would implicitly allow invalid CGST<->SGST cross-utilization.
    const utilization = computeGstUtilization(
      { cgst: outputCgst, sgst: outputSgst, igst: outputIgst },
      { cgst: inputCgst, sgst: inputSgst, igst: inputIgst }
    );

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
      netGstLiability: {
        cgst: utilization.netCgst,
        sgst: utilization.netSgst,
        igst: utilization.netIgst
      },
      summary: {
        totalOutputTax: Number(outputTax.toFixed(2)),
        totalInputTax: Number(totalInputTax.toFixed(2)),
        netGstPayable: utilization.netTotal
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

    const [orders, purchasesAgg, creditNoteAgg, debitNoteAgg] = await Promise.all([
      prisma.order.findMany({
        where: finalSaleWhere({ ...(franchiseId ? { franchiseId } : {}), createdAt: { gte: fyStart, lte: fyEnd } }),
        select: { subTotal: true, taxAmount: true, stateOfSupply: true, franchiseId: true, customer: { select: { gstNumber: true } } }
      }),
      prisma.vendorInvoice.aggregate({
        where: {
          procurementOrder: { ...(franchiseId ? { franchiseId } : {}), status: { not: 'CANCELLED' as any } },
          ...buildBillDateFilter(fyStart, fyEnd)
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

    const sellerStates = await resolveSellerStatesFor(orders.map((o) => o.franchiseId));

    // B2B (customer has a real GSTIN on file) vs B2C (unregistered) — same
    // classification GSTR-1 already uses, not re-derived differently here.
    const b2b = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
    const b2c = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
    orders.forEach((o) => {
      const isB2B = Boolean(o.customer?.gstNumber && o.customer.gstNumber.trim() !== '');
      const bucket = isB2B ? b2b : b2c;
      bucket.taxableValue += o.subTotal || 0;
      const split = splitGstAmount(o.taxAmount || 0, o.stateOfSupply, sellerStates.get(o.franchiseId) ?? null);
      bucket.cgst += split.cgst;
      bucket.sgst += split.sgst;
      bucket.igst += split.igst;
    });

    const creditDebitAdj = {
      taxableValue: -(creditNoteAgg._sum.taxableValue || 0),
      cgst: -(creditNoteAgg._sum.cgst || 0),
      sgst: -(creditNoteAgg._sum.sgst || 0),
      igst: -(creditNoteAgg._sum.igst || 0),
    };

    const totalOutward = {
      taxableValue: b2b.taxableValue + b2c.taxableValue + creditDebitAdj.taxableValue,
      cgst: b2b.cgst + b2c.cgst + creditDebitAdj.cgst,
      sgst: b2b.sgst + b2c.sgst + creditDebitAdj.sgst,
      igst: b2b.igst + b2c.igst + creditDebitAdj.igst,
    };
    const outputTax = totalOutward.cgst + totalOutward.sgst + totalOutward.igst;

    // Eligible ITC — one modeled bucket (no eligibility/RCM classification
    // exists anywhere in the schema, so nothing here is split into
    // "reverse charge" vs "normal" ITC; the previous version of this report
    // mislabeled every ordinary Purchase Bill as reverse-charge inward
    // supply, which was simply wrong, not a real RCM classification).
    const itc = {
      taxableValue: (purchasesAgg._sum.subtotal || 0) - (debitNoteAgg._sum.taxableValue || 0),
      cgst: (purchasesAgg._sum.cgst || 0) - (debitNoteAgg._sum.cgst || 0),
      sgst: (purchasesAgg._sum.sgst || 0) - (debitNoteAgg._sum.sgst || 0),
      igst: (purchasesAgg._sum.igst || 0) - (debitNoteAgg._sum.igst || 0),
    };
    const inputTax = itc.cgst + itc.sgst + itc.igst;

    const utilization = computeGstUtilization(
      { cgst: totalOutward.cgst, sgst: totalOutward.sgst, igst: totalOutward.igst },
      { cgst: itc.cgst, sgst: itc.sgst, igst: itc.igst }
    );

    const round = (n: number) => Number((n || 0).toFixed(2));
    const round4 = (r: { taxableValue: number; cgst: number; sgst: number; igst: number }) => ({
      taxableValue: round(r.taxableValue), cgst: round(r.cgst), sgst: round(r.sgst), igst: round(r.igst), cess: 0
    });

    return {
      financialYear: fy,
      outwardSupplies: [
        { category: 'B2B Sales', ...round4(b2b) },
        { category: 'B2C Sales', ...round4(b2c) },
        { category: 'Credit/Debit Note Adjustments', ...round4(creditDebitAdj) },
        { category: 'Total Outward Supplies', ...round4(totalOutward) }
      ],
      itcSummary: {
        ...round4(itc),
        total: round(inputTax)
      },
      reconciliation: {
        totalOutputGst: round(outputTax),
        eligibleItc: round(inputTax),
        netGstPayable: utilization.netTotal
      },
      summary: {
        totalOutputTax: round(outputTax),
        totalInputTax: round(inputTax),
        netTaxPayable: utilization.netTotal
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
        orderItems: { include: { product: true } }
      }
    });

    const sellerStates = await resolveSellerStatesFor(orders.map((o) => o.franchiseId));

    const invItems = await prisma.inventoryItem.findMany({ select: { id: true, sku: true, name: true, hsnCode: true } });
    const invBySku = new Map<string, string>();
    const invByName = new Map<string, string>();
    for (const inv of invItems) {
      if (inv.sku && inv.hsnCode) invBySku.set(inv.sku, inv.hsnCode);
      if (inv.name && inv.hsnCode) invByName.set(inv.name.toLowerCase().trim(), inv.hsnCode);
    }

    const hsnMap: Record<string, {
      hsn: string; productName: string; unit: string; gstRate: number; quantity: number;
      totalValue: number; taxableValue: number;
      igstAmount: number; cgstAmount: number; sgstAmount: number;
    }> = {};

    orders.forEach(o => {
      const orderSubTotal = o.subTotal || 0;
      const orderTax = o.taxAmount || 0;
      const franchiseLocation = sellerStates.get(o.franchiseId) ?? null;

      const goodsItems = o.orderItems.filter((item) => item.product?.productType !== 'SERVICE');
      const orderTotalGross = goodsItems.reduce((sum, it) => sum + (it.quantity || 0) * (it.price || 0), 0);

      goodsItems.forEach(item => {
        let hsn: string | null | undefined = item.product?.hsnCode;
        if (!hsn && item.product?.sku && invBySku.has(item.product.sku)) {
          hsn = invBySku.get(item.product.sku);
        }
        if (!hsn && item.product?.name && invByName.has(item.product.name.toLowerCase().trim())) {
          hsn = invByName.get(item.product.name.toLowerCase().trim());
        }
        hsn = hsn || 'NA';

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

        const lineGross = (item.quantity || 0) * (item.price || 0);
        let lineTaxable = lineGross;

        // item.totalAmount is NOT a reliable "tax-inclusive line total" —
        // its meaning differs by which flow created the OrderItem row: the
        // Tax Invoice / quotation-conversion flows persist taxable+tax
        // (inclusive), but POS's addItemsToOrder persists price*quantity
        // (tax-exclusive, identical to lineGross). Subtracting taxAmount
        // from it there double-deducts GST and understated every
        // POS-sourced HSN row by exactly its tax amount (₹105 taxable
        // showing as ₹99.75). quantity*price is the one value every
        // creation path agrees is tax-exclusive, so it — net of whichever
        // discount actually applies — is the only safe taxable-value basis.
        if (item.discountPct && item.discountPct > 0) {
          const lineDiscount = Number(((lineGross * item.discountPct) / 100).toFixed(2));
          lineTaxable = Math.max(0, lineGross - lineDiscount);
        } else if (o.discountAmount && o.discountAmount > 0 && orderTotalGross > 0) {
          const discountRatio = lineGross / orderTotalGross;
          const lineDiscount = Number(((o.discountAmount || 0) * discountRatio).toFixed(2));
          lineTaxable = Math.max(0, lineGross - lineDiscount);
        }

        // The persisted per-line taxAmount is trustworthy in every creation
        // path (it's always the real GST computed on that line at save
        // time) — trust it directly instead of re-deriving GST from a
        // taxable value that may be discount-adjusted differently.
        let lineTax: number;
        if (typeof item.taxAmount === 'number' && item.taxAmount > 0) {
          lineTax = item.taxAmount;
        } else if (orderSubTotal > 0 && orderTax > 0) {
          lineTax = Number(((lineTaxable / orderSubTotal) * orderTax).toFixed(2));
        } else {
          lineTax = Number(((lineTaxable * (item.product?.taxPercent || 0)) / 100).toFixed(2));
        }

        const lineTotal = Number((lineTaxable + lineTax).toFixed(2));
        const split = splitGstAmount(lineTax, o.stateOfSupply, franchiseLocation);

        hsnMap[key].quantity += item.quantity || 0;
        hsnMap[key].taxableValue += lineTaxable;
        hsnMap[key].igstAmount += split.igst;
        hsnMap[key].cgstAmount += split.cgst;
        hsnMap[key].sgstAmount += split.sgst;
        hsnMap[key].totalValue += lineTotal;
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
      include: { orderItems: { include: { product: true } } },
      orderBy: { createdAt: 'desc' }
    });

    const sellerStates = await resolveSellerStatesFor(orders.map((o) => o.franchiseId));

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
        const split = splitGstAmount(lineTax, o.stateOfSupply, sellerStates.get(o.franchiseId) ?? null);

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

  static async getSalePurchaseByCategoryData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string, categoryParam?: string): Promise<any> {
    const { franchiseId, startDate, endDate, category: filterCategory } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam, categoryParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter = (start || end) ? {
      createdAt: {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      }
    } : {};

    const [orders, purchases] = await Promise.all([
      prisma.order.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          ...finalSaleWhere(dateFilter)
        },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { notIn: ['CANCELLED'] as any },
          ...dateFilter
        },
        include: {
          poItems: { include: { inventoryItem: true } },
          // Purchase value must reflect what was actually received
          // (GoodsReceiptItem.price), not the PO's ordered price — see
          // getItemWiseProfitLoss for the same fix and rationale.
          goodsReceipts: {
            where: { status: 'COMPLETED' },
            include: { items: { include: { inventoryItem: true } } }
          }
        }
      })
    ]);

    interface CategoryAgg {
      category: string;
      categoryName: string;
      saleQty: number;
      saleQuantity: number;
      saleAmount: number;
      purchaseQty: number;
      purchaseQuantity: number;
      purchaseAmount: number;
      grossMargin: number;
    }

    const categoryMap: Record<string, CategoryAgg> = {};

    const getOrCreate = (cat: string) => {
      const key = cat || 'Uncategorized';
      if (!categoryMap[key]) {
        categoryMap[key] = {
          category: key,
          categoryName: key,
          saleQty: 0,
          saleQuantity: 0,
          saleAmount: 0,
          purchaseQty: 0,
          purchaseQuantity: 0,
          purchaseAmount: 0,
          grossMargin: 0
        };
      }
      return categoryMap[key];
    };

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const cat = item.product?.category || 'Uncategorized';
        if (filterCategory && cat.toLowerCase() !== filterCategory.toLowerCase()) return;
        const agg = getOrCreate(cat);
        const qty = item.quantity || 0;
        const amt = item.totalAmount || (qty * (item.price || 0));
        agg.saleQty += qty;
        agg.saleQuantity += qty;
        agg.saleAmount += amt;
      });
    });

    purchases.forEach(p => {
      p.goodsReceipts.forEach(grn => {
        grn.items.forEach(item => {
          if (!item.acceptedQty) return;
          const poItem = p.poItems.find(pi => pi.inventoryItemId === item.materialId);
          const cat = item.inventoryItem?.category || poItem?.inventoryItem?.category || 'Uncategorized';
          if (filterCategory && cat.toLowerCase() !== filterCategory.toLowerCase()) return;
          const agg = getOrCreate(cat);
          const qty = item.acceptedQty || 0;
          const amt = qty * (item.price || 0);
          agg.purchaseQty += qty;
          agg.purchaseQuantity += qty;
          agg.purchaseAmount += amt;
        });
      });
    });

    const data = Object.values(categoryMap).map(r => ({
      ...r,
      saleQty: Number(r.saleQty.toFixed(2)),
      saleQuantity: Number(r.saleQuantity.toFixed(2)),
      saleAmount: Number(r.saleAmount.toFixed(2)),
      purchaseQty: Number(r.purchaseQty.toFixed(2)),
      purchaseQuantity: Number(r.purchaseQuantity.toFixed(2)),
      purchaseAmount: Number(r.purchaseAmount.toFixed(2)),
      grossMargin: Number((r.saleAmount - r.purchaseAmount).toFixed(2))
    }));

    const totalSaleQty = data.reduce((s, r) => s + r.saleQty, 0);
    const totalSaleAmount = data.reduce((s, r) => s + r.saleAmount, 0);
    const totalPurchaseQty = data.reduce((s, r) => s + r.purchaseQty, 0);
    const totalPurchaseAmount = data.reduce((s, r) => s + r.purchaseAmount, 0);

    const summary = {
      totalSaleQty: Number(totalSaleQty.toFixed(2)),
      totalSaleQuantity: Number(totalSaleQty.toFixed(2)),
      totalSaleAmount: Number(totalSaleAmount.toFixed(2)),
      totalPurchaseQty: Number(totalPurchaseQty.toFixed(2)),
      totalPurchaseQuantity: Number(totalPurchaseQty.toFixed(2)),
      totalPurchaseAmount: Number(totalPurchaseAmount.toFixed(2)),
      totalGrossMargin: Number((totalSaleAmount - totalPurchaseAmount).toFixed(2)),
      categoryCount: data.length
    };

    const result: any = data;
    result.summary = summary;
    result.categories = data;
    result.data = data;

    return result;
  }

  static async getStockByCategoryData(franchiseIdOrFilters?: any, categoryParam?: string): Promise<any> {
    let franchiseId: string | undefined;
    let category: string | undefined;
    let search: string | undefined;

    if (typeof franchiseIdOrFilters === 'object' && franchiseIdOrFilters !== null) {
      franchiseId = franchiseIdOrFilters.franchiseId;
      category = franchiseIdOrFilters.category || categoryParam;
      search = franchiseIdOrFilters.search || franchiseIdOrFilters.q;
    } else {
      franchiseId = franchiseIdOrFilters;
      category = categoryParam;
    }

    const where: any = { isActive: true };
    if (franchiseId) {
      where.OR = [
        { franchiseId },
        { franchiseId: null }
      ];
    }
    if (category && category !== 'ALL' && category !== '') {
      where.category = category.toUpperCase();
    }
    if (search) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { sku: { contains: search, mode: 'insensitive' } },
            { category: { contains: search, mode: 'insensitive' } }
          ]
        }
      ];
    }

    const items = await prisma.inventoryItem.findMany({
      where,
      orderBy: { category: 'asc' }
    });

    interface CatAgg {
      category: string;
      categoryName: string;
      itemCount: number;
      totalItem: number;
      totalItems: number;
      uniqueItemCount: number;
      totalStock: number;
      stockQuantity: number;
      totalValue: number;
      stockValue: number;
    }

    const categoryMap: Record<string, CatAgg> = {};

    items.forEach(item => {
      const cat = item.category || 'Uncategorized';
      if (!categoryMap[cat]) {
        categoryMap[cat] = {
          category: cat,
          categoryName: cat,
          itemCount: 0,
          totalItem: 0,
          totalItems: 0,
          uniqueItemCount: 0,
          totalStock: 0,
          stockQuantity: 0,
          totalValue: 0,
          stockValue: 0
        };
      }
      const currentStock = item.currentStock || 0;
      const costPrice = item.costPrice || 0;
      categoryMap[cat].itemCount += 1;
      categoryMap[cat].totalItem += 1;
      categoryMap[cat].totalItems += 1;
      categoryMap[cat].uniqueItemCount += 1;
      categoryMap[cat].totalStock += currentStock;
      categoryMap[cat].stockQuantity += currentStock;
      categoryMap[cat].totalValue += currentStock * costPrice;
      categoryMap[cat].stockValue += currentStock * costPrice;
    });

    const data = Object.values(categoryMap).map(r => ({
      ...r,
      totalStock: Number(r.totalStock.toFixed(2)),
      stockQuantity: Number(r.stockQuantity.toFixed(2)),
      totalValue: Number(r.totalValue.toFixed(2)),
      stockValue: Number(r.stockValue.toFixed(2))
    }));

    const totalItem = items.length;
    const totalStock = data.reduce((s, r) => s + r.totalStock, 0);
    const totalValue = data.reduce((s, r) => s + r.totalValue, 0);

    const summary = {
      totalItem,
      totalItems: totalItem,
      totalItemCount: totalItem,
      uniqueItemCount: totalItem,
      itemCount: totalItem,
      totalStock: Number(totalStock.toFixed(2)),
      totalStockQuantity: Number(totalStock.toFixed(2)),
      stockQuantity: Number(totalStock.toFixed(2)),
      totalValue: Number(totalValue.toFixed(2)),
      totalStockValue: Number(totalValue.toFixed(2)),
      stockValue: Number(totalValue.toFixed(2)),
      categoryCount: data.length
    };

    const result: any = data;
    result.summary = summary;
    result.categories = data;
    result.data = data;

    return result;
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
    const { franchiseId, startDate, endDate, category } = normalizeReportFilters(franchiseIdOrFilters, startDateParam, endDateParam, categoryParam);
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const where: any = {
      ...(franchiseId ? { franchiseId } : {}),
      isCancelled: false,
      purchaseOrderId: { not: null }
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
      include: { 
        purchaseOrder: {
          include: {
            poItems: { include: { inventoryItem: true } }
          }
        }
      },
      orderBy: { date: 'desc' }
    });

    const items: any[] = [];
    for (const exp of expenses) {
      if (exp.purchaseOrder && (exp.purchaseOrder as any).poItems) {
        for (const item of (exp.purchaseOrder as any).poItems) {
          items.push({
            id: item.id || Math.random().toString(),
            date: exp.date,
            expenseNumber: exp.expenseNumber,
            category: exp.category,
            expenseItem: item.inventoryItem?.name || item.itemName || 'Unknown Item',
            quantity: item.quantity,
            unitRate: item.price,
            amount: item.total || (item.quantity * item.price)
          });
        }
      }
    }

    return { expenses: items };
  }

  static async getSalePurchaseByPartyGroupData(franchiseId: string, startDate?: string, endDate?: string) {
    const parties = await this.getSalePurchaseByParty({
      franchiseId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined
    });

    const groupMap: Record<string, { groupName: string; totalSale: number; totalPurchase: number; net: number }> = {};
    const getGroup = (name: string) => {
      if (!groupMap[name]) groupMap[name] = { groupName: name, totalSale: 0, totalPurchase: 0, net: 0 };
      return groupMap[name];
    };

    for (const party of parties) {
      const group = getGroup(party.partyType);
      group.totalSale += party.totalSale;
      group.totalPurchase += party.totalPurchase;
      group.net += party.net;
    }

    return Object.values(groupMap).filter(r => r.totalSale !== 0 || r.totalPurchase !== 0);
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
        payments: { select: { paidAmount: true, isCancelled: true, status: true } },
        // See sumOrderPaidWithAllocations — a multi-invoice receipt's share
        // of this order lives here, not in `payments` (that Payment's
        // orderId is null), and was previously invisible to this aggregate,
        // which could leave an already-fully-paid invoice showing as due.
        invoice: { select: { allocations: { select: { amount: true, payment: { select: { status: true, isCancelled: true } } } } } }
      }
    });

    // key = `${partyType}:${partyId}`
    const balances = new Map<string, number>();
    for (const o of orders) {
      const resolvedType = o.partyType || 'CUSTOMER';
      const resolvedId = resolvedType === 'CUSTOMER' ? o.customerId : o.partyId;
      if (!resolvedId) continue; // No real master-table row for this party (Walk-in etc) — not trackable.
      if (partyType && resolvedType !== partyType) continue;

      const paid = this.sumOrderPaidWithAllocations(
        o.payments,
        o.invoice?.allocations,
        (p) => !p.isCancelled && p.status !== 'CANCELLED'
      );
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
        payments: { include: { account: true }, orderBy: { createdAt: 'asc' } },
        // A multi-invoice receipt's share of this order lives here, not in
        // `payments` (that Payment's orderId is null) — see
        // sumOrderPaidWithAllocations. Also merged into the returned
        // `payments` history below so it's visible there too, not just in
        // the paid/balance/status summary.
        invoice: { select: { allocations: { include: { payment: { include: { account: true } } } } } }
      },
      orderBy: { createdAt: 'desc' }
    });

    return orders.map((o) => {
      const isValid = (p: { isCancelled: boolean; status: string }) => !p.isCancelled && p.status !== 'CANCELLED';
      const paid = Number(
        this.sumOrderPaidWithAllocations(o.payments, o.invoice?.allocations, isValid).toFixed(2)
      );
      const rawBalance = Number(((o.totalAmount || 0) - paid).toFixed(2));
      const balance = rawBalance < 0 ? 0 : rawBalance;
      const status: 'PAID' | 'PARTIAL' | 'UNPAID' = balance <= 0.01 ? 'PAID' : (paid > 0 ? 'PARTIAL' : 'UNPAID');

      const allocationPaymentRows = (o.invoice?.allocations || []).map((a) => ({
        paymentNumber: a.payment.paymentNumber || '—',
        date: a.payment.createdAt,
        method: a.payment.paymentMode,
        account: a.payment.account?.name || 'Unknown',
        amount: a.amount,
        isCancelled: a.payment.isCancelled,
        status: a.payment.status
      }));

      return {
        orderId: o.id, // Internal key only — never render this in the UI, render invoiceNumber instead.
        invoiceNumber: o.invoiceNum,
        createdAt: o.createdAt,
        invoiceTotal: o.totalAmount,
        paidAmount: paid,
        balance,
        status,
        payments: [
          ...o.payments.map((p) => ({
            paymentNumber: p.paymentNumber || '—',
            date: p.createdAt,
            method: p.paymentMode,
            account: p.account?.name || 'Unknown',
            amount: p.paidAmount,
            isCancelled: p.isCancelled,
            status: p.status
          })),
          ...allocationPaymentRows
        ]
      };
    });
  }

  static async getAllPartiesData(
    franchiseId?: string,
    startDate?: string,
    endDate?: string,
    opts?: { partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE' | 'ALL'; search?: string; datasetType?: 'RECEIVABLE' | 'PAYABLE' }
  ) {
    const { start, end } = parseInclusiveDates(startDate, endDate);
    const dateFilter: any = {};
    if (start || end) {
      dateFilter.createdAt = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
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

  static async getSalePurchaseByItemData(franchiseIdOrFilters?: any, startDateParam?: string, endDateParam?: string): Promise<any> {
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
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          ...finalSaleWhere(dateFilter)
        },
        include: { orderItems: { include: { product: true } } }
      }),
      prisma.procurementOrder.findMany({
        where: {
          ...(franchiseId ? { franchiseId } : {}),
          status: { notIn: ['CANCELLED'] as any },
          ...dateFilter
        },
        include: {
          poItems: { include: { inventoryItem: true } },
          // Purchase value must reflect what was actually received
          // (GoodsReceiptItem.price), not the PO's ordered price — see
          // getItemWiseProfitLoss for the same fix and rationale.
          goodsReceipts: {
            where: { status: 'COMPLETED' },
            include: { items: { include: { inventoryItem: true } } }
          }
        }
      })
    ]);

    const itemMap: Record<string, { itemName: string; category: string; saleQty: number; saleQuantity: number; saleAmount: number; purchaseQty: number; purchaseQuantity: number; purchaseAmount: number; grossMargin: number }> = {};

    orders.forEach(o => {
      o.orderItems.forEach(item => {
        const name = item.product?.name || 'Unknown Item';
        const category = item.product?.category || 'General';
        if (!itemMap[name]) {
          itemMap[name] = {
            itemName: name,
            category,
            saleQty: 0,
            saleQuantity: 0,
            saleAmount: 0,
            purchaseQty: 0,
            purchaseQuantity: 0,
            purchaseAmount: 0,
            grossMargin: 0
          };
        }
        const qty = item.quantity || 0;
        const amt = item.totalAmount || (qty * (item.price || 0));
        itemMap[name].saleQty += qty;
        itemMap[name].saleQuantity += qty;
        itemMap[name].saleAmount += amt;
      });
    });

    purchases.forEach(p => {
      p.goodsReceipts.forEach(grn => {
        grn.items.forEach(item => {
          if (!item.acceptedQty) return;
          const poItem = p.poItems.find(pi => pi.inventoryItemId === item.materialId);
          const name = item.inventoryItem?.name || poItem?.itemName || 'Unknown Item';
          const category = item.inventoryItem?.category || poItem?.inventoryItem?.category || 'Raw Material';
          if (!itemMap[name]) {
            itemMap[name] = {
              itemName: name,
              category,
              saleQty: 0,
              saleQuantity: 0,
              saleAmount: 0,
              purchaseQty: 0,
              purchaseQuantity: 0,
              purchaseAmount: 0,
              grossMargin: 0
            };
          }
          const qty = item.acceptedQty || 0;
          const amt = qty * (item.price || 0);
          itemMap[name].purchaseQty += qty;
          itemMap[name].purchaseQuantity += qty;
          itemMap[name].purchaseAmount += amt;
        });
      });
    });

    const data = Object.values(itemMap).map(r => ({
      ...r,
      saleQty: Number(r.saleQty.toFixed(2)),
      saleQuantity: Number(r.saleQuantity.toFixed(2)),
      saleAmount: Number(r.saleAmount.toFixed(2)),
      purchaseQty: Number(r.purchaseQty.toFixed(2)),
      purchaseQuantity: Number(r.purchaseQuantity.toFixed(2)),
      purchaseAmount: Number(r.purchaseAmount.toFixed(2)),
      grossMargin: Number((r.saleAmount - r.purchaseAmount).toFixed(2))
    }));

    const totalSaleQty = data.reduce((s, r) => s + r.saleQty, 0);
    const totalSaleAmount = data.reduce((s, r) => s + r.saleAmount, 0);
    const totalPurchaseQty = data.reduce((s, r) => s + r.purchaseQty, 0);
    const totalPurchaseAmount = data.reduce((s, r) => s + r.purchaseAmount, 0);

    const summary = {
      totalSaleQty: Number(totalSaleQty.toFixed(2)),
      totalSaleQuantity: Number(totalSaleQty.toFixed(2)),
      totalSaleAmount: Number(totalSaleAmount.toFixed(2)),
      totalPurchaseQty: Number(totalPurchaseQty.toFixed(2)),
      totalPurchaseQuantity: Number(totalPurchaseQty.toFixed(2)),
      totalPurchaseAmount: Number(totalPurchaseAmount.toFixed(2)),
      totalGrossMargin: Number((totalSaleAmount - totalPurchaseAmount).toFixed(2)),
      itemCount: data.length
    };

    const result: any = data;
    result.summary = summary;
    result.items = data;
    result.data = data;

    return result;
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

  static async getSaleOrdersReportData(filters: { franchiseId?: string; startDate?: string; endDate?: string; status?: string; search?: string; customerId?: string }) {
    const { start, end } = parseInclusiveDates(filters.startDate, filters.endDate);

    const where: any = {};
    if (filters.status && filters.status !== 'ALL' && filters.status !== '') {
      where.status = filters.status;
    }
    if (filters.customerId) {
      where.customerId = filters.customerId;
    }
    if (start || end) {
      where.createdAt = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lte: end } : {})
      };
    }
    if (filters.franchiseId) {
      where.OR = [
        { customer: { franchiseId: filters.franchiseId } },
        { customerId: null }
      ];
    }
    if (filters.search) {
      where.OR = [
        ...(where.OR || []),
        { orderNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } },
        { customer: { name: { contains: filters.search, mode: 'insensitive' } } }
      ];
    }

    const salesOrders = await prisma.salesOrder.findMany({
      where,
      include: {
        customer: true,
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const sellerStates = await resolveSellerStatesFor(
      salesOrders.map(so => so.customer?.franchiseId || filters.franchiseId).filter(Boolean) as string[]
    );

    let totalSalesOrderValue = 0;
    let totalSubTotal = 0;
    let totalTax = 0;
    let totalDiscount = 0;
    let totalTaxableValue = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    let totalRoundOff = 0;

    let draftOrderCount = 0;
    let pendingOrderCount = 0;
    let confirmedOrderCount = 0;
    let processingOrderCount = 0;
    let shippedOrderCount = 0;
    let deliveredOrderCount = 0;
    let cancelledOrderCount = 0;
    let openOrderCount = 0;

    let confirmedOrderValue = 0;
    let draftOrderValue = 0;
    let cancelledOrderValue = 0;

    const data = salesOrders.map(so => {
      const status = so.status;
      const isCancelled = status === 'CANCELLED';
      const isDraft = status === 'DRAFT';
      const isPending = status === 'PENDING';
      const isConfirmed = status === 'CONFIRMED';
      const isProcessing = status === 'PROCESSING';
      const isShipped = status === 'SHIPPED';
      const isDelivered = status === 'DELIVERED';
      const isOpen = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'PENDING'].includes(status);

      if (isDraft) draftOrderCount++;
      if (isPending) pendingOrderCount++;
      if (isConfirmed) confirmedOrderCount++;
      if (isProcessing) processingOrderCount++;
      if (isShipped) shippedOrderCount++;
      if (isDelivered) deliveredOrderCount++;
      if (isCancelled) cancelledOrderCount++;
      if (isOpen) openOrderCount++;

      const subTotal = so.subTotal || 0;
      const discountAmount = so.discountAmount || 0;
      const taxableValue = subTotal;
      const taxAmount = so.taxAmount || 0;
      const calculatedTotal = taxableValue + taxAmount;
      const finalTotal = so.totalAmount || calculatedTotal;
      const roundOff = Number((finalTotal - calculatedTotal).toFixed(2));

      const fId = so.customer?.franchiseId || filters.franchiseId;
      const split = splitGstAmount(taxAmount, so.stateOfSupply, (fId ? sellerStates.get(fId) : null) ?? null);

      if (!isCancelled) {
        totalSalesOrderValue += finalTotal;
        totalSubTotal += subTotal;
        totalTaxableValue += taxableValue;
        totalTax += taxAmount;
        totalDiscount += discountAmount;
        totalRoundOff += roundOff;
        totalCgst += split.cgst;
        totalSgst += split.sgst;
        totalIgst += split.igst;
        if (!isDraft && !isPending) {
          confirmedOrderValue += finalTotal;
        }
      } else {
        cancelledOrderValue += finalTotal;
      }

      if (isDraft) {
        draftOrderValue += finalTotal;
      }

      const orderDate = so.orderDate || so.createdAt;

      return {
        id: so.id,
        orderId: so.id,
        salesOrderId: so.id,
        salesOrderNo: so.orderNumber,
        orderNumber: so.orderNumber,
        orderNo: so.orderNumber,
        date: orderDate.toISOString(),
        orderDate: orderDate.toISOString(),
        createdAt: so.createdAt.toISOString(),
        dueDate: so.dueDate ? so.dueDate.toISOString() : null,
        deliveryDate: so.deliveryDate ? so.deliveryDate.toISOString() : null,
        customerName: so.customerName || so.customer?.name || 'Walk-in Customer',
        customer: so.customerName || so.customer?.name || 'Walk-in Customer',
        customerPhone: so.customerPhone || so.customer?.phone || '—',
        customerId: so.customerId,
        status: so.status,
        orderStatus: so.status,
        paymentStatus: so.paymentStatus || 'UNPAID',
        subTotal: Number(subTotal.toFixed(2)),
        taxAmount: Number(taxAmount.toFixed(2)),
        discountAmount: Number(discountAmount.toFixed(2)),
        taxableValue: Number(taxableValue.toFixed(2)),
        cgst: Number(split.cgst.toFixed(2)),
        sgst: Number(split.sgst.toFixed(2)),
        igst: Number(split.igst.toFixed(2)),
        roundOff,
        totalAmount: Number(finalTotal.toFixed(2)),
        amount: Number(finalTotal.toFixed(2)),
        itemCount: so.items.length,
        items: so.items
      };
    });

    const summary = {
      totalOrders: salesOrders.length,
      numberOfOrders: salesOrders.length,
      totalSalesOrderValue: Number(totalSalesOrderValue.toFixed(2)),
      totalOrderValue: Number(totalSalesOrderValue.toFixed(2)),
      totalAmount: Number(totalSalesOrderValue.toFixed(2)),
      totalRevenue: Number(totalSalesOrderValue.toFixed(2)),
      confirmedOrderValue: Number(confirmedOrderValue.toFixed(2)),
      activeOrderValue: Number(confirmedOrderValue.toFixed(2)),
      draftOrderValue: Number(draftOrderValue.toFixed(2)),
      cancelledOrderValue: Number(cancelledOrderValue.toFixed(2)),
      totalSubTotal: Number(totalSubTotal.toFixed(2)),
      totalTaxableValue: Number(totalTaxableValue.toFixed(2)),
      totalTax: Number(totalTax.toFixed(2)),
      totalCgst: Number(totalCgst.toFixed(2)),
      totalSgst: Number(totalSgst.toFixed(2)),
      totalIgst: Number(totalIgst.toFixed(2)),
      totalDiscount: Number(totalDiscount.toFixed(2)),
      totalRoundOff: Number(totalRoundOff.toFixed(2)),
      draftOrders: draftOrderCount,
      draftOrderCount,
      pendingOrders: pendingOrderCount,
      pendingOrderCount,
      confirmedOrders: confirmedOrderCount,
      confirmedOrderCount,
      processingOrders: processingOrderCount,
      processingOrderCount,
      shippedOrders: shippedOrderCount,
      shippedOrderCount,
      deliveredOrders: deliveredOrderCount,
      deliveredOrderCount,
      completedOrders: deliveredOrderCount,
      cancelledOrders: cancelledOrderCount,
      cancelledOrderCount,
      openOrders: openOrderCount,
      openOrderCount,
      activeOrders: openOrderCount
    };

    return {
      summary,
      orders: data,
      data
    };
  }

  static async getSaleOrderItemsReportData(filters: { franchiseId?: string; startDate?: string; endDate?: string; status?: string; search?: string; customerId?: string }): Promise<any> {
    const { start, end } = parseInclusiveDates(filters.startDate, filters.endDate);

    const where: any = {};
    if (filters.status && filters.status !== 'ALL' && filters.status !== '') {
      where.salesOrder = { status: filters.status };
    }
    if (filters.customerId) {
      where.salesOrder = { ...(where.salesOrder || {}), customerId: filters.customerId };
    }
    if (start || end) {
      where.salesOrder = {
        ...(where.salesOrder || {}),
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      };
    }
    if (filters.franchiseId) {
      where.salesOrder = {
        ...(where.salesOrder || {}),
        OR: [
          { customer: { franchiseId: filters.franchiseId } },
          { customerId: null }
        ]
      };
    }
    if (filters.search) {
      where.OR = [
        { productName: { contains: filters.search, mode: 'insensitive' } },
        { salesOrder: { orderNumber: { contains: filters.search, mode: 'insensitive' } } },
        { salesOrder: { customerName: { contains: filters.search, mode: 'insensitive' } } }
      ];
    }

    const items = await prisma.salesOrderItem.findMany({
      where,
      include: {
        salesOrder: {
          include: { customer: true }
        }
      },
      orderBy: { salesOrder: { createdAt: 'desc' } }
    });

    const quantityByUnit: Record<string, number> = {};
    let totalLineItemValue = 0;
    let totalTax = 0;
    let totalDiscount = 0;
    let totalQuantity = 0;

    const data = items.map(item => {
      const isCancelled = item.salesOrder?.status === 'CANCELLED';
      const unit = item.unit ? item.unit.toUpperCase().trim() : 'PCS';
      const qty = item.quantity || 0;

      if (!isCancelled) {
        totalQuantity += qty;
        totalLineItemValue += item.totalAmount || 0;
        totalTax += item.taxAmount || 0;
        totalDiscount += item.discountAmount || 0;
        quantityByUnit[unit] = (quantityByUnit[unit] || 0) + qty;
      }

      const orderDate = item.salesOrder?.orderDate || item.salesOrder?.createdAt || new Date();

      return {
        id: item.id,
        itemId: item.id,
        salesOrderId: item.salesOrderId,
        orderId: item.salesOrderId,
        salesOrderNo: item.salesOrder?.orderNumber || '—',
        orderNumber: item.salesOrder?.orderNumber || '—',
        orderNo: item.salesOrder?.orderNumber || '—',
        date: orderDate.toISOString(),
        orderDate: orderDate.toISOString(),
        customerName: item.salesOrder?.customerName || item.salesOrder?.customer?.name || 'Walk-in Customer',
        customer: item.salesOrder?.customerName || item.salesOrder?.customer?.name || 'Walk-in Customer',
        customerId: item.salesOrder?.customerId,
        itemName: item.productName,
        productName: item.productName,
        productId: item.productId,
        orderedQty: item.quantity,
        quantity: item.quantity,
        qty: item.quantity,
        unit,
        uom: unit,
        rate: item.rate,
        unitPrice: item.rate,
        price: item.rate,
        discountPercent: item.discountPercent,
        discountAmount: item.discountAmount,
        taxPercent: item.taxPercent,
        taxAmount: item.taxAmount,
        totalAmount: item.totalAmount,
        amount: item.totalAmount,
        lineAmount: item.totalAmount,
        status: item.salesOrder?.status || 'DRAFT',
        orderStatus: item.salesOrder?.status || 'DRAFT'
      };
    });

    const distinctUnits = Object.keys(quantityByUnit);
    let formattedQuantity = '';
    if (distinctUnits.length === 1) {
      formattedQuantity = `${totalQuantity} ${distinctUnits[0]}`;
    } else if (distinctUnits.length > 1) {
      formattedQuantity = distinctUnits.map(u => `${quantityByUnit[u]} ${u}`).join(' • ');
    } else {
      formattedQuantity = '0';
    }

    const summary = {
      totalOrderedQuantity: Number(totalQuantity.toFixed(2)),
      totalQuantity: Number(totalQuantity.toFixed(2)),
      formattedQuantity,
      quantityByUnit,
      totalLineItems: items.length,
      numberOfItems: items.length,
      totalLineItemValue: Number(totalLineItemValue.toFixed(2)),
      totalAmount: Number(totalLineItemValue.toFixed(2)),
      totalTax: Number(totalTax.toFixed(2)),
      totalDiscount: Number(totalDiscount.toFixed(2))
    };

    const result: any = data;
    result.summary = summary;
    result.items = data;
    result.data = data;

    return result;
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

