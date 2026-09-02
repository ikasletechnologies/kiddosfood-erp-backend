import prisma from '../../lib/prisma';

export class DealerService {
  static async getAll(franchiseId?: string) {
    return prisma.dealer.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: { franchise: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getById(id: string, franchiseId?: string) {
    return prisma.dealer.findFirst({
      where: franchiseId ? { id, franchiseId } : { id },
      include: { franchise: true }
    });
  }

  static async create(data: { name: string; email?: string; phone?: string; address?: string; franchiseId: string }) {
    return prisma.dealer.create({
      data
    });
  }

  static async update(
    id: string,
    data: { name?: string; email?: string; phone?: string; address?: string; status?: string },
    franchiseId?: string
  ) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }
    // Only forward fields that were actually provided so a partial PATCH
    // body never blanks out columns the caller didn't intend to touch.
    const updateData: Record<string, any> = {};
    for (const key of ['name', 'email', 'phone', 'address', 'status'] as const) {
      if (data[key] !== undefined) updateData[key] = data[key];
    }
    return prisma.dealer.update({ where: { id }, data: updateData, include: { franchise: true } });
  }

  static async delete(id: string, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }
    return prisma.dealer.delete({ where: { id } });
  }

  /**
   * Consolidated transaction history for a dealer, sourced entirely from the
   * already-persisted records that reference this dealer by its real id —
   * never by name matching. Two sources currently link to Dealer:
   *   - Order (POS Counter Billing sales): partyType='DEALER', partyId=dealer.id
   *     (see PosService.checkout — Order.partyId/partyType are the real party
   *     reference written at checkout time; Payment.entityId mirrors it).
   *   - DeliveryChallan: dealerId=dealer.id (B2B dispatch to this dealer).
   * No new transaction/payment rows are created here — this only reads and
   * formats what already exists.
   */
  static async getTransactions(id: string, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }

    const [orders, challans] = await Promise.all([
      prisma.order.findMany({
        where: { partyType: 'DEALER', partyId: id },
        include: {
          payments: { where: { isCancelled: false } },
          // A multi-invoice receipt's share of this order isn't in
          // `payments` (that Payment's orderId is null) — it's here, on the
          // Invoice this order owns.
          invoice: { select: { allocations: { where: { payment: { isCancelled: false } }, select: { amount: true } } } }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.deliveryChallan.findMany({
        where: { dealerId: id },
        orderBy: { challanDate: 'desc' }
      })
    ]);

    const orderTxns = orders.map((o) => {
      const direct = o.payments.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
      const allocated = (o.invoice?.allocations || []).reduce((sum, a) => sum + (a.amount || 0), 0);
      const paid = direct + allocated;
      const balance = Math.max(0, Number((o.totalAmount - paid).toFixed(2)));
      return {
        id: o.id,
        type: 'POS Sale',
        number: o.invoiceNum,
        date: o.createdAt,
        total: o.totalAmount,
        balance,
        paymentStatus: o.paymentStatus,
        paymentType: o.paymentType
      };
    });

    const challanTxns = challans.map((c) => ({
      id: c.id,
      type: 'Delivery Challan',
      number: c.challanNumber,
      date: c.challanDate,
      total: c.totalAmount,
      balance: 0,
      paymentStatus: c.status,
      paymentType: null
    }));

    return [...orderTxns, ...challanTxns].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }
}
