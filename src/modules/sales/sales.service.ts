import prisma from '../../lib/prisma';
import { InventoryService } from '../inventory/inventory.service';
import { FranchiseService } from '../franchise/franchise.service';

// Atomic, collision-safe document numbering. A raw `.count()`-based scheme
// (the old approach here) lets two concurrent requests read the same N
// before either commits — the @unique column then hard-fails the second
// insert instead of preventing the race. NumberSequence upsert is atomic
// within the surrounding transaction (same pattern as
// ProductionService.nextProductionBatchCode), so retries/concurrent
// creates cannot reuse a number. Every Sales-chain document (Estimate,
// Sales Order, Proforma, Tax Invoice) shares this one generator so there's
// exactly one counter per prefix+year, not several independently-
// incrementing schemes racing to produce the same string.
async function nextDocumentNumber(tx: any, key: string, prefix: string, pad = 5): Promise<string> {
  const year = new Date().getFullYear();
  const seq = await tx.numberSequence.upsert({
    where: { key: `${key}_${year}` },
    create: { key: `${key}_${year}`, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${year}-${String(seq.value).padStart(pad, '0')}`;
}

async function generateReturnNumber() {
  const count = await prisma.returnOrder.count();
  return `SR${(count + 1).toString().padStart(10, '0')}`;
}

// A quotation/order always stores customerId + a denormalized customerName
// snapshot, but callers that select a real party only ever send customerId —
// without this, customerName is saved as null and every later screen that
// reads it (list, convert modal, the converted Sales Order) shows "—" even
// though the party is correctly linked via customerId.
async function resolveCustomerName(customerId?: string, customerName?: string): Promise<string | undefined> {
  if (customerName) return customerName;
  if (!customerId) return undefined;
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  return customer?.name;
}

function calculateTotals<T extends { quantity: number; rate: number; taxPercent?: number }>(items: T[]) {
  let subTotal = 0;
  let taxAmount = 0;
  const computed = items.map((item) => {
    const lineTotal = item.quantity * item.rate;
    const lineTax = (lineTotal * (item.taxPercent || 0)) / 100;
    subTotal += lineTotal;
    taxAmount += lineTax;
    return { ...item, taxAmount: lineTax, totalAmount: lineTotal + lineTax };
  });
  return { computed, subTotal, taxAmount, totalAmount: subTotal + taxAmount };
}

export class SalesService {
  // ─── Quotations ──────────────────────────────────────────────────────────────

  static async getQuotations(filters: { status?: string; customerId?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.search) {
      where.OR = [
        { quotationNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    const quotations = await prisma.quotation.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });

    // Estimate converts to a Sales Order now (convertedOrderId), not
    // straight to a Tax Invoice — convertedInvoiceId only gets set on a
    // Quotation via the old (now-unused) direct path and stays null for
    // every new conversion, so this resolves the Sales Order's number.
    const salesOrderIds = quotations.map(q => q.convertedOrderId).filter(Boolean) as string[];
    const salesOrderMap = salesOrderIds.length
      ? new Map((await prisma.salesOrder.findMany({ where: { id: { in: salesOrderIds } }, select: { id: true, orderNumber: true } })).map(o => [o.id, o.orderNumber]))
      : new Map<string, string>();
    return quotations.map(q => ({
      ...q,
      convertedOrderNumber: q.convertedOrderId ? salesOrderMap.get(q.convertedOrderId) || null : null
    }));
  }

  static async getQuotationById(id: string) {
    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: { customer: true, items: true }
    });
    if (quotation && quotation.convertedOrderId) {
      const salesOrder = await prisma.salesOrder.findUnique({
        where: { id: quotation.convertedOrderId },
        select: { orderNumber: true }
      });
      return {
        ...quotation,
        convertedOrderNumber: salesOrder?.orderNumber || null
      };
    }
    return quotation ? { ...quotation, convertedOrderNumber: null } : null;
  }

  static async createQuotation(data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    validUntil?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    termsConditions?: string;
    notes?: string;
    createdBy?: string;
    quotationNumber?: string;
    status?: string;
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;
    const partyType = data.partyType || 'CUSTOMER';
    // The `customer` relation/customerId only ever means a real Customer
    // record — a Dealer or Franchise party has no such row, so customerId
    // must stay null for those (partyId carries the id for every type).
    const customerId = partyType === 'CUSTOMER' ? data.customerId : undefined;
    const customerName = partyType === 'CUSTOMER' ? await resolveCustomerName(customerId, data.customerName) : (data.customerName || undefined);

    return prisma.$transaction(async (tx) => tx.quotation.create({
      data: {
        quotationNumber: data.quotationNumber || await nextDocumentNumber(tx, 'QT', 'QT'),
        partyType: partyType as any,
        partyId: data.partyId,
        customerId,
        customerName,
        customerPhone: data.customerPhone,
        customerEmail: data.customerEmail,
        validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
        status: (data.status as any) || undefined,
        subTotal,
        taxAmount,
        discountAmount: discount,
        totalAmount: totalAmount - discount,
        termsConditions: data.termsConditions,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { customer: true, items: true }
    }));
  }

  static async updateQuotation(id: string, data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    status?: string;
    notes?: string;
    termsConditions?: string;
    validUntil?: string;
    items?: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    quotationNumber?: string;
    trackingNumber?: string;
    courierName?: string;
  }) {
    // Once an Estimate is CONVERTED it has a live Sales Order downstream —
    // silently rewriting its party/items/status here (e.g. the shared
    // create-form's autosave-on-back firing against an already-converted
    // record) would desync the two with nothing to reconcile them. Mirrors
    // the same guard on updateProformaInvoice. trackingNumber/courierName
    // stay editable post-conversion (delivery info legitimately changes).
    const existingForGuard = await prisma.quotation.findUnique({ where: { id } });
    if (!existingForGuard) throw new Error('Estimate not found.');
    if (existingForGuard.status === 'CONVERTED') {
      const trackingOnly = Object.keys(data).every(k => ['trackingNumber', 'courierName'].includes(k) || data[k as keyof typeof data] === undefined);
      if (!trackingOnly) {
        throw new Error('Cannot update a converted Estimate — it already has a Sales Order.');
      }
    }

    const partyType = data.partyType;
    // Same CUSTOMER-only rule as createQuotation — but only override
    // customerId here when the caller actually sent a partyType (a plain
    // field-only PATCH, e.g. tracking info, must not clobber it to null).
    const customerId = partyType ? (partyType === 'CUSTOMER' ? data.customerId : undefined) : data.customerId;
    const updateData: any = {
      partyType: partyType as any,
      partyId: data.partyId,
      customerId,
      customerName: partyType === 'DEALER' || partyType === 'FRANCHISE' ? (data.customerName || undefined) : await resolveCustomerName(customerId, data.customerName),
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      status: data.status as any,
      notes: data.notes,
      termsConditions: data.termsConditions,
      validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
      quotationNumber: data.quotationNumber,
      trackingNumber: data.trackingNumber,
      courierName: data.courierName
    };

    return prisma.$transaction(async (tx) => {
      if (data.items) {
        const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
        const discount = data.discountAmount || 0;
        
        updateData.subTotal = subTotal;
        updateData.taxAmount = taxAmount;
        updateData.discountAmount = discount;
        updateData.totalAmount = totalAmount - discount;

        // Delete old items
        await tx.quotationItem.deleteMany({ where: { quotationId: id } });
        
        // Recreate items
        updateData.items = {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        };
      }

      const updated = await tx.quotation.update({
        where: { id },
        data: updateData,
        include: { customer: true, items: true }
      });

      if (updated.convertedOrderId) {
        await tx.salesOrder.update({
          where: { id: updated.convertedOrderId },
          data: {
            trackingNumber: data.trackingNumber || undefined,
            courierName: data.courierName || undefined
          }
        });
      }
      return updated;
    });
  }

  static async deleteQuotation(id: string) {
    return prisma.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      return tx.quotation.delete({ where: { id } });
    });
  }

  // ─── Document chain conversions ────────────────────────────────────────────
  // Estimate -> Sales Order -> Proforma Invoice -> Tax Invoice -> Payment.
  // Every step here: (1) validates the source doc and rejects a repeat
  // conversion via a real DB-unique marker (not just an app-level check —
  // see the @unique columns on SalesOrder.proformaInvoiceId and
  // ProformaInvoice.convertedInvoiceId), (2) copies every field forward so
  // the user never re-enters data, (3) runs inside one $transaction so a
  // failure never leaves the source doc marked converted without the target
  // doc actually existing.

  // Estimate -> Sales Order. This replaces the old convertQuotationToInvoice,
  // which skipped straight to a Tax Invoice — wrong per the confirmed chain.
  static async convertQuotationToSalesOrder(
    quotationId: string,
    createdBy: string,
    trackingData?: { trackingNumber?: string; courierName?: string; deliveryDate?: string; deliveryAddress?: string; }
  ) {
    try {
      return await prisma.$transaction(async (tx) => {
      const quotation = await tx.quotation.findUnique({ where: { id: quotationId }, include: { items: true } });
      if (!quotation) throw new Error('Estimate not found.');

      // Dedup check FIRST, unconditionally — checking it only inside the
      // `status !== 'SENT'` branch (as this used to) meant that while the
      // status was still 'SENT' (i.e. two rapid clicks/tabs both read it
      // before either transaction committed), the existing-order check was
      // skipped entirely and both could attempt to create a Sales Order.
      if (quotation.convertedOrderId) {
        const existing = await tx.salesOrder.findUnique({ where: { id: quotation.convertedOrderId }, include: { items: true } });
        if (existing) return existing;
      }
      if (quotation.status !== 'SENT') {
        throw new Error(`Only an Estimate with status SENT can be converted to a Sales Order (current status: ${quotation.status}).`);
      }

      const salesOrder = await tx.salesOrder.create({
        data: {
          orderNumber: await nextDocumentNumber(tx, 'SO', 'SO'),
          quotationId: quotation.id,
          partyType: quotation.partyType,
          partyId: quotation.partyId,
          customerId: quotation.customerId,
          customerName: quotation.customerName,
          customerPhone: quotation.customerPhone,
          status: 'DRAFT',
          subTotal: quotation.subTotal,
          taxAmount: quotation.taxAmount,
          discountAmount: quotation.discountAmount,
          totalAmount: quotation.totalAmount,
          deliveryDate: trackingData?.deliveryDate ? new Date(trackingData.deliveryDate) : undefined,
          deliveryAddress: trackingData?.deliveryAddress || undefined,
          trackingNumber: trackingData?.trackingNumber || undefined,
          courierName: trackingData?.courierName || undefined,
          notes: quotation.notes,
          createdBy,
          items: {
            create: quotation.items.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              taxPercent: item.taxPercent,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { items: true },
      });

      await tx.quotation.update({
        where: { id: quotationId },
        data: { status: 'CONVERTED', convertedOrderId: salesOrder.id },
      });

      return salesOrder;
      });
    } catch (err: any) {
      // True concurrent double-click/multi-tab race backstop — the DB-level
      // @unique on SalesOrder.quotationId is what actually stops a second
      // row from persisting; return the winner's row instead of erroring.
      if (err?.code === 'P2002') {
        const quotationNow = await prisma.quotation.findUnique({ where: { id: quotationId } });
        if (quotationNow?.convertedOrderId) {
          const existing = await prisma.salesOrder.findUnique({ where: { id: quotationNow.convertedOrderId }, include: { items: true } });
          if (existing) return existing;
        }
      }
      throw err;
    }
  }

  // Sales Order -> Proforma Invoice.
  static async convertSalesOrderToProforma(salesOrderId: string, createdBy: string) {
    try {
      return await prisma.$transaction(async (tx) => {
      const salesOrder = await tx.salesOrder.findUnique({ where: { id: salesOrderId }, include: { items: true } });
      if (!salesOrder) throw new Error('Sales Order not found.');
      if (salesOrder.proformaInvoiceId) {
        const existing = await tx.proformaInvoice.findUnique({ where: { id: salesOrder.proformaInvoiceId }, include: { items: true } });
        if (existing) return existing;
      }
      if (salesOrder.status !== 'CONFIRMED') {
        throw new Error(`Only a CONFIRMED Sales Order can generate a Proforma Invoice (current status: ${salesOrder.status}).`);
      }

      const proforma = await tx.proformaInvoice.create({
        data: {
          proformaNumber: await nextDocumentNumber(tx, 'PI', 'PI'),
          sourceSalesOrderId: salesOrder.id,
          partyType: salesOrder.partyType,
          partyId: salesOrder.partyId,
          customerId: salesOrder.customerId,
          customerName: salesOrder.customerName,
          status: 'DRAFT',
          subTotal: salesOrder.subTotal,
          taxAmount: salesOrder.taxAmount,
          discountAmount: salesOrder.discountAmount,
          totalAmount: salesOrder.totalAmount,
          notes: salesOrder.notes,
          createdBy,
          items: {
            create: salesOrder.items.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              taxPercent: item.taxPercent,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { items: true },
      });

      // DRAFT -> CONFIRMED -> PROCESSING is the intended lifecycle: this is
      // the one meaningful transition point ("this order's Proforma now
      // exists, fulfillment is underway") — previously PROCESSING was only
      // ever set two hops downstream (in convertProformaToInvoice, when the
      // Proforma became a Tax Invoice), which left it looking like an
      // unexplained, disconnected status in the Sales Order list.
      await tx.salesOrder.update({
        where: { id: salesOrderId },
        data: { proformaInvoiceId: proforma.id, status: 'PROCESSING' },
      });

      return proforma;
      });
    } catch (err: any) {
      // True concurrent double-click/multi-tab race backstop — the DB-level
      // @unique on SalesOrder.proformaInvoiceId is what actually stops a
      // second row from persisting; return the winner's row instead of
      // erroring.
      if (err?.code === 'P2002') {
        const salesOrderNow = await prisma.salesOrder.findUnique({ where: { id: salesOrderId } });
        if (salesOrderNow?.proformaInvoiceId) {
          const existing = await prisma.proformaInvoice.findUnique({ where: { id: salesOrderNow.proformaInvoiceId }, include: { items: true } });
          if (existing) return existing;
        }
      }
      throw err;
    }
  }

  // Proforma Invoice -> Tax Invoice (Order + Invoice).
  static async convertProformaToInvoice(proformaInvoiceId: string, createdBy: string) {
    const proforma = await prisma.proformaInvoice.findUnique({ where: { id: proformaInvoiceId }, include: { items: true } });
    if (!proforma) throw new Error('Proforma Invoice not found.');
    if (proforma.convertedInvoiceId) {
      const existing = await prisma.order.findUnique({ where: { id: proforma.convertedInvoiceId }, include: { orderItems: true, invoice: true } });
      if (existing) return existing;
    }
    if (proforma.status === 'CANCELLED') {
      throw new Error('Cannot convert a cancelled Proforma Invoice.');
    }

    const missingProduct = proforma.items.find(i => !i.productId);
    if (missingProduct) {
      throw new Error(`Item "${missingProduct.productName}" is missing a valid Product ID. Custom items without an inventory mapping cannot be converted to a Tax Invoice.`);
    }

    // The full source chain, when this Proforma came from a Sales Order
    // that itself came from an Estimate — kept for traceability even though
    // Order only has direct FKs to the immediate parent (proforma) and the
    // original Estimate (sourceQuotationId), not the Sales Order itself.
    const sourceSalesOrder = proforma.sourceSalesOrderId
      ? await prisma.salesOrder.findUnique({ where: { id: proforma.sourceSalesOrderId } })
      : null;

    let franchiseId: string | undefined;
    const hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
    if (hq) franchiseId = hq.id;
    else {
      const first = await prisma.franchise.findFirst({ where: { status: 'ACTIVE' } });
      if (first) franchiseId = first.id;
      else throw new Error('No active franchise found to assign the invoice.');
    }

    try {
      return await prisma.$transaction(async (tx) => {
      // Ensure all items have a corresponding Product row since OrderItem
      // requires a hard relation to Product in the schema. In cases where the
      // frontend sent an InventoryItem ID, we create a matching Product on the fly.
      for (const item of proforma.items) {
        if (!item.productId) continue;
        const existingProduct = await tx.product.findUnique({ where: { id: item.productId } });
        if (!existingProduct) {
          const invItem = await tx.inventoryItem.findUnique({ where: { id: item.productId } });
          if (invItem) {
            await tx.product.create({
              data: {
                id: invItem.id, // Keep exact same ID so the FK succeeds
                name: invItem.name,
                sku: invItem.sku,
                basePrice: invItem.customerPrice || invItem.basePrice || 0,
                productType: 'FINISHED_GOOD',
                category: invItem.category,
                taxPercent: invItem.gstRate || 5,
                hsnCode: invItem.hsnCode,
                isActive: true,
                isVeg: true,
                is_menu_item: false
              }
            });
          } else {
            throw new Error(`Item "${item.productName}" is missing a valid mapped Product or InventoryItem.`);
          }
        }
      }

      const newOrder = await tx.order.create({
        data: {
          invoiceNum: await nextDocumentNumber(tx, 'INV', 'INV'),
          partyType: proforma.partyType || 'CUSTOMER',
          partyId: proforma.partyId,
          customerId: proforma.customerId,
          customerName: proforma.customerName,
          franchiseId: franchiseId!,
          orderType: 'TAX_INVOICE',
          status: 'PENDING',
          paymentStatus: 'UNPAID',
          subTotal: proforma.subTotal,
          taxAmount: proforma.taxAmount,
          discountAmount: proforma.discountAmount,
          totalAmount: proforma.totalAmount,
          sourceQuotationId: sourceSalesOrder?.quotationId || undefined,
          sourceProformaInvoiceId: proforma.id,
          orderItems: {
            create: proforma.items.map((item) => ({
              productId: item.productId!,
              quantity: item.quantity,
              price: item.rate,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { orderItems: true },
      });

      // Initial payment state is always zero — a Tax Invoice never carries
      // money forward from the Estimate/Proforma stage (see money rules:
      // no cash/bank movement before this point). 'UNPAID' regardless of
      // whatever total is owed; Customer Payments is the only thing
      // allowed to move this status (see FinanceService.createPayment).
      await tx.invoice.create({
        data: {
          orderId: newOrder.id,
          totalAmount: proforma.subTotal,
          taxAmount: proforma.taxAmount,
          finalAmount: proforma.totalAmount,
          status: 'UNPAID',
          description: `Generated from Proforma Invoice ${proforma.proformaNumber}`,
          notes: proforma.notes,
        },
      });

      await tx.proformaInvoice.update({
        where: { id: proformaInvoiceId },
        data: { status: 'CONVERTED', convertedInvoiceId: newOrder.id },
      });

      // sourceSalesOrder.status is already 'PROCESSING' by this point — set
      // at Proforma-creation time in convertSalesOrderToProforma, the actual
      // causal moment for that transition (see comment there).

      return newOrder;
      });
    } catch (err: any) {
      // True concurrent double-click/multi-tab race: two requests both
      // passed the `if (proforma.convertedInvoiceId)` check above before
      // either committed. The DB-level @unique on convertedInvoiceId is the
      // hard backstop — the loser hits P2002 here instead of creating a
      // second Tax Invoice; return the winner's row instead of erroring.
      if (err?.code === 'P2002') {
        const proformaNow = await prisma.proformaInvoice.findUnique({ where: { id: proformaInvoiceId } });
        if (proformaNow?.convertedInvoiceId) {
          const existing = await prisma.order.findUnique({ where: { id: proformaNow.convertedInvoiceId }, include: { orderItems: true, invoice: true } });
          if (existing) return existing;
        }
      }
      throw err;
    }
  }

  static async createProformaInvoice(data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    paymentTerms?: string;
    notes?: string;
    createdBy?: string;
    proformaNumber?: string;
    status?: any;
  }) {
    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;
    const partyType = data.partyType || 'CUSTOMER';
    const customerId = partyType === 'CUSTOMER' ? data.customerId : undefined;
    const customerName = partyType === 'CUSTOMER' ? await resolveCustomerName(customerId, data.customerName) : (data.customerName || undefined);

    return prisma.$transaction(async (tx) => tx.proformaInvoice.create({
      data: {
        proformaNumber: data.proformaNumber || await nextDocumentNumber(tx, 'PI', 'PI'),
        partyType: partyType as any,
        partyId: data.partyId,
        customerId,
        customerName,
        customerPhone: data.customerPhone,
        status: data.status || 'DRAFT',
        subTotal,
        taxAmount,
        discountAmount: discount,
        totalAmount: totalAmount - discount,
        paymentTerms: data.paymentTerms,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            taxPercent: item.taxPercent,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount,
          })),
        },
      },
      include: { items: true, customer: true },
    }));
  }

  static async updateProformaInvoice(id: string, data: {
    partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE';
    partyId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    customerEmail?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    paymentTerms?: string;
    notes?: string;
    status?: any;
  }) {
    const existing = await prisma.proformaInvoice.findUnique({ where: { id } });
    if (!existing) throw new Error('Proforma Invoice not found');
    if (existing.status !== 'DRAFT') throw new Error(`Cannot update Proforma Invoice in ${existing.status} status`);

    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;
    const partyType = data.partyType || existing.partyType || 'CUSTOMER';
    const customerId = partyType === 'CUSTOMER' ? (data.customerId || existing.customerId) : undefined;
    const customerName = partyType === 'CUSTOMER' ? await resolveCustomerName(customerId || undefined, data.customerName) : (data.customerName || undefined);

    return prisma.$transaction(async (tx) => {
      await tx.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: id } });

      return tx.proformaInvoice.update({
        where: { id },
        data: {
          partyType: partyType as any,
          partyId: data.partyId !== undefined ? data.partyId : existing.partyId,
          customerId,
          customerName,
          customerPhone: data.customerPhone !== undefined ? data.customerPhone : existing.customerPhone,
          status: data.status || existing.status,
          subTotal,
          taxAmount,
          discountAmount: discount,
          totalAmount: totalAmount - discount,
          paymentTerms: data.paymentTerms !== undefined ? data.paymentTerms : existing.paymentTerms,
          notes: data.notes !== undefined ? data.notes : existing.notes,
          items: {
            create: computed.map((item) => ({
              productId: item.productId,
              productName: item.productName,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              taxPercent: item.taxPercent,
              taxAmount: item.taxAmount,
              totalAmount: item.totalAmount,
            })),
          },
        },
        include: { items: true, customer: true },
      });
    });
  }

  static async updateProformaStatus(id: string, status: any) {
    const existing = await prisma.proformaInvoice.findUnique({ where: { id } });
    if (!existing) throw new Error('Proforma Invoice not found');
    
    return prisma.proformaInvoice.update({
      where: { id },
      data: { status },
      include: { items: true, customer: true },
    });
  }

  static async getProformaInvoices(filters: { status?: string; customerId?: string; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.search) {
      where.OR = [
        { proformaNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    const results = await prisma.proformaInvoice.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' },
    });

    const soIds = results.map((r: any) => r.sourceSalesOrderId).filter(Boolean) as string[];
    let soMap = new Map<string, string>();
    if (soIds.length > 0) {
      const salesOrders = await prisma.salesOrder.findMany({
        where: { id: { in: soIds } },
        select: { id: true, orderNumber: true }
      });
      soMap = new Map(salesOrders.map(so => [so.id, so.orderNumber]));
    }

    return results.map((r: any) => ({
      ...r,
      sourceSalesOrderNumber: r.sourceSalesOrderId ? soMap.get(r.sourceSalesOrderId) : undefined
    }));
  }

  static async getProformaInvoiceById(id: string) {
    const proforma = await prisma.proformaInvoice.findUnique({
      where: { id },
      include: { customer: true, items: true },
    });

    if (proforma?.sourceSalesOrderId) {
      const so = await prisma.salesOrder.findUnique({
        where: { id: proforma.sourceSalesOrderId },
        select: { orderNumber: true }
      });
      if (so) {
        (proforma as any).sourceSalesOrderNumber = so.orderNumber;
      }
    }

    return proforma;
  }

  // ─── Sales Orders ────────────────────────────────────────────────────────────

  static async getSalesOrders(filters: { status?: string; customerId?: string; search?: string; startDate?: string; endDate?: string }) {
    const where: any = {};
    if (filters.status && filters.status !== 'ALL') {
      if (filters.status === 'OPEN') {
        where.status = { in: ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED'] };
      } else if (filters.status === 'CLOSED') {
        where.status = 'DELIVERED';
      } else {
        where.status = filters.status as any;
      }
    }
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.startDate || filters.endDate) {
      where.createdAt = {
        ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
        ...(filters.endDate ? { lte: new Date(filters.endDate) } : {})
      };
    }
    if (filters.search) {
      where.OR = [
        { orderNumber: { contains: filters.search, mode: 'insensitive' } },
        { customerName: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.salesOrder.findMany({
      where,
      include: { customer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getSalesOrderById(id: string) {
    const order = await prisma.salesOrder.findUnique({
      where: { id },
      include: { customer: true, items: true, returns: true }
    });
    if (order?.quotationId) {
      const quotation = await prisma.quotation.findUnique({ where: { id: order.quotationId } });
      return { ...order, quotation };
    }
    return order;
  }

  static async createSalesOrder(data: {
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate: number; taxPercent?: number }>;
    discountAmount?: number;
    deliveryDate?: string;
    deliveryAddress?: string;
    notes?: string;
    createdBy?: string;
    idempotencyKey?: string;
  }) {
    // Unlike convertQuotationToSalesOrder (deduped against its source
    // Estimate) this is the direct-create path with no source document to
    // key off — a retry/double-click/API re-entry with the same key must
    // return the already-created SalesOrder instead of posting a second
    // one. Mirrors FinanceService.createPayment's idempotencyKey handling.
    if (data.idempotencyKey) {
      const existing = await prisma.salesOrder.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return existing;
    }

    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(data.items);
    const discount = data.discountAmount || 0;

    try {
      return await prisma.$transaction(async (tx) => tx.salesOrder.create({
      data: {
        orderNumber: await nextDocumentNumber(tx, 'SO', 'SO'),
        idempotencyKey: data.idempotencyKey || undefined,
        customerId: data.customerId,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        subTotal,
        taxAmount,
        discountAmount: discount,
        totalAmount: totalAmount - discount,
        deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined,
        deliveryAddress: data.deliveryAddress,
        notes: data.notes,
        createdBy: data.createdBy,
        items: {
          create: computed.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unit: item.unit,
            rate: item.rate,
            taxPercent: item.taxPercent || 0,
            taxAmount: item.taxAmount,
            totalAmount: item.totalAmount
          }))
        }
      },
      include: { customer: true, items: true }
      }));
    } catch (err: any) {
      // True concurrent double-click race: two requests both passed the
      // idempotencyKey check above before either committed. The @unique
      // constraint is the hard backstop — return the winner's row.
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.salesOrder.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  static async updateSalesOrder(id: string, data: any) {
    // proformaInvoiceId is a duplicate-prevention marker only the atomic
    // convertSalesOrderToProforma() transaction is allowed to set — a
    // generic PATCH must never let a client fake "a Proforma already
    // exists" (or clear a real one) directly.
    const { proformaInvoiceId, ...safeData } = data;
    return prisma.salesOrder.update({
      where: { id },
      data: {
        ...safeData,
        status: data.status as any,
        deliveryDate: data.deliveryDate ? new Date(data.deliveryDate) : undefined
      },
      include: { items: true }
    });
  }

  static async recordPayment(orderId: string, data: { accountId: string; method: string; amount: number; createdBy?: string }) {
    const { FinanceService } = require('../finance/finance.service');
    
    return prisma.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUnique({ where: { id: orderId } });
      if (!order) throw new Error('Sales Order not found');

      const payment = await FinanceService.createPayment({
        tx,
        amount: data.amount,
        flow: 'IN',
        status: 'PAID',
        sourceAccount: data.accountId,
        method: data.method,
        sourceModule: 'POS', // Use POS for all sales-related inflows for now
        linkedDocType: 'INVOICE',
        linkedDocId: order.id,
        entity: order.customerName || 'Customer',
        createdBy: data.createdBy
      });

      await tx.salesOrder.update({
        where: { id: orderId },
        data: { paymentStatus: 'PAID' }
      });

      return payment;
    });
  }

  // ─── Return Orders (RMA) ─────────────────────────────────────────────────────

  static async getReturnOrders(filters: { status?: string; customerId?: string; franchiseId?: string; source?: 'FRANCHISE' | 'BUSINESS' | 'POS'; search?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.franchiseId) where.franchiseId = filters.franchiseId;

    if (filters.source === 'FRANCHISE') {
      where.franchiseId = { not: null };
    } else if (filters.source === 'BUSINESS') {
      where.customerId = { not: null };
    } else if (filters.source === 'POS') {
      where.posOrderId = { not: null };
    }

    if (filters.search) {
      where.OR = [
        { returnNumber: { contains: filters.search, mode: 'insensitive' } },
        { reason: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.returnOrder.findMany({
      where,
      include: { customer: true, salesOrder: true, franchise: true, franchiseOrder: true, posOrder: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createReturnOrder(data: {
    salesOrderId?: string;
    franchiseOrderId?: string;
    posOrderId?: string;
    customerId?: string;
    franchiseId?: string;
    reason: string;
    items: Array<{ productId?: string; productName: string; quantity: number; rate: number; condition?: string }>;
    refundMethod?: string;
  }) {
    const refundAmount = data.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);

    return prisma.returnOrder.create({
      data: {
        returnNumber: await generateReturnNumber(),
        salesOrderId: data.salesOrderId,
        franchiseOrderId: data.franchiseOrderId,
        posOrderId: data.posOrderId,
        customerId: data.customerId,
        franchiseId: data.franchiseId,
        reason: data.reason,
        refundAmount,
        refundMethod: data.refundMethod,
        items: {
          create: data.items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            rate: item.rate,
            totalAmount: item.quantity * item.rate,
            condition: item.condition
          }))
        }
      },
      include: { customer: true, franchise: true, posOrder: true, items: true }
    });
  }

  static async updateReturnOrder(id: string, data: { status?: string; approvedBy?: string }) {
    return prisma.returnOrder.update({
      where: { id },
      data: {
        status: data.status as any,
        approvedBy: data.approvedBy,
        approvedAt: data.status === 'APPROVED' ? new Date() : undefined
      }
    });
  }

  static async recordRefund(returnId: string, data: { accountId: string; method: string; createdBy?: string }) {
    const { FinanceService } = require('../finance/finance.service');

    return prisma.$transaction(async (tx) => {
      const ret = await tx.returnOrder.findUnique({ where: { id: returnId } });
      if (!ret) throw new Error('Return Order not found');
      if (ret.status !== 'APPROVED') throw new Error('Only approved returns can be refunded');

      const entity = ret.customerId ? 'Customer Refund' : (ret.franchiseId ? 'Franchise Refund' : 'Sales Refund');

      const payment = await FinanceService.createPayment({
        tx,
        amount: ret.refundAmount,
        flow: 'OUT',
        status: 'PAID',
        sourceAccount: data.accountId,
        method: data.method,
        sourceModule: 'POS',
        linkedDocType: 'DIRECT',
        linkedDocId: ret.id,
        entity,
        createdBy: data.createdBy
      });

      await tx.returnOrder.update({
        where: { id: returnId },
        data: { status: 'COMPLETED' }
      });

      return payment;
    });
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  static async getSalesAnalytics(filters: { dateFrom?: string; dateTo?: string }) {
    const where: any = {};
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {
        ...(filters.dateFrom ? { gte: new Date(filters.dateFrom) } : {}),
        ...(filters.dateTo ? { lte: new Date(filters.dateTo) } : {})
      };
    }

    const [orders, quotations, returns] = await Promise.all([
      prisma.salesOrder.findMany({ where, include: { items: true } }),
      prisma.quotation.findMany({ where }),
      prisma.returnOrder.findMany({ where })
    ]);

    const totalRevenue = orders.reduce((s, o) => s + o.totalAmount, 0);
    const totalReturns = returns.reduce((s, r) => s + r.refundAmount, 0);
    const conversionRate = quotations.length
      ? (quotations.filter((q) => q.status === 'CONVERTED').length / quotations.length) * 100
      : 0;

    return {
      totalOrders: orders.length,
      totalRevenue,
      totalQuotations: quotations.length,
      convertedQuotations: quotations.filter((q) => q.status === 'CONVERTED').length,
      conversionRate: Number(conversionRate.toFixed(1)),
      totalReturns: returns.length,
      totalReturnAmount: totalReturns,
      netRevenue: totalRevenue - totalReturns
    };
  }

  // ─── Delivery Challans ───────────────────────────────────────────────────────

  // A challan has exactly one destination — Customer, Dealer, or Franchise —
  // never more than one. Dealer is architecturally equivalent to Customer for
  // stock accounting (external party, no receiving ledger of its own) but is
  // a distinct master, so it gets its own column rather than overloading
  // customerId. Doesn't require exactly one (a DRAFT may have none yet,
  // matching existing Customer/Franchise behavior — the frontend enforces
  // "required" only once the challan actually goes IN_TRANSIT).
  private static assertSingleDestination(customerId?: string | null, dealerId?: string | null, franchiseId?: string | null) {
    const provided = [customerId, dealerId, franchiseId].filter(Boolean);
    if (provided.length > 1) {
      throw new Error('A delivery challan can only have one destination: Customer, Dealer, or Franchise.');
    }
  }

  static async getDeliveryChallans(filters: { customerId?: string; status?: string; search?: string }) {
    // One-time safe migration: legacy rows stored status 'OPEN' before the IN_TRANSIT rename
    await prisma.deliveryChallan.updateMany({ where: { status: 'OPEN' }, data: { status: 'IN_TRANSIT' } });

    const where: any = {};
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.status) where.status = filters.status;
    if (filters.search) {
      where.OR = [
        { challanNumber: { contains: filters.search, mode: 'insensitive' } },
        { vehicleNo: { contains: filters.search, mode: 'insensitive' } }
      ];
    }
    return prisma.deliveryChallan.findMany({
      where,
      include: { customer: true, dealer: true, items: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getDeliveryChallanById(id: string) {
    return prisma.deliveryChallan.findUnique({
      where: { id },
      include: { customer: true, dealer: true, items: true, returns: { include: { items: true } } }
    });
  }

  // Invoice Qty vs Dispatch Qty (see schema comment on DeliveryChallan) —
  // sums quantity already committed to OTHER non-cancelled DCs against the
  // same source Tax Invoice, per product, so a second/third partial
  // dispatch can never push the cumulative total past what was invoiced.
  private static async getRemainingInvoiceQty(sourceInvoiceId: string, excludeChallanId?: string): Promise<Record<string, { invoiceQty: number; dispatchedQty: number; remaining: number }>> {
    const order = await prisma.order.findUnique({ where: { id: sourceInvoiceId }, include: { orderItems: true } });
    if (!order) throw new Error('Source Tax Invoice not found.');

    const otherChallans = await prisma.deliveryChallan.findMany({
      where: { sourceInvoiceId, status: { not: 'CANCELLED' }, ...(excludeChallanId ? { id: { not: excludeChallanId } } : {}) },
      include: { items: true }
    });

    const dispatchedByProduct: Record<string, number> = {};
    for (const dc of otherChallans) {
      for (const item of dc.items) {
        if (!item.productId) continue;
        dispatchedByProduct[item.productId] = (dispatchedByProduct[item.productId] || 0) + item.quantity;
      }
    }

    const result: Record<string, { invoiceQty: number; dispatchedQty: number; remaining: number }> = {};
    for (const oi of order.orderItems) {
      const dispatchedQty = dispatchedByProduct[oi.productId] || 0;
      result[oi.productId] = { invoiceQty: oi.quantity, dispatchedQty, remaining: Math.max(0, oi.quantity - dispatchedQty) };
    }
    return result;
  }

  static async createDeliveryChallan(data: {
    customerId?: string;
    dealerId?: string;
    salesOrderId?: string;
    sourceInvoiceId?: string;
    franchiseId?: string;
    sourceFranchiseId?: string;
    challanDate?: string;
    dueDate?: string;
    vehicleNo?: string;
    driverName?: string;
    stateOfSupply?: string;
    status?: string;
    notes?: string;
    termsConditions?: string;
    items: Array<{ productId?: string; productName: string; quantity: number; unit?: string; rate?: number; taxPercent?: number; batchNumber?: string }>;
    idempotencyKey?: string;
  }, userId: string = 'system') {
    // A retry/double-click/API re-entry with the same key returns the
    // already-created Challan instead of posting a second one — the DC has
    // no source document to naturally dedup against (unlike Estimate->SO).
    if (data.idempotencyKey) {
      const existing = await prisma.deliveryChallan.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { customer: true, dealer: true, items: true } });
      if (existing) return existing;
    }

    SalesService.assertSingleDestination(data.customerId, data.dealerId, data.franchiseId);
    if (data.dealerId) {
      const dealer = await prisma.dealer.findUnique({ where: { id: data.dealerId } });
      if (!dealer) throw new Error('Selected dealer not found.');
    }

    // Invoice Qty vs Dispatch Qty: only enforced going IN_TRANSIT (a DRAFT
    // is just a plan and may still change) and only for source-invoice-
    // linked challans (a DIRECT challan has no invoice qty to cap against).
    if (data.sourceInvoiceId && data.status === 'IN_TRANSIT') {
      const remaining = await SalesService.getRemainingInvoiceQty(data.sourceInvoiceId);
      for (const item of data.items) {
        if (!item.productId) continue;
        const r = remaining[item.productId];
        if (!r) continue; // item not on the source invoice — allow (e.g. a substitute), don't block
        if (item.quantity > r.remaining + 0.001) {
          throw new Error(`Cannot dispatch ${item.quantity} of "${item.productName}" — only ${r.remaining} remains undispatched (Invoice Qty ${r.invoiceQty}, already dispatched ${r.dispatchedQty}).`);
        }
      }
    }

    const { computed, subTotal, taxAmount, totalAmount } = calculateTotals(
      data.items.map((i) => ({ ...i, rate: i.rate || 0, taxPercent: i.taxPercent || 0 }))
    );

    try {
      return await prisma.$transaction(async (tx) => {
        const challanNumber = await nextDocumentNumber(tx, 'DC', 'DC');

        const newChallan = await tx.deliveryChallan.create({
          data: {
            challanNumber,
            idempotencyKey: data.idempotencyKey || undefined,
            customerId: data.customerId || null,
            dealerId: data.dealerId || null,
            salesOrderId: data.salesOrderId || null,
            sourceInvoiceId: data.sourceInvoiceId || null,
            franchiseId: data.franchiseId || null,
            sourceFranchiseId: data.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id || null,
            status: data.status || 'DRAFT',
            challanDate: data.challanDate ? new Date(data.challanDate) : new Date(),
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            vehicleNo: data.vehicleNo || null,
            driverName: data.driverName || null,
            stateOfSupply: data.stateOfSupply || null,
            notes: data.notes || null,
            termsConditions: data.termsConditions || null,
            subTotal,
            taxAmount,
            totalAmount,
            items: {
              create: computed.map((i) => ({
                productId: i.productId || null,
                productName: i.productName,
                batchNumber: (i as any).batchNumber || null,
                quantity: i.quantity,
                unit: i.unit || 'NONE',
                rate: i.rate,
                taxPercent: i.taxPercent || 0,
                taxAmount: i.taxAmount,
                totalAmount: i.totalAmount
              }))
            }
          },
          include: { customer: true, dealer: true, items: true }
        });

        if (newChallan.status === 'IN_TRANSIT') {
          await SalesService.dispatchChallanStock(newChallan, userId, tx);
        }

        return newChallan;
      });
    } catch (err: any) {
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.deliveryChallan.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { customer: true, dealer: true, items: true } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  static async updateDeliveryChallan(id: string, data: { status?: string; vehicleNo?: string; driverName?: string; notes?: string; customerId?: string | null; dealerId?: string | null; franchiseId?: string | null }, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      const currentChallan = await tx.deliveryChallan.findUnique({ where: { id }, include: { items: true } });
      if (!currentChallan) throw new Error('Delivery challan not found');

      // Legacy rows/clients may still send/hold 'OPEN' — treat it as IN_TRANSIT
      const currentStatus = currentChallan.status === 'OPEN' ? 'IN_TRANSIT' : currentChallan.status;
      if (data.status === 'OPEN') data.status = 'IN_TRANSIT';

      // Idempotent no-op: repeat "Dispatch"/"Mark Delivered" clicks land here
      // with the SAME target status as the current one — status validation
      // below would otherwise reject e.g. IN_TRANSIT -> IN_TRANSIT, but a
      // duplicate click must be a harmless no-op, not an error toast.
      if (data.status && data.status === currentStatus) {
        return tx.deliveryChallan.findUnique({ where: { id }, include: { customer: true, dealer: true, items: true } });
      }

      // Block moving away from CLOSED once delivered
      if (currentStatus === 'CLOSED' && data.status && data.status !== 'CLOSED') {
        throw new Error('Cannot change status of a closed delivery challan');
      }

      if ('customerId' in data || 'dealerId' in data || 'franchiseId' in data) {
        SalesService.assertSingleDestination(
          'customerId' in data ? data.customerId : currentChallan.customerId,
          'dealerId' in data ? data.dealerId : currentChallan.dealerId,
          'franchiseId' in data ? data.franchiseId : currentChallan.franchiseId
        );
        if (data.dealerId) {
          const dealer = await tx.dealer.findUnique({ where: { id: data.dealerId } });
          if (!dealer) throw new Error('Selected dealer not found.');
        }
      }

      // Invoice Qty vs Dispatch Qty guard also applies to Draft -> Dispatch
      // (createDeliveryChallan only checks it for a challan created
      // already-IN_TRANSIT — most challans start DRAFT then dispatch later).
      if (currentChallan.sourceInvoiceId && currentStatus === 'DRAFT' && data.status === 'IN_TRANSIT') {
        const remaining = await SalesService.getRemainingInvoiceQty(currentChallan.sourceInvoiceId, id);
        for (const item of currentChallan.items) {
          if (!item.productId) continue;
          const r = remaining[item.productId];
          if (!r) continue;
          if (item.quantity > r.remaining + 0.001) {
            throw new Error(`Cannot dispatch ${item.quantity} of "${item.productName}" — only ${r.remaining} remains undispatched (Invoice Qty ${r.invoiceQty}, already dispatched ${r.dispatchedQty}).`);
          }
        }
      }

      const updated = await tx.deliveryChallan.update({ where: { id }, data, include: { customer: true, dealer: true, items: true } });

      // Handle Stock Transitions
      if (currentStatus === 'DRAFT' && updated.status === 'IN_TRANSIT') {
        await SalesService.dispatchChallanStock(updated, userId, tx);
      } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CLOSED') {
        await SalesService.receiveChallanStock(updated, userId, tx);
      } else if (currentStatus === 'IN_TRANSIT' && updated.status === 'CANCELLED') {
        await SalesService.reverseChallanStock(updated, userId, tx);
      }

      return updated;
    }, { timeout: 20000 });
  }

  // Explicit delivery confirmation — separate from a generic status PATCH so
  // receivedBy/deliveredAt/podReference are never left blank on a CLOSED
  // challan, and a repeat click is a safe no-op (already CLOSED -> return
  // as-is) rather than a second stock receipt.
  static async markChallanDelivered(id: string, data: { receivedBy?: string; deliveredAt?: string; podReference?: string }, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      const currentChallan = await tx.deliveryChallan.findUnique({ where: { id }, include: { items: true } });
      if (!currentChallan) throw new Error('Delivery challan not found');
      const currentStatus = currentChallan.status === 'OPEN' ? 'IN_TRANSIT' : currentChallan.status;

      if (currentStatus === 'CLOSED') {
        return tx.deliveryChallan.findUnique({ where: { id }, include: { customer: true, dealer: true, items: true } });
      }
      if (currentStatus !== 'IN_TRANSIT') {
        throw new Error(`Only an IN_TRANSIT delivery challan can be marked Delivered (current status: ${currentStatus}).`);
      }

      const updated = await tx.deliveryChallan.update({
        where: { id },
        data: {
          status: 'CLOSED',
          receivedBy: data.receivedBy || null,
          deliveredAt: data.deliveredAt ? new Date(data.deliveredAt) : new Date(),
          podReference: data.podReference || null,
        },
        include: { customer: true, dealer: true, items: true }
      });

      await SalesService.receiveChallanStock(updated, userId, tx);
      return updated;
    }, { timeout: 20000 });
  }

  // Transit Stock — deliberately not its own table (see schema comment):
  // derived read of every IN_TRANSIT challan, exploded per item, with the
  // fields the Transit Stock view needs. "Warehouse" here is the source
  // franchise's primary warehouse — see InventoryService.computeWarehouseStock
  // for the same franchise<->warehouse attribution used for stock reports.
  // Real UOM source of truth, in priority order: the DC line's own unit (if
  // actually set to something other than the placeholder default) -> the
  // dispatching franchise's InventoryItem for that SKU -> "NONE" only if
  // truly nothing else is known. Fixes the "10 NONE" display bug, which
  // came from trusting DeliveryChallanItem.unit's schema default blindly.
  private static async resolveDisplayUnit(item: { unit: string; productId: string | null }, sourceFranchiseId: string | null): Promise<string> {
    if (item.unit && item.unit !== 'NONE') return item.unit;
    if (!item.productId || !sourceFranchiseId) return item.unit || 'NONE';
    const product = await prisma.product.findUnique({ where: { id: item.productId }, select: { sku: true } });
    if (!product?.sku) return item.unit || 'NONE';
    const invItem = await prisma.inventoryItem.findFirst({ where: { franchiseId: sourceFranchiseId, sku: product.sku }, select: { unit: true } });
    return invItem?.unit || item.unit || 'NONE';
  }

  private static resolvePartyType(dc: { customerId: string | null; dealerId: string | null; franchiseId: string | null }): string {
    return dc.customerId ? 'CUSTOMER' : dc.dealerId ? 'DEALER' : dc.franchiseId ? 'FRANCHISE' : 'UNKNOWN';
  }

  static async getTransitStock() {
    const challans = await prisma.deliveryChallan.findMany({
      where: { status: 'IN_TRANSIT' },
      include: { customer: true, dealer: true, items: true },
      orderBy: { challanDate: 'desc' }
    });

    const franchiseIds = [...new Set([
      ...challans.map(c => c.sourceFranchiseId),
      ...challans.map(c => c.franchiseId),
    ].filter(Boolean))] as string[];
    const franchises = franchiseIds.length
      ? await prisma.franchise.findMany({ where: { id: { in: franchiseIds } }, include: { primaryWarehouse: true } })
      : [];
    const franchiseById = new Map(franchises.map(f => [f.id, f]));

    const rows: any[] = [];
    for (const dc of challans) {
      const partyType = SalesService.resolvePartyType(dc);
      const partyName = dc.customer?.name || dc.dealer?.name || (dc.franchiseId ? franchiseById.get(dc.franchiseId)?.name : null) || null;
      const sourceFranchise = dc.sourceFranchiseId ? franchiseById.get(dc.sourceFranchiseId) : null;
      for (const item of dc.items) {
        rows.push({
          challanId: dc.id,
          challanNumber: dc.challanNumber,
          sourceDocument: dc.sourceInvoiceId ? 'SALES_INVOICE' : 'DIRECT',
          sourceInvoiceId: dc.sourceInvoiceId,
          salesOrderId: dc.salesOrderId,
          partyType,
          partyName,
          franchiseId: dc.franchiseId,
          sourceFranchiseId: dc.sourceFranchiseId,
          sourceWarehouseName: sourceFranchise?.primaryWarehouse?.name || sourceFranchise?.name || null,
          productId: item.productId,
          productName: item.productName,
          batchNumber: item.batchNumber,
          quantity: item.quantity,
          unit: await SalesService.resolveDisplayUnit(item, dc.sourceFranchiseId),
          dispatchDate: dc.challanDate,
          vehicleNo: dc.vehicleNo,
          driverName: dc.driverName,
          status: 'IN_TRANSIT',
        });
      }
    }
    return rows;
  }

  // Dispatch Tracking — shipment-level (one row per Delivery Challan, not
  // per item, unlike Transit Stock which is quantity-level). Deliberately
  // NOT its own table: DeliveryChallan already carries every field this
  // view needs (status, vehicle, driver, dates, receivedBy/POD), so a
  // separate DispatchTracking model would just be a duplicate dispatch
  // record kept in sync by hand. "Dispatch ID" reuses the same DC-YYYY-N
  // sequence value under a DSP- prefix rather than minting a second
  // sequence for what is definitionally the same one-to-one shipment.
  static async getDispatchTracking(filters: { status?: string } = {}) {
    const challans = await prisma.deliveryChallan.findMany({
      where: filters.status ? { status: filters.status === 'OPEN' ? 'IN_TRANSIT' : filters.status } : undefined,
      include: { customer: true, dealer: true, items: true },
      orderBy: { challanDate: 'desc' }
    });

    const franchiseIds = [...new Set([
      ...challans.map(c => c.sourceFranchiseId),
      ...challans.map(c => c.franchiseId),
    ].filter(Boolean))] as string[];
    const franchises = franchiseIds.length
      ? await prisma.franchise.findMany({ where: { id: { in: franchiseIds } } })
      : [];
    const franchiseById = new Map(franchises.map(f => [f.id, f]));

    // sourceInvoiceId is an Order.id — resolve the human-readable invoice
    // number for the ones that have one, in a single batched query.
    const invoiceIds = [...new Set(challans.map(c => c.sourceInvoiceId).filter(Boolean))] as string[];
    const orders = invoiceIds.length
      ? await prisma.order.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNum: true } })
      : [];
    const invoiceNumById = new Map(orders.map(o => [o.id, o.invoiceNum]));

    return challans.map(dc => {
      const status = dc.status === 'OPEN' ? 'IN_TRANSIT' : dc.status;
      const dispatchId = dc.challanNumber.replace(/^DC-/, 'DSP-');
      const partyType = SalesService.resolvePartyType(dc);
      const partyName = dc.customer?.name || dc.dealer?.name || (dc.franchiseId ? franchiseById.get(dc.franchiseId)?.name : null) || null;
      return {
        dispatchId,
        challanId: dc.id,
        challanNumber: dc.challanNumber,
        sourceInvoiceId: dc.sourceInvoiceId,
        invoiceNumber: dc.sourceInvoiceId ? invoiceNumById.get(dc.sourceInvoiceId) || null : null,
        salesOrderId: dc.salesOrderId,
        partyType,
        partyName,
        vehicleNo: dc.vehicleNo,
        driverName: dc.driverName,
        dispatchDate: dc.challanDate,
        expectedDeliveryDate: dc.dueDate,
        deliveredAt: dc.deliveredAt,
        receivedBy: dc.receivedBy,
        podReference: dc.podReference,
        itemCount: dc.items.length,
        totalQty: dc.items.reduce((s, i) => s + i.quantity, 0),
        status,
      };
    });
  }

  // ─── Delivery Challan Returns ─────────────────────────────────────────────
  // Physical goods return only — never touches Payment/Invoice/Order (see
  // schema comment on DeliveryChallanReturn). Sections 22-31 of the dispatch
  // spec: original dispatched quantity is never edited; each return is its
  // own row, and cumulative returns can never exceed what was dispatched.

  static async getDeliveryChallanReturns(filters: { challanId?: string } = {}) {
    return prisma.deliveryChallanReturn.findMany({
      where: filters.challanId ? { challanId: filters.challanId } : undefined,
      include: { items: true, challan: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async createDeliveryChallanReturn(data: {
    challanId: string;
    reason: string;
    otherReason?: string;
    items: Array<{ challanItemId: string; quantity: number }>;
    idempotencyKey?: string;
  }, userId: string = 'system') {
    if (data.idempotencyKey) {
      const existing = await prisma.deliveryChallanReturn.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { items: true } });
      if (existing) return existing;
    }

    const challan = await prisma.deliveryChallan.findUnique({ where: { id: data.challanId }, include: { items: true } });
    if (!challan) throw new Error('Delivery challan not found.');
    const status = challan.status === 'OPEN' ? 'IN_TRANSIT' : challan.status;
    if (status !== 'IN_TRANSIT' && status !== 'CLOSED') {
      throw new Error(`Cannot return goods from a challan that hasn't dispatched yet (current status: ${status}).`);
    }
    if (!data.items.length) throw new Error('Select at least one item to return.');

    // Returnable = dispatched - sum of all previously returned qty for that
    // exact challan line (across every prior return, PENDING or RECEIVED —
    // a return already claims the qty the moment it's raised).
    const priorReturnItems = await prisma.deliveryChallanReturnItem.findMany({
      where: { challanItemId: { in: data.items.map(i => i.challanItemId) } }
    });
    const previouslyReturned: Record<string, number> = {};
    for (const ri of priorReturnItems) {
      previouslyReturned[ri.challanItemId] = (previouslyReturned[ri.challanItemId] || 0) + ri.quantity;
    }

    const itemsToCreate: Array<{ challanItemId: string; productId: string | null; productName: string; quantity: number; unit: string }> = [];
    for (const reqItem of data.items) {
      const dcItem = challan.items.find(i => i.id === reqItem.challanItemId);
      if (!dcItem) throw new Error('Return line does not match any item on this delivery challan.');
      const already = previouslyReturned[dcItem.id] || 0;
      const returnable = dcItem.quantity - already;
      if (reqItem.quantity <= 0) throw new Error(`Return quantity for "${dcItem.productName}" must be greater than zero.`);
      if (reqItem.quantity > returnable + 0.001) {
        throw new Error(`Cannot return ${reqItem.quantity} of "${dcItem.productName}" — Dispatched ${dcItem.quantity}, already returned ${already}, returnable ${returnable}.`);
      }
      itemsToCreate.push({ challanItemId: dcItem.id, productId: dcItem.productId, productName: dcItem.productName, quantity: reqItem.quantity, unit: dcItem.unit });
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const returnNumber = await nextDocumentNumber(tx, 'DCR', 'DCR');
        return tx.deliveryChallanReturn.create({
          data: {
            returnNumber,
            challanId: data.challanId,
            reason: data.reason,
            otherReason: data.otherReason || null,
            status: 'PENDING',
            createdBy: userId,
            idempotencyKey: data.idempotencyKey || undefined,
            items: { create: itemsToCreate }
          },
          include: { items: true }
        });
      });
    } catch (err: any) {
      if (data.idempotencyKey && err?.code === 'P2002') {
        const winner = await prisma.deliveryChallanReturn.findUnique({ where: { idempotencyKey: data.idempotencyKey }, include: { items: true } });
        if (winner) return winner;
      }
      throw err;
    }
  }

  // Warehouse receipt + condition check (sections 26-28). GOOD goes back
  // into real available stock via the normal stockIn path; DAMAGED/EXPIRED/
  // REJECTED/QUARANTINE get a zero-effect ledger row for traceability only
  // (see RETURN_QUARANTINE_IN on StockMovementType) — deliberately never
  // calls stockIn for those, so available stock is never silently inflated
  // by unusable goods.
  static async receiveDeliveryChallanReturn(returnId: string, itemConditions: Array<{ returnItemId: string; condition: 'GOOD' | 'DAMAGED' | 'EXPIRED' | 'REJECTED' | 'QUARANTINE' }>, userId: string = 'system') {
    return prisma.$transaction(async (tx) => {
      const ret = await tx.deliveryChallanReturn.findUnique({ where: { id: returnId }, include: { items: true, challan: true } });
      if (!ret) throw new Error('Return not found.');
      if (ret.status === 'RECEIVED') return tx.deliveryChallanReturn.findUnique({ where: { id: returnId }, include: { items: true } }); // idempotent no-op

      const sourceId = ret.challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;

      for (const cond of itemConditions) {
        const item = ret.items.find(i => i.id === cond.returnItemId);
        if (!item) continue;
        await tx.deliveryChallanReturnItem.update({ where: { id: item.id }, data: { condition: cond.condition } });
        if (!item.productId || !sourceId) continue;

        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (!product || !product.sku) continue;
        const sourceItem = await tx.inventoryItem.findFirst({ where: { franchiseId: sourceId, sku: product.sku } });
        if (!sourceItem) continue;

        if (cond.condition === 'GOOD') {
          await InventoryService.stockIn({
            itemId: sourceItem.id,
            quantity: item.quantity,
            referenceType: 'DELIVERY_CHALLAN_RETURN',
            referenceId: ret.id,
            note: `Received GOOD condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber})`,
            userId
          }, tx as any);
        } else {
          // Traceable, zero-effect-on-available-stock ledger entry — see
          // the RETURN_QUARANTINE_IN comment on the enum.
          await tx.stockMovement.create({
            data: {
              itemId: sourceItem.id,
              movementType: 'RETURN_QUARANTINE_IN',
              quantity: item.quantity,
              baseQty: 0,
              referenceType: 'DELIVERY_CHALLAN_RETURN',
              referenceId: ret.id,
              note: `Received ${cond.condition} condition return ${ret.returnNumber} (DC ${ret.challan.challanNumber}) — not added to available stock`,
              createdBy: userId,
            }
          });
        }
      }

      return tx.deliveryChallanReturn.update({ where: { id: returnId }, data: { status: 'RECEIVED' }, include: { items: true } });
    }, { timeout: 20000 });
  }

  // --- Helper Stock Movement methods for DC ---

  private static async dispatchChallanStock(challan: any, userId: string, tx: any = prisma) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to dispatch from
    for (const item of challan.items) {
      if (!item.productId) continue;

      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      const sourceItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: sourceId, sku: product.sku }
      });

      if (sourceItem) {
        await InventoryService.stockOut({
          itemId: sourceItem.id,
          quantity: item.quantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: challan.id,
          note: `Dispatched DC ${challan.challanNumber}`,
          userId,
          // Backend-enforced availability check (section 12) — without
          // this, FIFO depletion silently under-fulfills past whatever
          // stock actually exists instead of rejecting the dispatch.
          strictFIFO: true,
        }, tx as any);
      }
    }
  }

  private static async receiveChallanStock(challan: any, userId: string, tx: any = prisma) {
    if (!challan.franchiseId) return; // if sent to customer/dealer directly, no receipt stock to handle (see section 21)

    for (const item of challan.items) {
      if (!item.productId) continue;
      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      let targetItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: challan.franchiseId, sku: product.sku }
      });

      if (!targetItem) {
        targetItem = await tx.inventoryItem.create({
          data: {
            franchiseId: challan.franchiseId,
            sku: product.sku,
            name: product.name,
            unit: item.unit || 'NONE',
            category: 'FINISHED_GOOD',
            currentStock: 0,
            minimumStock: 0
          }
        });
      }

      await InventoryService.stockIn({
        itemId: targetItem.id,
        quantity: item.quantity,
        referenceType: 'DELIVERY_CHALLAN',
        referenceId: challan.id,
        note: `Received DC ${challan.challanNumber}`,
        userId
      }, tx as any);
    }
  }

  private static async reverseChallanStock(challan: any, userId: string, tx: any = prisma) {
    const sourceId = challan.sourceFranchiseId || (await FranchiseService.getHqFranchiseOrNull())?.id;
    if (!sourceId) return; // no source franchise on the challan and no HQ configured — nothing to reverse against
    for (const item of challan.items) {
      if (!item.productId) continue;

      const product = await tx.product.findUnique({ where: { id: item.productId } });
      if (!product || !product.sku) continue;

      const sourceItem = await tx.inventoryItem.findFirst({
        where: { franchiseId: sourceId, sku: product.sku }
      });

      if (sourceItem) {
        await InventoryService.stockIn({
          itemId: sourceItem.id,
          quantity: item.quantity,
          referenceType: 'DELIVERY_CHALLAN',
          referenceId: challan.id,
          note: `Reversed DC ${challan.challanNumber}`,
          userId
        }, tx as any);
      }
    }
  }
}
