import prisma from '../../lib/prisma';

export class DealerService {
  static async getAll(franchiseId?: string) {
    const dealers = await prisma.dealer.findMany({
      where: franchiseId ? { franchiseId } : {},
      include: { franchise: true },
      orderBy: { createdAt: 'desc' }
    });

    const dealerIds = dealers.map((d) => d.id);
    const balanceByDealer = await this.getOutstandingBalances(dealerIds);

    return dealers.map((d) => ({
      ...d,
      balance: (d.openingBalance || 0) + (balanceByDealer.get(d.id) || 0)
    }));
  }

  /** dealerId -> sum(order.totalAmount - non-cancelled payments) across ALL of that dealer's orders. */
  private static async getOutstandingBalances(dealerIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (dealerIds.length === 0) return result;

    const orders = await prisma.order.findMany({
      where: { partyType: 'DEALER', partyId: { in: dealerIds } },
      select: {
        partyId: true,
        totalAmount: true,
        payments: { select: { paidAmount: true, isCancelled: true, status: true } },
        invoice: { select: { allocations: { select: { amount: true, payment: { select: { status: true, isCancelled: true } } } } } }
      }
    });

    for (const o of orders) {
      if (!o.partyId) continue;
      const isValid = (p: { isCancelled: boolean; status: string }) => !p.isCancelled && p.status !== 'CANCELLED';
      const direct = o.payments.filter(isValid).reduce((sum, p) => sum + (p.paidAmount || 0), 0);
      const allocated = (o.invoice?.allocations || [])
        .filter((a) => isValid(a.payment))
        .reduce((sum, a) => sum + (a.amount || 0), 0);
      const paid = direct + allocated;
      const due = (o.totalAmount || 0) - paid;
      result.set(o.partyId, (result.get(o.partyId) || 0) + due);
    }
    return result;
  }

  static async getById(id: string, franchiseId?: string) {
    const dealer = await prisma.dealer.findFirst({
      where: franchiseId ? { id, franchiseId } : { id },
      include: { franchise: true }
    });
    if (!dealer) return null;
    const balanceMap = await this.getOutstandingBalances([dealer.id]);
    return {
      ...dealer,
      balance: (dealer.openingBalance || 0) + (balanceMap.get(dealer.id) || 0)
    };
  }

  static async create(data: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    shippingAddress?: string;
    pincode?: string;
    state?: string;
    city?: string;
    district?: string;
    gstNumber?: string;
    gstType?: string;
    openingBalance?: number;
    openingBalanceType?: string;
    asOfDate?: Date | string | null;
    creditLimit?: number | null;
    status?: string;
    franchiseId: string;
  }) {
    if (data.email && data.email.trim()) {
      const existingEmail = await prisma.dealer.findFirst({
        where: {
          email: { equals: data.email.trim(), mode: 'insensitive' }
        }
      });
      if (existingEmail) {
        throw new Error('A dealer with this email address already exists.');
      }
    }

    if (data.phone && data.phone.trim()) {
      const existingPhone = await prisma.dealer.findFirst({
        where: {
          phone: data.phone.trim()
        }
      });
      if (existingPhone) {
        throw new Error('A dealer with this contact number already exists.');
      }
    }

    const createData: Record<string, any> = {
      name: data.name,
      franchiseId: data.franchiseId,
      status: data.status || 'ACTIVE'
    };
    if (data.email) createData.email = data.email.trim().toLowerCase();
    if (data.phone) createData.phone = data.phone.trim();
    if (data.address) createData.address = data.address.trim();
    if (data.shippingAddress) createData.shippingAddress = data.shippingAddress.trim();
    if (data.pincode) createData.pincode = data.pincode.trim();
    if (data.state) createData.state = data.state.trim();
    if (data.city) createData.city = data.city.trim();
    if (data.district) createData.district = data.district.trim();
    if (data.gstNumber) createData.gstNumber = data.gstNumber.trim().toUpperCase();
    if (data.gstType) createData.gstType = data.gstType.trim();
    if (data.openingBalance !== undefined) createData.openingBalance = Number(data.openingBalance) || 0;
    if (data.openingBalanceType) createData.openingBalanceType = data.openingBalanceType;
    if (data.asOfDate) createData.asOfDate = new Date(data.asOfDate);
    if (data.creditLimit !== undefined) createData.creditLimit = data.creditLimit === null ? null : Number(data.creditLimit);

    return prisma.dealer.create({
      data: createData as any
    });
  }

  static async update(
    id: string,
    data: {
      name?: string;
      email?: string;
      phone?: string;
      address?: string;
      shippingAddress?: string;
      pincode?: string;
      state?: string;
      city?: string;
      district?: string;
      gstNumber?: string;
      gstType?: string;
      openingBalance?: number;
      openingBalanceType?: string | null;
      asOfDate?: Date | string | null;
      creditLimit?: number | null;
      status?: string;
    },
    franchiseId?: string
  ) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }

    if (data.email && data.email.trim()) {
      const existingEmail = await prisma.dealer.findFirst({
        where: {
          id: { not: id },
          email: { equals: data.email.trim(), mode: 'insensitive' }
        }
      });
      if (existingEmail) {
        throw new Error('A dealer with this email address already exists.');
      }
    }

    if (data.phone && data.phone.trim()) {
      const existingPhone = await prisma.dealer.findFirst({
        where: {
          id: { not: id },
          phone: data.phone.trim()
        }
      });
      if (existingPhone) {
        throw new Error('A dealer with this contact number already exists.');
      }
    }

    const updateData: Record<string, any> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email ? data.email.trim().toLowerCase() : null;
    if (data.phone !== undefined) updateData.phone = data.phone ? data.phone.trim() : null;
    if (data.address !== undefined) updateData.address = data.address ? data.address.trim() : null;
    if (data.shippingAddress !== undefined) updateData.shippingAddress = data.shippingAddress ? data.shippingAddress.trim() : null;
    if (data.pincode !== undefined) updateData.pincode = data.pincode ? data.pincode.trim() : null;
    if (data.state !== undefined) updateData.state = data.state ? data.state.trim() : null;
    if (data.city !== undefined) updateData.city = data.city ? data.city.trim() : null;
    if (data.district !== undefined) updateData.district = data.district ? data.district.trim() : null;
    if (data.gstNumber !== undefined) updateData.gstNumber = data.gstNumber ? data.gstNumber.trim().toUpperCase() : null;
    if (data.gstType !== undefined) updateData.gstType = data.gstType ? data.gstType.trim() : null;
    if (data.openingBalance !== undefined) updateData.openingBalance = Number(data.openingBalance) || 0;
    if (data.openingBalanceType !== undefined) updateData.openingBalanceType = data.openingBalanceType || null;
    if (data.asOfDate !== undefined) updateData.asOfDate = data.asOfDate ? new Date(data.asOfDate) : null;
    if (data.creditLimit !== undefined) updateData.creditLimit = data.creditLimit === null ? null : Number(data.creditLimit);
    if (data.status !== undefined) updateData.status = data.status;

    return prisma.dealer.update({ where: { id }, data: updateData, include: { franchise: true } });
  }

  static async delete(id: string, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }
    return prisma.dealer.delete({ where: { id } });
  }

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

  static async getItemHistory(id: string, franchiseId?: string) {
    if (franchiseId) {
      const owned = await prisma.dealer.findFirst({ where: { id, franchiseId } });
      if (!owned) throw new Error('Dealer not found');
    }

    const [orders, challans] = await Promise.all([
      prisma.order.findMany({
        where: {
          partyType: 'DEALER',
          partyId: id,
          status: { notIn: ['CANCELLED', 'REFUNDED'] }
        },
        include: {
          orderItems: {
            include: {
              product: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.deliveryChallan.findMany({
        where: {
          dealerId: id,
          status: { notIn: ['CANCELLED', 'REJECTED'] }
        },
        include: {
          items: true
        },
        orderBy: { challanDate: 'desc' }
      })
    ]);

    const productMap = new Map<string, {
      productId: string;
      name: string;
      sku: string;
      category?: string;
      unit?: string;
      quantitySold: number;
      totalValue: number;
      lastPurchased: Date;
      orderCount: number;
    }>();

    for (const order of orders as any[]) {
      for (const item of order.orderItems || []) {
        if (!item.productId && !item.product) continue;
        const prodId = item.productId || item.product?.id || 'unknown';
        const prodName = item.product?.name || item.productName || 'Product';
        const sku = item.product?.sku || '—';
        const category = item.product?.category || '—';
        const unit = item.product?.unit || item.unit || 'PCS';
        const qty = Number(item.quantity) || 0;
        const val = Number(item.totalAmount || (item.price * item.quantity)) || 0;
        const dt = new Date(order.createdAt);

        if (!productMap.has(prodId)) {
          productMap.set(prodId, {
            productId: prodId,
            name: prodName,
            sku,
            category,
            unit,
            quantitySold: qty,
            totalValue: val,
            lastPurchased: dt,
            orderCount: 1
          });
        } else {
          const p = productMap.get(prodId)!;
          p.quantitySold += qty;
          p.totalValue += val;
          p.orderCount += 1;
          if (dt > p.lastPurchased) p.lastPurchased = dt;
        }
      }
    }

    for (const ch of challans as any[]) {
      if (ch.convertedOrderId) continue;
      for (const item of ch.items || []) {
        const prodId = item.productId || item.productName || 'unknown';
        const prodName = item.productName || 'Product';
        const sku = '—';
        const category = '—';
        const unit = item.unit || 'PCS';
        const qty = Number(item.quantity) || 0;
        const val = Number(item.totalAmount || (item.rate * item.quantity)) || 0;
        const dt = new Date(ch.challanDate || ch.createdAt);

        if (!productMap.has(prodId)) {
          productMap.set(prodId, {
            productId: prodId,
            name: prodName,
            sku,
            category,
            unit,
            quantitySold: qty,
            totalValue: val,
            lastPurchased: dt,
            orderCount: 1
          });
        } else {
          const p = productMap.get(prodId)!;
          p.quantitySold += qty;
          p.totalValue += val;
          p.orderCount += 1;
          if (dt > p.lastPurchased) p.lastPurchased = dt;
        }
      }
    }

    return Array.from(productMap.values()).sort(
      (a, b) => b.lastPurchased.getTime() - a.lastPurchased.getTime()
    );
  }
}
