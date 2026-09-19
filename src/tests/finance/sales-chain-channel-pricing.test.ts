import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Regression coverage for the sales-chain channel-pricing fix: Estimate,
// Sales Order, Proforma Invoice, Sale Invoice, and Delivery Challan all used
// to ignore Dealer/Franchise pricing and blindly trust client-submitted
// rate/tax — the same class of bug already fixed in POS
// (pos-channel-pricing.test.ts). See:
//   - sales.service.ts: resolveItemChannelPricing/applyAuthoritativePricing
//   - finance.service.ts: FinanceService.createInvoice's inline resolution
//   - HQ-fallback fix (no more tx.franchise.findFirst()) and
//     id/SKU-only product matching (no more name-based/"first product"
//     fallback) in convertQuotationToSale/convertSalesOrderToSale/
//     convertDeliveryChallanToSale
async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING SALES-CHAIN CHANNEL-PRICING REGRESSION SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();

  // APPAM 450g — matches the exact reported bug's pricing configuration.
  const sku450 = `APPAM-450-SALES-TEST-${Date.now()}`;
  const inv450 = await prisma.inventoryItem.create({
    data: {
      name: 'APPAM 450g (Sales Chain Test)',
      sku: sku450,
      category: 'FINISHED_GOOD',
      currentStock: 100,
      unit: 'PC',
      costPrice: 20,
      franchisePrice: 35,
      dealerPrice: 40,
      customerPrice: 45,
      basePrice: 45,
      discountType: 'PERCENT',
      discountValue: 50, // matches the exact reported bug scenario (APPAM 450g, 50% Customer Retail Discount)
      gstRate: 5,
      franchiseId: null
    }
  });
  const product450 = await prisma.product.create({
    data: {
      name: inv450.name,
      sku: sku450,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 45,
      discountType: 'PERCENT',
      discountValue: 50,
      taxPercent: 5,
      isActive: true,
      is_menu_item: false
    }
  });

  // APPAM 900g — distinct variant, used to prove conversions never
  // cross-contaminate between size variants.
  const sku900 = `APPAM-900-SALES-TEST-${Date.now()}`;
  const inv900 = await prisma.inventoryItem.create({
    data: {
      name: 'APPAM 900g (Sales Chain Test)',
      sku: sku900,
      category: 'FINISHED_GOOD',
      currentStock: 100,
      unit: 'PC',
      costPrice: 40,
      franchisePrice: 65,
      dealerPrice: 70,
      customerPrice: 80,
      basePrice: 80,
      gstRate: 5,
      franchiseId: null
    }
  });
  const product900 = await prisma.product.create({
    data: {
      name: inv900.name,
      sku: sku900,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 80,
      taxPercent: 5,
      isActive: true,
      is_menu_item: false
    }
  });

  const dealer = await prisma.dealer.create({
    data: { name: `Sales Chain Test Dealer ${Date.now()}`, franchiseId: hq.id, status: 'ACTIVE' }
  });

  const createdQuotationIds: string[] = [];
  const createdSalesOrderIds: string[] = [];
  const createdProformaIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdChallanIds: string[] = [];

  // Each step is independently caught so one failure (or an orphaned row
  // left by a test-script bug) never masks the *original* test failure
  // (a throw inside `finally` replaces whatever was already in flight) and
  // never stops the rest of the cleanup from running.
  const step = async (label: string, fn: () => Promise<any>) => {
    try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
  };

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    for (const orderId of createdOrderIds) {
      await step('invoice', () => prisma.invoice.deleteMany({ where: { orderId } }));
      await step('orderItem', () => prisma.orderItem.deleteMany({ where: { orderId } }));
      await step('stockMovement', () => prisma.stockMovement.deleteMany({ where: { referenceId: orderId } }));
    }
    await step('order', () => prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }));
    await step('deliveryChallanItem', () => prisma.deliveryChallanItem.deleteMany({ where: { challanId: { in: createdChallanIds } } }));
    await step('deliveryChallan', () => prisma.deliveryChallan.deleteMany({ where: { id: { in: createdChallanIds } } }));
    await step('proformaInvoiceItem', () => prisma.proformaInvoiceItem.deleteMany({ where: { proformaInvoiceId: { in: createdProformaIds } } }));
    await step('proformaInvoice', () => prisma.proformaInvoice.deleteMany({ where: { id: { in: createdProformaIds } } }));
    await step('salesOrderItem', () => prisma.salesOrderItem.deleteMany({ where: { salesOrderId: { in: createdSalesOrderIds } } }));
    await step('salesOrder', () => prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } }));
    await step('quotationItem', () => prisma.quotationItem.deleteMany({ where: { quotationId: { in: createdQuotationIds } } }));
    await step('quotation', () => prisma.quotation.deleteMany({ where: { id: { in: createdQuotationIds } } }));
    await step('dealer', () => prisma.dealer.delete({ where: { id: dealer.id } }));
    // Defensive: any OrderItem still referencing our test products (e.g. a
    // mid-test failure before its owning order id was recorded above) would
    // otherwise block the Product delete below.
    await step('orphaned orderItems', () => prisma.orderItem.deleteMany({ where: { productId: { in: [product450.id, product900.id] } } }));
    await step('product', () => prisma.product.deleteMany({ where: { id: { in: [product450.id, product900.id] } } }));
    await step('inventoryItem', () => prisma.inventoryItem.deleteMany({ where: { id: { in: [inv450.id, inv900.id] } } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  };

  try {
    // ── 1. Estimate — CUSTOMER/DEALER/FRANCHISE channel pricing ──────────
    console.log('--- 1. Estimate: forged rate=1/taxPercent=0 must resolve to the real channel price ---');
    const qtyC = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdQuotationIds.push(qtyC.id);
    // Customer Retail Discount (50%) must auto-apply for CUSTOMER, and GST
    // must be computed on the POST-discount taxable amount — the
    // established rule in calculateTotals/createInvoice (unlike POS, which
    // computes GST on the pre-discount gross; see Phase 11 in the report).
    // 45 gross, 22.50 discount (50%), 22.50 taxable, 5% GST = 1.125 → 1.13.
    if (qtyC.items[0].rate !== 45) throw new Error(`Estimate CUSTOMER: expected rate 45, got ${qtyC.items[0].rate}`);
    if (Math.abs(qtyC.items[0].discountAmount - 22.5) > 0.01) throw new Error(`Estimate CUSTOMER: expected auto-applied discountAmount 22.50, got ${qtyC.items[0].discountAmount}`);
    if (Math.abs(qtyC.items[0].taxAmount - 1.13) > 0.01) throw new Error(`Estimate CUSTOMER: expected taxAmount 1.13 (GST on post-discount ₹22.50), got ${qtyC.items[0].taxAmount}`);
    if (Math.abs(qtyC.totalAmount - 23.63) > 0.01) throw new Error(`Estimate CUSTOMER: expected total 23.63, got ${qtyC.totalAmount}`);
    console.log(`   ✅ CUSTOMER → ₹45, Customer Retail Discount auto-applied ₹22.50, GST(post-discount) ₹${qtyC.items[0].taxAmount.toFixed(2)}, total ₹${qtyC.totalAmount}`);

    const qtyD = await SalesService.createQuotation({
      partyType: 'DEALER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdQuotationIds.push(qtyD.id);
    if (qtyD.items[0].rate !== 40) throw new Error(`Estimate DEALER: expected rate 40, got ${qtyD.items[0].rate}`);
    if ((qtyD.items[0].discountAmount || 0) !== 0) throw new Error(`Estimate DEALER: Customer Retail Discount must NOT apply, got discountAmount ${qtyD.items[0].discountAmount}`);
    console.log('   ✅ DEALER → ₹40 (forged ₹1 ignored), no Customer Retail Discount applied');

    const qtyF = await SalesService.createQuotation({
      partyType: 'FRANCHISE',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdQuotationIds.push(qtyF.id);
    if (qtyF.items[0].rate !== 35) throw new Error(`Estimate FRANCHISE: expected rate 35, got ${qtyF.items[0].rate}`);
    if ((qtyF.items[0].discountAmount || 0) !== 0) throw new Error(`Estimate FRANCHISE: Customer Retail Discount must NOT apply, got discountAmount ${qtyF.items[0].discountAmount}`);
    console.log('   ✅ FRANCHISE → ₹35 (forged ₹1 ignored), no Customer Retail Discount applied\n');

    // ── 2. Sales Order — CUSTOMER-only (no channel selector in this UI) ──
    console.log('--- 2. Sales Order (direct-create, CUSTOMER-only): forged rate=1 must resolve to customerPrice ---');
    const so = await SalesService.createSalesOrder({
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdSalesOrderIds.push(so.id);
    // Sales Order is implicitly CUSTOMER, so the Customer Retail Discount
    // auto-applies here too (same 45/22.50/1.13/23.63 as Estimate CUSTOMER).
    if ((so as any).items[0].rate !== 45) throw new Error(`Sales Order: expected rate 45, got ${(so as any).items[0].rate}`);
    if (Math.abs((so as any).items[0].discountAmount - 22.5) > 0.01) throw new Error(`Sales Order: expected auto-applied discountAmount 22.50, got ${(so as any).items[0].discountAmount}`);
    console.log(`   ✅ Sales Order → ₹45 (forged ₹1 ignored), Customer Retail Discount auto-applied ₹${(so as any).items[0].discountAmount}\n`);

    // ── 3. Proforma direct-create — DEALER (no discount) and CUSTOMER (auto-discount) ──
    console.log('--- 3. Proforma (direct-create) DEALER: forged rate=1 must resolve to dealerPrice ---');
    const pf = await SalesService.createProformaInvoice({
      partyType: 'DEALER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdProformaIds.push(pf.id);
    if (pf.items[0].rate !== 40) throw new Error(`Proforma DEALER: expected rate 40, got ${pf.items[0].rate}`);
    if ((pf.items[0].discountAmount || 0) !== 0) throw new Error(`Proforma DEALER: Customer Retail Discount must NOT apply, got ${pf.items[0].discountAmount}`);
    console.log('   ✅ Proforma DEALER → ₹40 (forged ₹1 ignored), no Customer Retail Discount applied');

    const pfCustomer = await SalesService.createProformaInvoice({
      partyType: 'CUSTOMER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdProformaIds.push(pfCustomer.id);
    if (pfCustomer.items[0].rate !== 45) throw new Error(`Proforma CUSTOMER: expected rate 45, got ${pfCustomer.items[0].rate}`);
    if (Math.abs(pfCustomer.items[0].discountAmount - 22.5) > 0.01) throw new Error(`Proforma CUSTOMER: expected auto-applied discountAmount 22.50, got ${pfCustomer.items[0].discountAmount}`);
    console.log(`   ✅ Proforma CUSTOMER → ₹45, Customer Retail Discount auto-applied ₹${pfCustomer.items[0].discountAmount}\n`);

    // ── 4. Sale Invoice (FinanceService.createInvoice) — FRANCHISE ───────
    console.log('--- 4. Sale Invoice FRANCHISE: forged rate=1/gst=0 must resolve to franchisePrice/real GST ---');
    const inv = await FinanceService.createInvoice({
      franchiseId: hq.id,
      partyType: 'FRANCHISE',
      items: [{ productId: product450.id, productName: 'APPAM 450g', qty: 1, rate: 1, gst: 0 }],
    } as any);
    createdOrderIds.push((inv as any).order.id); // createInvoice returns { ...invoice, order } — orderId lives on .order.id
    const invItem = await prisma.orderItem.findFirst({ where: { orderId: (inv as any).order.id } });
    if (!invItem || invItem.price !== 35) throw new Error(`Sale Invoice FRANCHISE: expected price 35, got ${invItem?.price}`);
    if (Math.abs((invItem.taxAmount ?? 0) - 1.75) > 0.01) throw new Error(`Sale Invoice FRANCHISE: expected taxAmount 1.75, got ${invItem.taxAmount}`);
    console.log('   ✅ Sale Invoice FRANCHISE → ₹35 (forged ₹1/0% GST ignored), real 5% GST applied\n');

    // ── 5. Delivery Challan — DEALER destination pricing ─────────────────
    console.log('--- 5. Delivery Challan (dealerId destination): forged rate=1 must resolve to dealerPrice ---');
    const dc = await SalesService.createDeliveryChallan({
      dealerId: dealer.id,
      sourceFranchiseId: hq.id,
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdChallanIds.push(dc.id);
    if (dc.items[0].rate !== 40) throw new Error(`Delivery Challan DEALER: expected rate 40, got ${dc.items[0].rate}`);
    console.log('   ✅ Delivery Challan (Dealer destination) → ₹40 (forged ₹1 ignored)\n');

    // ── 6. Variant isolation — 450g must never resolve 900g's prices ─────
    console.log('--- 6. Variant isolation: APPAM 450g DEALER price must be independent of APPAM 900g ---');
    const qty900 = await SalesService.createQuotation({
      partyType: 'DEALER',
      items: [{ productId: product900.id, productName: 'APPAM 900g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdQuotationIds.push(qty900.id);
    if (qty900.items[0].rate !== 70) throw new Error(`APPAM 900g DEALER: expected rate 70, got ${qty900.items[0].rate}`);
    console.log(`   ✅ 450g dealer rate=${qtyD.items[0].rate} independent of 900g dealer rate=${qty900.items[0].rate}\n`);

    // ── 7. Historical price immutability ──────────────────────────────────
    console.log('--- 7. Historical immutability: changing InventoryItem.customerPrice must not rewrite an existing Estimate ---');
    await prisma.inventoryItem.update({ where: { id: inv450.id }, data: { customerPrice: 999, discountValue: 10 } });
    const qtyAfterPriceChange = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdQuotationIds.push(qtyAfterPriceChange.id);
    const oldQtyReloaded = await prisma.quotation.findUnique({ where: { id: qtyC.id }, include: { items: true } });
    if (qtyAfterPriceChange.items[0].rate !== 999) throw new Error(`New Estimate: expected rate 999 (updated price), got ${qtyAfterPriceChange.items[0].rate}`);
    if (Math.abs(qtyAfterPriceChange.items[0].discountAmount - 99.9) > 0.01) throw new Error(`New Estimate: expected new 10% discount = 99.90, got ${qtyAfterPriceChange.items[0].discountAmount}`);
    if (!oldQtyReloaded || oldQtyReloaded.items[0].rate !== 45) throw new Error(`Old Estimate: expected rate to remain 45, got ${oldQtyReloaded?.items[0].rate} — historical price was rewritten!`);
    if (Math.abs(oldQtyReloaded.items[0].discountAmount - 22.5) > 0.01) throw new Error(`Old Estimate: expected discountAmount to remain 22.50, got ${oldQtyReloaded.items[0].discountAmount} — historical discount was rewritten!`);
    console.log('   ✅ New Estimate picks up ₹999/10% discount; the original Estimate (₹45/50%/₹22.50) is untouched — historical price AND discount are immutable\n');
    await prisma.inventoryItem.update({ where: { id: inv450.id }, data: { customerPrice: 45, discountValue: 50 } }); // restore for remaining assertions

    // ── 8. Variant/unresolvable-product conversion safety ────────────────
    // A Quotation item referencing a productId that matches no real
    // Product/InventoryItem SKU must fail conversion loudly, not silently
    // attach to "the first product in the table" (the pre-fix behavior).
    console.log('--- 8. Conversion safety: an unresolvable productId must throw, not silently pick any product ---');
    const badQuotation = await prisma.quotation.create({
      data: {
        quotationNumber: `QT-BADTEST-${Date.now()}`,
        partyType: 'CUSTOMER',
        subTotal: 45, taxAmount: 2.25, totalAmount: 47.25,
        items: { create: [{ productId: 'nonexistent-dangling-id-12345', productName: 'Ghost Product', quantity: 1, rate: 45, taxPercent: 5, taxAmount: 2.25, totalAmount: 47.25 }] }
      }
    });
    createdQuotationIds.push(badQuotation.id);
    try {
      await SalesService.convertQuotationToSale(badQuotation.id, 'test-user');
      throw new Error('Expected convertQuotationToSale to throw for an unresolvable productId, but it succeeded');
    } catch (e: any) {
      if (!/does not match any known Product/i.test(e.message)) throw e;
      console.log('   ✅ convertQuotationToSale correctly throws instead of silently attaching an unrelated product\n');
    }

    // ── 9. Create-time rejection: a provided-but-unresolvable productId ──
    // must reject the whole line, not silently accept the client's rate.
    console.log('--- 9. Create-time safety: an unresolvable productId must reject, not fall back to the client price ---');
    try {
      await SalesService.createQuotation({
        partyType: 'DEALER',
        items: [{ productId: 'nonexistent-dangling-id-99999', productName: 'Ghost Item', quantity: 1, rate: 1, taxPercent: 0 }],
      } as any);
      throw new Error('Expected createQuotation to reject an unresolvable productId, but it succeeded');
    } catch (e: any) {
      if (!/does not match any known Product/i.test(e.message)) throw e;
      console.log('   ✅ createQuotation rejects a supplied-but-unresolvable productId instead of trusting the forged ₹1\n');
    }
    try {
      await FinanceService.createInvoice({
        franchiseId: hq.id,
        partyType: 'DEALER',
        items: [{ productId: 'nonexistent-dangling-id-99999', productName: 'Ghost Item', qty: 1, rate: 1, gst: 0 }],
      } as any);
      throw new Error('Expected createInvoice to reject an unresolvable productId, but it succeeded');
    } catch (e: any) {
      if (!/does not match any known Product/i.test(e.message)) throw e;
      console.log('   ✅ Sale Invoice (createInvoice) rejects a supplied-but-unresolvable productId instead of trusting the forged ₹1\n');
    }

    // ── 10. Free-text lines (no productId) still work — not over-tightened ─
    console.log('--- 10. Free-text line (no productId) still accepts a client-supplied price ---');
    const qtyFreeText = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      items: [{ productName: 'One-off Service Charge', quantity: 1, rate: 250, taxPercent: 5 }],
    } as any);
    createdQuotationIds.push(qtyFreeText.id);
    if (qtyFreeText.items[0].rate !== 250) throw new Error(`Free-text line: expected rate 250, got ${qtyFreeText.items[0].rate}`);
    console.log('   ✅ A line with no productId at all is still free-text-priced (not over-tightened)\n');

    // ── 11. Manual discount is bounded, never fabricates a negative total ─
    // Uses DEALER (not CUSTOMER) so the Customer Retail Discount auto-fill
    // doesn't also engage here — this isolates the document-level
    // forged-discount clamp itself.
    console.log('--- 11. Manual discount security: a forged huge discountAmount must be capped, never go negative ---');
    const qtyHugeDiscount = await SalesService.createQuotation({
      partyType: 'DEALER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
      discountAmount: 999999, // forged — far exceeds the real ₹40 dealer line
    } as any);
    createdQuotationIds.push(qtyHugeDiscount.id);
    if (qtyHugeDiscount.discountAmount === 999999) throw new Error('Forged discountAmount accepted verbatim on Estimate — not capped!');
    if (qtyHugeDiscount.totalAmount < 0) throw new Error(`Estimate totalAmount went negative: ${qtyHugeDiscount.totalAmount}`);
    if (qtyHugeDiscount.discountAmount > 40 + 0.01) throw new Error(`Estimate discountAmount should be capped near the ₹40 dealer line total, got ${qtyHugeDiscount.discountAmount}`);
    console.log(`   ✅ Estimate (Dealer): forged discountAmount=999999 capped to ₹${qtyHugeDiscount.discountAmount}, total=₹${qtyHugeDiscount.totalAmount} (never negative)\n`);

    const invHugeDiscount = await FinanceService.createInvoice({
      franchiseId: hq.id,
      partyType: 'DEALER',
      items: [{ productId: product450.id, productName: 'APPAM 450g', qty: 1, rate: 1, gst: 0 }],
      discountAmount: 999999, // forged — far exceeds the real ₹40 dealer line
    } as any);
    createdOrderIds.push((invHugeDiscount as any).order.id);
    if ((invHugeDiscount as any).finalAmount < 0) throw new Error(`Sale Invoice finalAmount went negative: ${(invHugeDiscount as any).finalAmount}`);
    if ((invHugeDiscount as any).order.discountAmount === 999999) throw new Error('Forged discountAmount accepted verbatim on Sale Invoice — not capped!');
    console.log(`   ✅ Sale Invoice: forged discountAmount=999999 capped to ₹${(invHugeDiscount as any).order.discountAmount}, finalAmount=₹${(invHugeDiscount as any).finalAmount} (never negative)\n`);

    // ── 12. Sales Order PATCH cannot set totals without recomputing items ─
    console.log('--- 12. Security: a bare Sales Order PATCH cannot directly overwrite totalAmount without items ---');
    const soPatchTarget = await SalesService.createSalesOrder({
      items: [{ productId: product450.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }],
    } as any);
    createdSalesOrderIds.push(soPatchTarget.id);
    const originalTotal = (soPatchTarget as any).totalAmount; // 45 - 50% discount = 22.50 taxable, + 5% GST(1.13) = 23.63
    const patched = await SalesService.updateSalesOrder(soPatchTarget.id, { totalAmount: 1, discountAmount: 999999, notes: 'forged patch attempt' } as any);
    if ((patched as any).totalAmount === 1) throw new Error('Bare PATCH with no items directly overwrote totalAmount — trust boundary regressed!');
    if ((patched as any).totalAmount !== originalTotal) throw new Error(`Expected totalAmount to remain ${originalTotal} (unaffected by the forged patch), got ${(patched as any).totalAmount}`);
    console.log(`   ✅ A bare PATCH (no items) cannot overwrite totalAmount/discountAmount — original ₹${originalTotal} total is untouched\n`);

    // ── 13. Conversion preserves the frozen discount, doesn't re-price ───
    console.log('--- 13. Conversion (Estimate → Sale) preserves the already-applied Customer Retail Discount ---');
    const convertedSale = await SalesService.convertQuotationToSale(qtyC.id, 'test-user');
    createdOrderIds.push((convertedSale as any).sale.id);
    const convertedOrderItem = await prisma.orderItem.findFirst({ where: { orderId: (convertedSale as any).sale.id } });
    if (!convertedOrderItem || convertedOrderItem.price !== 45) throw new Error(`Converted sale: expected price 45, got ${convertedOrderItem?.price}`);
    if (Math.abs((convertedOrderItem.discountPct || 0) - 50) > 0.5) throw new Error(`Converted sale: expected discountPct ~50, got ${convertedOrderItem.discountPct}`);
    if (Math.abs((convertedSale as any).sale.totalAmount - 23.63) > 0.01) throw new Error(`Converted sale: expected totalAmount 23.63 (frozen from the Estimate), got ${(convertedSale as any).sale.totalAmount}`);
    console.log(`   ✅ Converted Sale preserves ₹45 price / ~50% discount / ₹23.63 total exactly as the Estimate had it — no re-pricing from current Item Master data\n`);

    console.log('====================================================');
    console.log('🎉 ALL SALES-CHAIN CHANNEL-PRICING REGRESSION CHECKS PASSED');
    console.log('====================================================');
  } finally {
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error('❌ Test failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
