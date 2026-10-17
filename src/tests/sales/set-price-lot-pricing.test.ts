// End-to-end check of Production > Set Price (product-level Customer / Dealer /
// Franchise prices) with finished-goods lots across Sales Order, Estimate,
// Sale Invoice, POS, Delivery Challan and returns.
//
// One product (APPAM 500g), three production runs at different costs
// (₹20, ₹45, ₹100 per packet): prices are set once and reused for every
// lot; each lot keeps its own cost; the party type picks the price.
// Run: npx tsx src/tests/sales/set-price-lot-pricing.test.ts
import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { POSService } from '../../modules/pos/pos.service';
import { LotPricingService } from '../../modules/sales/lot-pricing.service';
import { ProductPricingService, PRODUCT_FULLY_PRICED, PRODUCT_PRICING_PENDING } from '../../modules/sales/product-pricing.service';
import { SalesProfitabilityService } from '../../modules/sales/sales-profitability.service';
import { canEditLotPrice } from '../../modules/sales/lot-pricing';

process.env.PRODUCTION_QC_ENABLED = 'false';
process.env.PRODUCTION_LABELS_ENABLED = 'false';
process.env.PRODUCTION_RECALL_ENABLED = 'false';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`   ✅ PASS: ${label}`);
  else { console.error(`   ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
async function expectReject(label: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    check(label, false, 'call was unexpectedly allowed');
  } catch (err: any) {
    check(label, !match || match.test(err.message), err.message);
    console.log(`      ↳ "${err.message}"`);
  }
}
const near = (a: number | null | undefined, b: number, eps = 0.011) => a != null && Math.abs(a - b) < eps;

const ADMIN = { userId: undefined as string | undefined, role: 'SUPER_ADMIN', franchiseId: null };

async function runTest() {
  console.log('🧪 Set Price — product-level prices with finished-goods lots E2E\n');
  const testId = `SP${Date.now().toString().slice(-6)}`;

  const hq = await FranchiseService.getHqFranchiseOrNull();
  if (!hq) throw new Error('No HQ franchise configured — needed for this test');
  const warehouse = (await prisma.warehouse.findFirst({ where: { status: 'ACTIVE' } })) || (await prisma.warehouse.findFirst());
  if (!warehouse) throw new Error('No warehouse found in DB for test');
  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  ADMIN.userId = admin?.id;

  const rawItem = await prisma.inventoryItem.create({
    data: { name: `Raw Rice ${testId}`, sku: `RM-RICE-${testId}`, category: 'RAW_MATERIAL', unit: 'KG', currentStock: 0, franchiseId: null, basePrice: 40, costPrice: 40 },
  });
  const recipe = await prisma.recipe.create({
    data: {
      name: `Appam Test ${testId}`, recipeCode: `RCP-${testId}`, category: 'Test Category', yieldQty: 10, yieldUnit: 'KG',
      recipeItems: { create: [{ inventoryItemId: rawItem.id, quantityRequired: 10, unit: 'KG' }] },
    },
  });
  // As Packaging creates a new finished product: no selling price yet.
  const product = await prisma.product.create({
    data: { name: `APPAM ${testId} 500g`, sku: `FG-APM${testId}-500G`, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', basePrice: 0, pricingStatus: 'PENDING', taxPercent: 5, isActive: true },
  });

  const existingCash = await prisma.account.findFirst({ where: { type: 'CASH', status: 'ACTIVE', franchiseId: hq.id } });
  const cashAccount = existingCash || await prisma.account.create({ data: { name: `Test Cash ${testId}`, type: 'CASH', balance: 0, franchiseId: hq.id } });
  const cashBalanceBefore = cashAccount?.balance ?? null;

  const produce = async (kg: number, rawCost: number, packets: number, tag: string) => {
    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id, type: 'PURCHASE_IN', quantity: kg, warehouseId: warehouse.id,
      note: `Test stock ${testId}`, receiveAtCost: { unitCost: rawCost, batchNumber: `${tag}-${testId}` },
    });
    const prod = await ProductionService.startProduction({ recipeId: recipe.id, quantity: kg / 10, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' });
    const done = await ProductionService.approveProduction(prod.id, undefined, kg);
    const pk = await ProductionService.packageAndConfirm({ batchId: done.batch.id, packetSize: '500g', packedQty: packets, damagedQty: 0, productId: product.id, expectedPackagedQty: 0 });
    const lot = await prisma.inventoryBatch.findFirstOrThrow({ where: { productPackagingId: pk.packaging.id } });
    return { pk, lot, batch: done.batch };
  };
  const row = async () => (await ProductPricingService.listProducts({ search: testId, location: 'HQ' }, ADMIN)).products.find((p) => p.sku === product.sku)!;

  try {
    // ── First production: product awaits its prices ──
    console.log('1️⃣ First production: Lot A (10 KG @ ₹40 → 20 packets, ₹20/packet)');
    const { pk: pkA, lot: lotA, batch: batchA } = await produce(10, 40, 20, 'RAW1');
    const fgItemId = pkA.retailItem.id;
    const costA = lotA.unitCost!;
    check('Packaging created one finished-goods lot with its own cost (₹20)', lotA.inventoryItemId === fgItemId && near(costA, 20), `${costA}`);
    check('Lot number = <batch code>-L1', lotA.lotNumber === `${batchA.batchCode}-L1`, `${lotA.lotNumber}`);
    check('Lot carries no selling price', lotA.sellingPrice == null && lotA.pricingStatus == null);
    const r1 = await row();
    check('Set Price lists the product as PRICING_PENDING, all three prices missing', r1?.pricingStatus === PRODUCT_PRICING_PENDING && r1.missingTiers.length === 3);
    check('Latest production cost shown (₹20), 20 packets available', near(r1.latestCost, 20) && near(r1.availableQty, 20));
    await expectReject('A product without prices cannot be sold', () =>
      SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 100 }] }), /Pricing Pending/i);

    // ── Set Price ──
    console.log('\n2️⃣ Set Price: validation, partial prices, then all three');
    check('Only SUPER_ADMIN may edit prices', canEditLotPrice({ role: 'SUPER_ADMIN' }) && !canEditLotPrice({ role: 'FRANCHISE_ADMIN' }));
    await expectReject('Branch admin cannot set prices', () => ProductPricingService.setPrices(fgItemId, { customerPrice: 100 }, { role: 'FRANCHISE_ADMIN', franchiseId: hq.id }), /Not authorized/);
    await expectReject('Price ₹0 is refused', () => ProductPricingService.setPrices(fgItemId, { customerPrice: 0 }, ADMIN), /greater than ₹0/);
    await expectReject('All prices blank is refused', () => ProductPricingService.setPrices(fgItemId, {}, ADMIN), /at least one/);
    await expectReject('Below-cost price needs confirmation', () => ProductPricingService.setPrices(fgItemId, { customerPrice: 15 }, ADMIN), /below the latest production cost/);
    check('Refused attempt changed nothing', ((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fgItemId } })).customerPrice || 0) === 0);

    await ProductPricingService.setPrices(fgItemId, { customerPrice: 100, expected: { customerPrice: null, dealerPrice: null, franchisePrice: null } }, ADMIN);
    const r2 = await row();
    check('Customer price only → still PRICING_PENDING (Dealer, Franchise missing)', r2.pricingStatus === PRODUCT_PRICING_PENDING && r2.customerPrice === 100 && r2.missingTiers.join(',') === 'Dealer,Franchise');
    check('Missing prices are not filled with ₹0 or another tier', r2.dealerPrice == null && r2.franchisePrice == null);
    await expectReject('A Dealer sale is refused while the Dealer price is missing', () =>
      SalesService.createSalesOrder({ partyType: 'DEALER', items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 100 }] }), /Pricing Pending/i);

    await expectReject('Stale editor is refused', () =>
      ProductPricingService.setPrices(fgItemId, { customerPrice: 100, dealerPrice: 80, franchisePrice: 70, expected: { customerPrice: null, dealerPrice: null, franchisePrice: null } }, ADMIN), /changed by someone else/);
    // Entered including GST (5%): 105 / 84 / 73.50 → 100 / 80 / 70 excl.
    const set = await ProductPricingService.setPrices(fgItemId, {
      customerPrice: 105, dealerPrice: 84, franchisePrice: 73.5, taxInclusive: true,
      expected: { customerPrice: 100, dealerPrice: null, franchisePrice: null },
    }, ADMIN) as any;
    check('GST-inclusive entry stored excl. GST: ₹100 / ₹80 / ₹70', set.customerPrice === 100 && set.dealerPrice === 80 && set.franchisePrice === 70, JSON.stringify(set));
    const r3 = await row();
    check('All three set → FULLY_PRICED', r3.pricingStatus === PRODUCT_FULLY_PRICED);
    check('Product Master marked PRICED', (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).pricingStatus === 'PRICED');
    check('Production cost untouched by pricing', (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotA.id } })).unitCost === costA);

    // ── Later production at higher costs: prices reused ──
    console.log('\n3️⃣ More production at higher costs — prices reused');
    const { lot: lotB } = await produce(30, 90, 55, 'RAW2');
    const { lot: lotC } = await produce(10, 200, 20, 'RAW3');
    const costB = lotB.unitCost!;
    const costC = lotC.unitCost!;
    // Lot C draws the ₹90 raw left over first (FIFO), then ₹200 raw: ~₹86/packet.
    check('Each lot keeps its own, rising cost (₹20 < ₹45 < Lot C)', near(costB, 45) && costC > costB && costC > 80, `${costB} / ${costC}`);
    check('New lots of the same SKU, no selling price on them', [lotB, lotC].every((l) => l.inventoryItemId === fgItemId && l.sellingPrice == null));
    const r4 = await row();
    check('Still FULLY_PRICED, prices unchanged (no reset, no automatic increase)', r4.pricingStatus === PRODUCT_FULLY_PRICED && r4.customerPrice === 100 && r4.dealerPrice === 80 && r4.franchisePrice === 70);
    check('Latest cost = Lot C cost; 95 packets in 3 lots', near(r4.latestCost, costC) && near(r4.availableQty, 95) && r4.lotCount === 3);
    check('Inventory value = Σ lot qty × lot cost', near(r4.stockValue, 20 * costA + 55 * costB + 20 * costC), `${r4.stockValue}`);
    const tier = (k: string) => r4.tiers.find((t) => t.key === k)!;
    check('Negative-margin warning on Dealer and Franchise vs latest cost, not Customer', tier('dealerPrice').belowCost === true && tier('franchisePrice').belowCost === true && tier('customerPrice').belowCost === false);
    const lots = await LotPricingService.listLots({ sku: product.sku!, location: 'HQ' }, ADMIN);
    check('Stock Hub lots: 3 separate lots, total 95, same inventory value', lots.lots.length === 3 && near(lots.summary.availableQty, 95) && near(lots.summary.stockValue, r4.stockValue ?? -1));
    const opts = await LotPricingService.saleLotOptions({ productId: product.id, franchiseId: null }, ADMIN);
    check('All three lots selectable for sale, oldest first', opts.eligibleCount === 3 && opts.lots[0].id === lotA.id);

    // ── Sales Order: party type picks the price; lots only pick stock ──
    console.log('\n4️⃣ Sales Order priced by party type');
    const so = await SalesService.createSalesOrder({
      customerName: `Test ${testId}`,
      items: [
        { productId: product.id, productName: product.name, quantity: 5, rate: 1, inventoryBatchId: lotA.id }, // forged rate
        { productId: product.id, productName: product.name, quantity: 50, rate: 1, inventoryBatchId: lotB.id },
      ],
      idempotencyKey: `idem-${testId}`,
    } as any) as any;
    const soItems = await prisma.salesOrderItem.findMany({ where: { salesOrderId: so.id } });
    const soA = soItems.find((i) => i.inventoryBatchId === lotA.id);
    const soB = soItems.find((i) => i.inventoryBatchId === lotB.id);
    check('Customer order: both lot lines at the Customer price ₹100 (not the forged rate)', soA?.rate === 100 && soB?.rate === 100);
    check('Subtotal ₹5,500, GST ₹275', near(so.subTotal, 5500) && near(so.taxAmount, 275), `${so.subTotal} / ${so.taxAmount}`);
    check('Lot cost snapshotted per line', near(soA?.lotUnitCost, costA) && near(soB?.lotUnitCost, costB));
    check(`Estimated profit from each lot's own cost (₹${5 * (100 - costA) + 50 * (100 - costB)})`, near(so.estimatedGrossProfit, 5 * (100 - costA) + 50 * (100 - costB)), `${so.estimatedGrossProfit}`);
    const dup = await SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 5, rate: 1, inventoryBatchId: lotA.id }], idempotencyKey: `idem-${testId}` } as any) as any;
    check('Duplicate submission returns the same order', dup.id === so.id);
    check('Saving the order deducted no stock', (await prisma.inventoryBatch.findMany({ where: { id: { in: [lotA.id, lotB.id] } } })).every((l) => l.currentQty === l.initialQty));
    await expectReject('Overselling a lot is refused (60 > 20 in Lot A)', () =>
      SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 60, rate: 1, inventoryBatchId: lotA.id }] }), /only 20 available/);

    const dealer = await prisma.dealer.findFirst({ where: { status: { not: 'INACTIVE' } } });
    const dealerSo = await SalesService.createSalesOrder({ partyType: 'DEALER', partyId: dealer?.id, customerName: dealer?.name || 'Dealer', items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 1 }] }) as any;
    check('Dealer order: Dealer price ₹80, party type saved, no customer link', dealerSo.items[0].rate === 80 && dealerSo.partyType === 'DEALER' && dealerSo.customerId == null && (dealer ? dealerSo.partyId === dealer.id : true));
    const franchise = await prisma.franchise.findFirst({ where: { isHQ: false } });
    const frSo = await SalesService.createSalesOrder({ partyType: 'FRANCHISE', partyId: franchise?.id, items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 1, inventoryBatchId: lotC.id }] }) as any;
    check('Franchise order: Franchise price ₹70 on a lot line', frSo.items[0].rate === 70 && frSo.partyType === 'FRANCHISE');
    const est = await SalesProfitabilityService.estimateSalesOrder({ partyType: 'FRANCHISE', items: [{ productId: product.id, productName: product.name, quantity: 2, inventoryBatchId: lotC.id }] });
    const loss = est.lines[0];
    check('Loss warning: Franchise price ₹70 below Lot C cost', loss.status === 'LOSS' && near(loss.unitProfit, 70 - costC) && !!loss.warning, JSON.stringify(loss));

    // ── Estimate ──
    console.log('\n5️⃣ Estimate');
    const qt = await SalesService.createQuotation({ partyType: 'DEALER', items: [{ productId: product.id, productName: product.name, quantity: 25, rate: 1, inventoryBatchId: lotA.id }] } as any) as any;
    check('Dealer estimate priced at ₹80 on a lot line, no stock touched', qt.items[0].rate === 80 && qt.items[0].inventoryBatchId === lotA.id
      && (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotA.id } })).currentQty === 20);
    await expectReject('Converting the estimate revalidates lot stock (25 > 20)', () => SalesService.convertQuotationToSalesOrder(qt.id, 'test'), /only 20 available/);

    // ── Convert the customer order → Sale Invoice (stock issued from lots) ──
    console.log('\n6️⃣ Convert Sales Order → Sale Invoice');
    await SalesService.updateSalesOrder(so.id, { status: 'CONFIRMED' });
    const conv = await SalesService.convertSalesOrderToSale(so.id, 'test', { franchiseId: hq.id }) as any;
    const convItems = await prisma.orderItem.findMany({ where: { orderId: conv.sale.id } });
    check('Converted sale keeps lots and the ₹100 price', convItems.length === 2 && convItems.every((i) => i.price === 100) && convItems.some((i) => i.inventoryBatchId === lotA.id));
    const lotQty = async (id: string) => (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id } })).currentQty;
    check('Stock issued from the chosen lots (A 20→15, B 55→5)', (await lotQty(lotA.id)) === 15 && (await lotQty(lotB.id)) === 5);
    const convMoves = await prisma.stockMovement.findMany({ where: { referenceType: 'ORDER', referenceId: conv.sale.id, movementType: 'SALES_OUT' } });
    check('One SALES_OUT per lot at the lot cost', convMoves.length === 2 && convMoves.some((m) => m.batchId === lotA.id && near(m.unitCost, costA)) && convMoves.some((m) => m.batchId === lotB.id && near(m.unitCost, costB)));
    await expectReject('Converting the same order again is refused', () => SalesService.convertSalesOrderToSale(so.id, 'test', { franchiseId: hq.id }), /already been converted/);

    // ── Sale Invoice for a dealer ──
    console.log('\n7️⃣ Sale Invoice (Dealer)');
    const inv = await FinanceService.createInvoice({
      franchiseId: hq.id, partyType: 'DEALER', partyId: dealer?.id, receivedAmount: 0, createdBy: 'test',
      items: [{ productId: product.id, productName: product.name, qty: 3, rate: 1, gst: 0, inventoryBatchId: lotA.id }],
    } as any) as any;
    const invItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: inv.order.id } });
    check('Invoice line at the Dealer price ₹80 with 5% GST', invItem.price === 80 && invItem.inventoryBatchId === lotA.id && near(inv.order.taxAmount, 12), `${invItem.price} / ${inv.order.taxAmount}`);
    check('Deducted from Lot A (15 → 12)', (await lotQty(lotA.id)) === 12);

    // ── POS ──
    console.log('\n8️⃣ POS counter billing');
    const settled = await prisma.dailySettlement.findFirst({ where: { franchiseId: hq.id, businessDate: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } });
    if (settled) {
      console.log('   ⏭️  SKIP: HQ business day already closed — POS checkout not possible today');
    } else {
      const pos = await POSService.checkout({
        franchiseId: hq.id, accountId: cashAccount.id, items: [{ productId: product.id, quantity: 2, price: 999, inventoryBatchId: lotB.id }],
        subTotal: 0, taxAmount: 0, discountAmount: 0, totalAmount: 0, paymentMode: 'CASH', paidAmount: 1000,
      }) as any;
      const posItem = pos.orderItems[0];
      check('Customer mode charged ₹100 (not the sent ₹999) from Lot B', posItem.price === 100 && posItem.inventoryBatchId === lotB.id);
      check('POS line cost = Lot B cost; Lot B 5 → 3', near(posItem.unitCost, costB) && (await lotQty(lotB.id)) === 3);
      const posStd = await POSService.checkout({
        franchiseId: hq.id, accountId: cashAccount.id, partyType: 'DEALER', items: [{ productId: product.id, quantity: 1, price: 1 }],
        subTotal: 0, taxAmount: 0, discountAmount: 0, totalAmount: 0, paymentMode: 'CASH', paidAmount: 1000,
      } as any) as any;
      check('Dealer mode charged the Dealer price ₹80', posStd.orderItems[0].price === 80);
      await SalesService.createReturnOrder({
        posOrderId: pos.id, reason: 'Test return', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 100, condition: 'GOOD' }],
      } as any);
      check('Return restored stock to the originating lot (Lot B 3 → 4)', (await lotQty(lotB.id)) === 4);
    }

    // ── Delivery Challan ──
    console.log('\n9️⃣ Delivery Challan');
    const dc = await SalesService.createDeliveryChallan({ status: 'DRAFT', items: [{ productId: product.id, productName: product.name, quantity: 2, inventoryBatchId: lotA.id }] } as any) as any;
    check('Challan keeps the lot; rate is the Customer price', dc.items[0].inventoryBatchId === lotA.id && dc.items[0].lotNumber === lotA.lotNumber && dc.items[0].rate === 100, `${dc.items[0].rate}`);

    // ── Price change: audited, history untouched ──
    console.log('\n🔟 Price change');
    await ProductPricingService.setPrices(fgItemId, { customerPrice: 120, dealerPrice: 80, franchisePrice: 70, reason: 'Revised', acknowledgeBelowCost: true }, ADMIN);
    check('Existing invoice line still ₹80 / converted sale still ₹100', (await prisma.orderItem.findFirstOrThrow({ where: { orderId: inv.order.id } })).price === 80
      && (await prisma.orderItem.findMany({ where: { orderId: conv.sale.id } })).every((i) => i.price === 100));
    const detail = await ProductPricingService.getProduct(fgItemId, ADMIN);
    check('Price history: 3 changes, newest ₹100 → ₹120 with reason', detail.history.length === 3 && detail.history[0].previous.customerPrice === 100 && detail.history[0].prices.customerPrice === 120 && detail.history[0].reason === 'Revised');
    check('History records the GST basis entered', detail.history[1].enteredTaxInclusive === true && detail.history[0].enteredTaxInclusive === false);
    const plain = await SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 1 }] }) as any;
    check('New orders use the new price ₹120 (no lot needed)', plain.items[0].rate === 120 && plain.items[0].inventoryBatchId === null);

    // ── Expired lots ──
    console.log('\n⛔ Expired lot');
    await prisma.inventoryBatch.update({ where: { id: lotA.id }, data: { expDate: new Date(Date.now() - 86400000) } });
    const optsExpired = await LotPricingService.saleLotOptions({ productId: product.id, franchiseId: null }, ADMIN);
    check('Expired Lot A not offered for sale', !optsExpired.lots.some((l) => l.id === lotA.id));
    await expectReject('Expired lot cannot be invoiced', () => FinanceService.createInvoice({
      franchiseId: hq.id, partyType: 'CUSTOMER', receivedAmount: 0, items: [{ productId: product.id, qty: 1, inventoryBatchId: lotA.id }],
    }), /expired/);
  } finally {
    if (existingCash && cashBalanceBefore != null) await prisma.account.update({ where: { id: existingCash.id }, data: { balance: cashBalanceBefore } });
    await cleanup(testId);
  }

  if (failures === 0) console.log('🎉 ALL SET PRICE / PRODUCT PRICING TESTS PASSED');
  else { console.error(`💥 ${failures} CHECK(S) FAILED`); process.exit(1); }
}

// Removes everything a run created, found through its products / recipe (so
// it also clears an interrupted run: npx tsx <this file> --cleanup SP123456).
async function cleanup(testId: string) {
  console.log('\n🧹 Cleaning up test records...');
  const productIds = (await prisma.product.findMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] }, select: { id: true } })).map(p => p.id);
  const items = await prisma.inventoryItem.findMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] }, select: { id: true, sku: true } });
  const itemIds = items.map(i => i.id);
  const recipeIds = (await prisma.recipe.findMany({ where: { name: { contains: testId } }, select: { id: true } })).map(r => r.id);

  const orderIds = [...new Set((await prisma.orderItem.findMany({ where: { productId: { in: productIds } }, select: { orderId: true } })).map(o => o.orderId))];
  const returnIds = (await prisma.returnOrder.findMany({ where: { OR: [{ posOrderId: { in: orderIds } }, { items: { some: { productId: { in: productIds } } } }] }, select: { id: true } })).map(r => r.id);
  await prisma.returnItem.deleteMany({ where: { returnId: { in: returnIds } } });
  await prisma.customerLedger.deleteMany({ where: { referenceId: { in: [...returnIds, ...orderIds] } } });
  await prisma.stockMovement.deleteMany({ where: { referenceId: { in: [...returnIds, ...orderIds] } } });
  await prisma.returnOrder.deleteMany({ where: { id: { in: returnIds } } });
  await prisma.paymentAllocation.deleteMany({ where: { invoice: { orderId: { in: orderIds } } } });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  const soIds = [...new Set((await prisma.salesOrderItem.findMany({ where: { productId: { in: productIds } }, select: { salesOrderId: true } })).map(i => i.salesOrderId))];
  await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: { in: soIds } } });
  await prisma.salesOrder.deleteMany({ where: { id: { in: soIds } } });
  const qtIds = [...new Set((await prisma.quotationItem.findMany({ where: { productId: { in: productIds } }, select: { quotationId: true } })).map(i => i.quotationId))];
  await prisma.quotationItem.deleteMany({ where: { quotationId: { in: qtIds } } });
  await prisma.quotation.deleteMany({ where: { id: { in: qtIds } } });
  const dcIds = [...new Set((await prisma.deliveryChallanItem.findMany({ where: { productId: { in: productIds } }, select: { challanId: true } })).map(i => i.challanId))];
  await prisma.deliveryChallanItem.deleteMany({ where: { challanId: { in: dcIds } } });
  await prisma.deliveryChallan.deleteMany({ where: { id: { in: dcIds } } });

  await prisma.auditLog.deleteMany({ where: { module: 'SET_PRICE', recordId: { in: items.map(i => i.sku) } } });
  await prisma.finishedGoodsLotPriceHistory.deleteMany({ where: { inventoryBatch: { inventoryItemId: { in: itemIds } } } });
  await prisma.wasteEntry.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
  const prodWhere = { production: { recipeId: { in: recipeIds } } };
  await prisma.productionExpense.deleteMany({ where: { productBatch: prodWhere } });
  await prisma.productPackaging.deleteMany({ where: { batch: prodWhere } });
  await prisma.productBatch.deleteMany({ where: prodWhere });
  await prisma.productionStageLog.deleteMany({ where: prodWhere });
  await prisma.productionItem.deleteMany({ where: prodWhere });
  await prisma.production.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await prisma.recipeProduct.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await prisma.recipeItem.deleteMany({ where: { recipeId: { in: recipeIds } } });
  await prisma.recipe.deleteMany({ where: { id: { in: recipeIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.account.deleteMany({ where: { name: `Test Cash ${testId}`, payments: { none: {} } } });
  console.log('🧹 Cleanup complete.\n');
}

const cleanupArg = process.argv.indexOf('--cleanup');
(cleanupArg >= 0 ? cleanup(process.argv[cleanupArg + 1] || '__none__') : runTest())
  .catch(err => { console.error('Test execution error:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
