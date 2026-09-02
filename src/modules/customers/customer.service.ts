import prisma from '../../lib/prisma';

export class CustomerService {
  static async getAll(search?: string, franchiseId?: string) {
    const customers = await prisma.customer.findMany({
      where: {
        ...(franchiseId && { franchiseId }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } }
          ]
        })
      },
      include: {
        orders: {
          select: { id: true, totalAmount: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Outstanding "Amount" (To Receive/To Pay) — real current balance, not a
    // snapshot. Computed the same way the Transactions tab computes each
    // order's own balance (totalAmount minus non-cancelled payments), summed
    // across ALL of the customer's orders (not the 5-row preview above) and
    // added to the signed opening balance carried on the Customer row.
    // Deliberately NOT sourced from CustomerLedger: POSService.checkout —
    // the actual POS sale path — never posts SALE/PAYMENT ledger entries
    // (only the separate native step-by-step flow does), so ledger totals
    // would silently read zero for real POS sales. Order+Payment are the
    // one source both flows always write to.
    const balanceByCustomer = await this.getOutstandingBalances(customers.map((c) => c.id));

    return customers.map((c) => ({
      ...c,
      balance: (c.openingBalance || 0) + (balanceByCustomer.get(c.id) || 0)
    }));
  }

  /** customerId -> sum(order.totalAmount - non-cancelled payments) across ALL of that customer's orders. */
  private static async getOutstandingBalances(customerIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (customerIds.length === 0) return result;

    const orders = await prisma.order.findMany({
      where: { customerId: { in: customerIds } },
      select: {
        customerId: true,
        totalAmount: true,
        payments: { select: { paidAmount: true, isCancelled: true, status: true } },
        // A multi-invoice receipt's share of this order isn't in `payments`
        // (that Payment's orderId is null) — it's here, on the Invoice this
        // order owns. Without this, an order paid off via a multi-invoice
        // receipt still counted its full total as due (see
        // FinanceService.sumOrderPaidWithAllocations for the same pattern).
        invoice: { select: { allocations: { select: { amount: true, payment: { select: { status: true, isCancelled: true } } } } } }
      }
    });

    for (const o of orders) {
      if (!o.customerId) continue;
      const isValid = (p: { isCancelled: boolean; status: string }) => !p.isCancelled && p.status !== 'CANCELLED';
      const direct = o.payments.filter(isValid).reduce((sum, p) => sum + (p.paidAmount || 0), 0);
      const allocated = (o.invoice?.allocations || [])
        .filter((a) => isValid(a.payment))
        .reduce((sum, a) => sum + (a.amount || 0), 0);
      const paid = direct + allocated;
      const due = (o.totalAmount || 0) - paid;
      result.set(o.customerId, (result.get(o.customerId) || 0) + due);
    }

    return result;
  }

  static async getById(id: string, franchiseId?: string) {
    return prisma.customer.findFirst({
      where: { id, ...(franchiseId && { franchiseId }) },
      include: {
        orders: {
          include: { orderItems: { include: { product: true } }, payments: true },
          orderBy: { createdAt: 'desc' }
        }
      }
    });
  }

  static async create(data: {
    name: string;
    phone?: string;
    email?: string;
    franchiseId?: string;
    address?: string;
    billingAddress?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstNumber?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
    asOfDate?: string | Date;
    creditLimit?: number | null;
  }) {
    const { billingAddress, ...customerData } = data as any;
    if (billingAddress && !customerData.address) {
      customerData.address = billingAddress;
    }
    const customer = await prisma.customer.create({
      data: {
        ...customerData,
        asOfDate: customerData.asOfDate ? new Date(customerData.asOfDate) : undefined,
      }
    });

    // Post a real CustomerLedger entry for a non-zero opening balance instead
    // of leaving it as a number that only lives on the Customer row with no
    // accounting trail. openingBalance is already signed by the caller
    // (AddPartyModal: positive = customer owes us / "To Receive", negative =
    // we owe them / "To Pay" — see form.openingBalanceType handling there),
    // so DEBIT for positive, CREDIT for negative mirrors the same
    // DEBIT=owed-to-us / CREDIT=paid-to-us convention getLedgerSummary already
    // uses. A zero opening balance posts nothing — no entry needed for "no
    // balance". paymentMode is a placeholder (no real money moved for an
    // opening balance), matching the same placeholder used for the SALE
    // debit entry in POSService.updateOrderStatus.
    const opening = Number(customer.openingBalance) || 0;
    if (opening !== 0) {
      try {
        await prisma.customerLedger.create({
          data: {
            customerId: customer.id,
            type: opening > 0 ? 'DEBIT' : 'CREDIT',
            amount: Math.abs(opening),
            paymentMode: 'CASH',
            referenceType: 'OPENING_BALANCE',
            referenceId: customer.id,
            note: 'Opening balance'
          }
        });
      } catch (ledgerErr) {
        console.error('[Accounting] Failed to post opening balance ledger entry', ledgerErr);
      }
    }

    return customer;
  }

  static async update(id: string, data: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    billingAddress?: string;
    state?: string;
    district?: string;
    city?: string;
    pincode?: string;
    shippingAddress?: string;
    gstNumber?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
    asOfDate?: string | Date | null;
    creditLimit?: number | null;
  }, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.customer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Customer not found');
    }

    const { billingAddress, ...customerData } = data as any;
    if (billingAddress && !customerData.address) {
      customerData.address = billingAddress;
    }
    return prisma.customer.update({
      where: { id },
      data: {
        ...customerData,
        asOfDate: customerData.asOfDate === null ? null : (customerData.asOfDate ? new Date(customerData.asOfDate) : undefined),
      }
    });
  }

  static async delete(id: string, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.customer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Customer not found');
    }
    return prisma.customer.delete({ where: { id } });
  }

  /**
   * Bulk per-customer ledger totals for the Customer Ledger list page — avoids an
   * N+1 call per customer to the party-statement report. DEBIT = sale/invoice
   * (increases what the customer owes), CREDIT = payment received (reduces it).
   */
  static async getLedgerSummary(franchiseId?: string) {
    const customers = await prisma.customer.findMany({
      where: franchiseId ? { franchiseId } : undefined,
      include: { ledgerEntries: true }
    });

    return customers.map((c) => {
      let totalSales = 0;
      let totalPaid = 0;
      for (const entry of c.ledgerEntries) {
        if (entry.type === 'DEBIT') totalSales += entry.amount;
        else totalPaid += entry.amount;
      }
      return {
        customerId: c.id,
        totalSales,
        totalPaid,
        balance: totalSales - totalPaid
      };
    });
  }

  static async getLoyalty(customerId: string) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, phone: true, loyaltyPoints: true }
    });
    if (!customer) return null;

    const totalSpend = await prisma.order.aggregate({
      where: { customerId },
      _sum: { totalAmount: true }
    });

    const totalOrders = await prisma.order.count({ where: { customerId } });

    const tier =
      (customer.loyaltyPoints >= 4000 && 'PLATINUM') ||
      (customer.loyaltyPoints >= 2000 && 'GOLD') ||
      (customer.loyaltyPoints >= 1000 && 'SILVER') ||
      'BRONZE';

    return {
      ...customer,
      totalSpend: totalSpend._sum.totalAmount || 0,
      totalOrders,
      tier
    };
  }

  static async addPoints(customerId: string, points: number) {
    return prisma.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: { increment: points } }
    });
  }

  static async redeemPoints(customerId: string, points: number) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new Error('Customer not found');
    if (customer.loyaltyPoints < points) throw new Error('Insufficient loyalty points');
    return prisma.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: { decrement: points } }
    });
  }
}
