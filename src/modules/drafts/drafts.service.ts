import prisma from '../../lib/prisma';

const round2 = (n: number) => Math.round(n * 100) / 100;

export class DraftsService {
  static async getDrafts(userId: string, type: string) {
    const drafts = await prisma.draft.findMany({
      where: { userId, type },
      orderBy: { updatedAt: 'desc' },
    });
    if (type !== 'SALES_INVOICE') return drafts;
    return Promise.all(drafts.map(async d => ({ ...d, invoiceView: await this.toSalesInvoiceView(d) })));
  }

  // A Sales Invoice draft is saved as the editor's form state (Draft.data),
  // not as an Order/Invoice — nothing is posted, numbered, stocked or
  // ledgered until it's confirmed. The View/Print screens read the posted
  // invoice shape (order.orderItems, party relations, saved totals), so this
  // maps the saved draft into that same shape: lines and totals use the
  // editor's own arithmetic (computeRow in SalesInvoicesClient), names/SKUs
  // and party details come from the master records. Read-only — the draft
  // row itself is returned unchanged alongside it.
  static async toSalesInvoiceView(draft: { id: string; data: any; createdAt: Date; updatedAt: Date }) {
    const data = (draft.data && typeof draft.data === 'object') ? draft.data as any : {};
    const withTax = data.priceMode === 'with_tax';
    const lines: any[] = (Array.isArray(data.items) ? data.items : [])
      .filter((it: any) => it && (it.productId || String(it.itemSearch || it.productName || '').trim()));

    const productIds = [...new Set(lines.map(l => l.productId).filter(Boolean))] as string[];
    const [products, invItems] = productIds.length
      ? await Promise.all([
          prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true, taxPercent: true } }),
          prisma.inventoryItem.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, sku: true, unit: true } }),
        ])
      : [[], []];
    const productById = new Map<string, any>([...invItems, ...products].map(p => [p.id, p]));

    let subTotal = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    let itemsAmount = 0;
    const orderItems = lines.map((it: any, idx: number) => {
      const qty = Number(it.qty ?? it.quantity ?? 0) || 0;
      const rate = Number(it.rate ?? it.price ?? 0) || 0;
      const discountPct = Number(it.discountPct ?? 0) || 0;
      const taxPct = Number(it.taxPct ?? it.taxPercent ?? 0) || 0;
      const gross = qty * rate;
      const discAmt = round2(gross * discountPct / 100);
      const net = gross - discAmt;
      const taxAmt = withTax ? round2(net * taxPct / (100 + taxPct)) : round2(net * taxPct / 100);
      const amount = withTax ? round2(net) : round2(net + taxAmt);
      // Tax-exclusive, so subTotal - discount + tax == line amount in both modes.
      subTotal += withTax ? gross - taxAmt : gross;
      totalDiscount += discAmt;
      totalTax += taxAmt;
      itemsAmount += amount;
      const master = it.productId ? productById.get(it.productId) : null;
      const name = master?.name || it.itemSearch || it.productName || '';
      return {
        id: it.id || `${draft.id}-${idx}`,
        productId: it.productId || null,
        productName: name,
        sku: master?.sku || it.sku || null,
        product: { name, sku: master?.sku || it.sku || null, unit: it.unit, taxPercent: taxPct },
        quantity: qty,
        unit: it.unit && it.unit !== 'NONE' ? it.unit : (master?.unit || null),
        price: rate,
        discountPct,
        discountAmount: discAmt,
        taxPercent: taxPct,
        taxAmount: taxAmt,
        totalAmount: amount,
        batchNumber: it.batchNumber || null,
      };
    });

    const deliveryCharge = Number(data.deliveryCharge ?? 0) || 0;
    const totalAmount = itemsAmount + deliveryCharge;
    const roundOff = data.roundOffEnabled === false ? 0 : round2(Math.round(totalAmount) - totalAmount);
    const finalAmount = round2(totalAmount + roundOff);

    // Party: the saved id resolved against its master record, falling back
    // to the snapshot the editor saved (selectedCustomer) and typed name.
    const partyType = data.partyType || (data.selectedCustomer?.isFranchise ? 'FRANCHISE' : data.selectedCustomer?.isDealer ? 'DEALER' : 'CUSTOMER');
    const partyId = data.partyId || data.customerId || data.dealerId || data.selectedCustomer?.id || null;
    const snapshot = data.selectedCustomer || null;
    let customer: any = null, dealer: any = null, partyFranchise: any = null;
    if (partyId) {
      if (partyType === 'DEALER') dealer = await prisma.dealer.findUnique({ where: { id: partyId } }).catch(() => null);
      else if (partyType === 'FRANCHISE') partyFranchise = await prisma.franchise.findUnique({ where: { id: partyId } }).catch(() => null);
      else customer = await prisma.customer.findUnique({ where: { id: partyId } }).catch(() => null);
    }
    if (snapshot) {
      if (partyType === 'DEALER') dealer = { ...snapshot, ...(dealer || {}) };
      else if (partyType === 'FRANCHISE') partyFranchise = { ...snapshot, ...(partyFranchise || {}) };
      else customer = { ...snapshot, ...(customer || {}) };
    }
    const customerName = data.customerName || snapshot?.name || data.customerSearch
      || customer?.name || dealer?.name || partyFranchise?.name || null;
    const invoiceDate = data.invoiceDate ? new Date(data.invoiceDate) : null;

    return {
      id: draft.id,
      status: 'DRAFT',
      isDraft: true,
      createdAt: invoiceDate && !isNaN(invoiceDate.getTime()) ? invoiceDate : draft.updatedAt,
      updatedAt: draft.updatedAt,
      totalAmount: round2(subTotal - totalDiscount),
      taxAmount: round2(totalTax),
      roundOff,
      finalAmount,
      termsAndConditions: data.termsConditions || (data.showTerms ? data.termsText : null) || null,
      notes: data.notes || (data.showDesc ? data.description : null) || null,
      payments: [],
      customerName,
      order: {
        id: null,
        // Only a number the user typed — drafts are never auto-numbered.
        invoiceNum: data.invoiceNum || data.invoiceNumber || null,
        orderType: 'TAX_INVOICE',
        partyType,
        partyId,
        customerId: partyType === 'CUSTOMER' ? partyId : null,
        dealerId: partyType === 'DEALER' ? partyId : null,
        customerName,
        customerPhone: data.customerPhone || customer?.phone || dealer?.phone || null,
        stateOfSupply: data.stateOfSupply || null,
        paymentType: data.paymentType || 'CASH',
        deliveryCharge,
        subTotal: round2(subTotal),
        discountAmount: round2(totalDiscount),
        taxAmount: round2(totalTax),
        totalAmount: finalAmount,
        customer,
        dealer,
        // The view reads a Franchise party's contact details from `franchise`.
        franchise: partyFranchise,
        franchiseId: partyType === 'FRANCHISE' ? partyId : null,
        orderItems,
      },
    };
  }

  static async saveDraft(userId: string, draft: { id?: string; type: string; data: any }) {
    if (draft.id) {
      const existing = await prisma.draft.findUnique({ where: { id: draft.id } });
      if (existing) {
        return prisma.draft.update({
          where: { id: draft.id },
          data: { data: draft.data, updatedAt: new Date() },
        });
      }
    }
    return prisma.draft.create({
      data: { type: draft.type, userId, data: draft.data },
    });
  }

  static async deleteDraft(id: string, userId: string) {
    // Scoped by userId too — getDrafts already only ever returns a user's
    // own drafts, so delete must match that ownership instead of trusting
    // a client-supplied id alone.
    return prisma.draft.deleteMany({ where: { id, userId } });
  }
}
