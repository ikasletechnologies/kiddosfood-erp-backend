import prisma from '../../lib/prisma';
import { POSService } from '../../modules/pos/pos.service';
import { ProductService } from '../../modules/product/product.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Regression coverage for the POS channel-pricing bug: Dealer/Franchise sales
// were always billed at the generic base/franchise price (never their own
// configured dealerPrice/franchisePrice), and the "Customer Retail Discount"
// leaked into Dealer/Franchise sales unconditionally. See:
//   - ProductService.getAll (channel price merge onto the POS product list)
//   - src/app/pos/page.tsx getPrice()/addToCart() (frontend channel selection)
//   - POSService.checkout (server-side price/discount trust boundary)
async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING POS CHANNEL-PRICING REGRESSION SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();
  const invScopeId = await FranchiseService.toInventoryScopeId(prisma, hq.id);

  let account = await prisma.account.findFirst({ where: { type: 'CASH', franchiseId: hq.id } });
  if (!account) {
    account = await prisma.account.create({
      data: { name: 'Counter Cash Box', type: 'CASH', balance: 10000, franchiseId: hq.id }
    });
  }

  // APPAM 450g — matches the exact reported bug's pricing configuration.
  const sku450 = `APPAM-450-TEST-${Date.now()}`;
  const inv450 = await prisma.inventoryItem.create({
    data: {
      name: 'APPAM 450g (Regression Test)',
      sku: sku450,
      category: 'FINISHED_GOOD',
      currentStock: 100,
      unit: 'PC',
      costPrice: 20,
      franchisePrice: 35,
      dealerPrice: 40,
      customerPrice: 45,
      basePrice: 35,
      discountType: 'PERCENT',
      discountValue: 25, // "Customer Retail Discount" — customer channel only
      gstRate: 5,
      franchiseId: invScopeId
    }
  });
  const product450 = await prisma.product.create({
    data: {
      name: inv450.name,
      sku: sku450,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 35,
      taxPercent: 5,
      discountType: 'PERCENT',
      discountValue: 25,
      isActive: true,
      is_menu_item: false
    }
  });

  // APPAM 900g — a distinct variant with different channel prices, used to
  // prove the lookup never cross-contaminates between size variants (a
  // name-based fallback match would wrongly conflate the two).
  const sku900 = `APPAM-900-TEST-${Date.now()}`;
  const inv900 = await prisma.inventoryItem.create({
    data: {
      name: 'APPAM 900g (Regression Test)',
      sku: sku900,
      category: 'FINISHED_GOOD',
      currentStock: 100,
      unit: 'PC',
      costPrice: 40,
      franchisePrice: 65,
      dealerPrice: 70,
      customerPrice: 80,
      basePrice: 65,
      gstRate: 5,
      franchiseId: invScopeId
    }
  });
  const product900 = await prisma.product.create({
    data: {
      name: inv900.name,
      sku: sku900,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 65,
      taxPercent: 5,
      isActive: true,
      is_menu_item: false
    }
  });

  const createdOrderIds: string[] = [];
  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    for (const orderId of createdOrderIds) {
      await prisma.payment.deleteMany({ where: { orderId } });
      await prisma.customerLedger.deleteMany({ where: { referenceId: orderId } });
      await prisma.invoice.deleteMany({ where: { orderId } });
      await prisma.orderItem.deleteMany({ where: { orderId } });
      await prisma.stockMovement.deleteMany({ where: { referenceId: orderId } });
    }
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.product.deleteMany({ where: { id: { in: [product450.id, product900.id] } } });
    await prisma.inventoryItem.deleteMany({ where: { id: { in: [inv450.id, inv900.id] } } });
    console.log('   ✅ Test data cleaned up successfully.');
  };

  try {
    // ── F. GET /api/products exposes the channel prices ──────────────────
    console.log('--- F. ProductService.getAll exposes channel prices ---');
    const list = await ProductService.getAll({}, hq.id);
    const listed450 = list.find((p: any) => p.id === product450.id);
    if (!listed450) throw new Error('APPAM 450g not found in ProductService.getAll() result');
    if (listed450.dealerPrice !== 40) throw new Error(`Expected dealerPrice 40, got ${listed450.dealerPrice}`);
    if (listed450.franchisePrice !== 35) throw new Error(`Expected franchisePrice 35, got ${listed450.franchisePrice}`);
    if (listed450.customerPrice !== 45) throw new Error(`Expected customerPrice 45, got ${listed450.customerPrice}`);
    console.log('   ✅ dealerPrice/franchisePrice/customerPrice all present and correct\n');

    // ── I. Variant isolation — 450g must never resolve 900g's prices ─────
    console.log('--- I. Product variant (450g vs 900g) price isolation ---');
    const listed900 = list.find((p: any) => p.id === product900.id);
    if (!listed900) throw new Error('APPAM 900g not found in ProductService.getAll() result');
    if (listed450.dealerPrice === listed900.dealerPrice) {
      throw new Error('450g and 900g resolved to the same dealerPrice — variant isolation broken');
    }
    console.log(`   ✅ 450g dealerPrice=${listed450.dealerPrice} independent of 900g dealerPrice=${listed900.dealerPrice}\n`);

    // ── A. Customer channel: customerPrice + Customer Retail Discount ────
    console.log('--- A. CUSTOMER checkout: price=45, discount=25%, GST=5% ---');
    const orderA = await POSService.checkout({
      franchiseId: hq.id,
      partyType: 'CUSTOMER',
      accountId: account.id,
      paymentMode: 'CASH',
      items: [{ productId: product450.id, quantity: 1, price: 45, taxPercent: 5 }],
      subTotal: 45, taxAmount: 2.25, discountAmount: 11.25, totalAmount: 36
    } as any);
    createdOrderIds.push(orderA.id);
    if (orderA.subTotal !== 45) throw new Error(`Customer subTotal: expected 45, got ${orderA.subTotal}`);
    if (orderA.taxAmount !== 2.25) throw new Error(`Customer taxAmount: expected 2.25, got ${orderA.taxAmount}`);
    if (orderA.discountAmount !== 11.25) throw new Error(`Customer discountAmount: expected 11.25, got ${orderA.discountAmount}`);
    if (orderA.totalAmount !== 36) throw new Error(`Customer totalAmount: expected 36, got ${orderA.totalAmount}`);
    console.log(`   ✅ Customer sale correctly priced at ₹45, discounted ₹11.25, GST ₹2.25 → total ₹36\n`);

    // ── B. Dealer channel: dealerPrice, NO Customer Retail Discount ──────
    console.log('--- B. DEALER checkout: dealerPrice=40, customer discount must NOT apply ---');
    const orderB = await POSService.checkout({
      franchiseId: hq.id,
      partyType: 'DEALER',
      accountId: account.id,
      paymentMode: 'CASH',
      items: [{ productId: product450.id, quantity: 1, price: 40, taxPercent: 5 }],
      subTotal: 40, taxAmount: 2, discountAmount: 0, totalAmount: 42
    } as any);
    createdOrderIds.push(orderB.id);
    if (orderB.subTotal !== 40) throw new Error(`Dealer subTotal: expected 40, got ${orderB.subTotal}`);
    if (orderB.discountAmount !== 0) throw new Error(`Dealer discountAmount: expected 0 (no Customer Retail Discount), got ${orderB.discountAmount}`);
    if (orderB.taxAmount !== 2) throw new Error(`Dealer taxAmount: expected 2, got ${orderB.taxAmount}`);
    if (orderB.totalAmount !== 42) throw new Error(`Dealer totalAmount: expected 42, got ${orderB.totalAmount}`);
    console.log('   ✅ Dealer sale correctly priced at ₹40 with zero Customer Retail Discount → total ₹42\n');

    // ── C. Franchise channel: franchisePrice, NO Customer Retail Discount ─
    console.log('--- C. FRANCHISE checkout: franchisePrice=35, customer discount must NOT apply ---');
    const orderC = await POSService.checkout({
      franchiseId: hq.id,
      partyType: 'FRANCHISE',
      accountId: account.id,
      paymentMode: 'CASH',
      items: [{ productId: product450.id, quantity: 1, price: 35, taxPercent: 5 }],
      subTotal: 35, taxAmount: 1.75, discountAmount: 0, totalAmount: 36.75
    } as any);
    createdOrderIds.push(orderC.id);
    if (orderC.discountAmount !== 0) throw new Error(`Franchise discountAmount: expected 0, got ${orderC.discountAmount}`);
    if (orderC.totalAmount !== 36.75) throw new Error(`Franchise totalAmount: expected 36.75, got ${orderC.totalAmount}`);
    console.log('   ✅ Franchise sale correctly priced at ₹35 with zero Customer Retail Discount → total ₹36.75\n');

    // ── G. Security: forged unitPrice must be overridden server-side ─────
    console.log('--- G. Security: forged Dealer unitPrice=₹1 must not create a ₹1 invoice ---');
    const orderG = await POSService.checkout({
      franchiseId: hq.id,
      partyType: 'DEALER',
      accountId: account.id,
      paymentMode: 'CASH',
      items: [{ productId: product450.id, quantity: 1, price: 1, taxPercent: 5 }], // forged
      subTotal: 1, taxAmount: 0.05, discountAmount: 0, totalAmount: 1.05
    } as any);
    createdOrderIds.push(orderG.id);
    if (orderG.subTotal !== 40) throw new Error(`Forged price NOT overridden — subTotal expected 40, got ${orderG.subTotal}`);
    if (orderG.orderItems[0].price !== 40) throw new Error(`OrderItem.price expected 40, got ${orderG.orderItems[0].price}`);
    console.log('   ✅ Forged unitPrice=₹1 ignored — server charged the real Dealer price of ₹40\n');

    // ── H. Security: a forged legacy discountAmount must have zero effect ─
    // Only `manualDiscount` is trusted as a cashier-entered figure; the
    // legacy combined `discountAmount` field is display-only input now and
    // is never used to compute what's actually charged.
    console.log('--- H. Security: forged discountAmount=₹999999 (no manualDiscount) must be ignored ---');
    const orderH = await POSService.checkout({
      franchiseId: hq.id,
      partyType: 'DEALER',
      accountId: account.id,
      paymentMode: 'CASH',
      items: [{ productId: product450.id, quantity: 1, price: 40, taxPercent: 5 }],
      subTotal: 40, taxAmount: 2, discountAmount: 999999, totalAmount: 0 // forged
    } as any);
    createdOrderIds.push(orderH.id);
    if (orderH.discountAmount !== 0) throw new Error(`Forged discountAmount was honored — expected 0, got ${orderH.discountAmount}`);
    if (orderH.totalAmount !== 42) throw new Error(`Expected totalAmount unaffected at 42, got ${orderH.totalAmount}`);
    console.log('   ✅ Forged discountAmount=₹999999 had zero effect — only trusted manualDiscount is honored\n');

    // ── H2. Security: manualDiscount is capped to what remains on the bill ─
    console.log('--- H2. Security: manualDiscount=₹30 on a ₹42 Dealer bill is honored in full (within bounds) ---');
    const orderH2 = await POSService.checkout({
      franchiseId: hq.id,
      partyType: 'DEALER',
      accountId: account.id,
      paymentMode: 'CASH',
      items: [{ productId: product450.id, quantity: 1, price: 40, taxPercent: 5 }],
      subTotal: 40, taxAmount: 2, discountAmount: 30, totalAmount: 12,
      manualDiscount: 30
    } as any);
    createdOrderIds.push(orderH2.id);
    if (orderH2.discountAmount !== 30) throw new Error(`Expected discountAmount 30, got ${orderH2.discountAmount}`);
    if (orderH2.totalAmount !== 12) throw new Error(`Expected totalAmount 12, got ${orderH2.totalAmount}`);
    console.log('   ✅ A legitimate manualDiscount within the bill total is honored exactly (₹42 - ₹30 = ₹12)\n');

    // A manualDiscount that meets or exceeds the full remaining bill is
    // capped to exactly the bill (never more) — which drives totalAmount to
    // ₹0. FinanceService.createPayment separately refuses to record a ₹0
    // payment ("must be greater than zero"), so a 100%-discounted sale
    // correctly fails closed rather than silently completing with whatever
    // inflated figure the client sent.
    console.log('--- H3. Security: manualDiscount >= bill total is capped, and a ₹0 sale fails closed ---');
    try {
      await POSService.checkout({
        franchiseId: hq.id,
        partyType: 'DEALER',
        accountId: account.id,
        paymentMode: 'CASH',
        items: [{ productId: product450.id, quantity: 1, price: 40, taxPercent: 5 }],
        subTotal: 40, taxAmount: 2, discountAmount: 10000, totalAmount: 0,
        manualDiscount: 10000 // forged, far exceeds the ₹42 bill
      } as any);
      throw new Error('Expected checkout to reject a fully-discounted (₹0) sale, but it succeeded');
    } catch (e: any) {
      if (!/greater than zero/i.test(e.message)) throw e;
      console.log('   ✅ A discount capped to 100% of the bill correctly fails closed (no ₹0 payment recorded)\n');
    }

    console.log('====================================================');
    console.log('🎉 ALL POS CHANNEL-PRICING REGRESSION CHECKS PASSED');
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
