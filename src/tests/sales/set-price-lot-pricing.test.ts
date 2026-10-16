// End-to-end check of Production > Set Price (batch-wise finished-goods pricing)
// and lot selection across Sales Order, Estimate, Sale Invoice, POS,
// Delivery Challan and returns. Follows the Phase 15 test plan.
// Run: npx tsx src/tests/sales/set-price-lot-pricing.test.ts
import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { POSService } from '../../modules/pos/pos.service';
import { LotPricingService } from '../../modules/sales/lot-pricing.service';
import { SalesProfitabilityService } from '../../modules/sales/sales-profitability.service';
import { canEditLotPrice, checkLotPrice, summarizeLotAllocations, LOT_PRICED, LOT_PRICING_PENDING } from '../../modules/sales/lot-pricing';
import { ProductService } from '../../modules/product/product.service';

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
  console.log('🧪 Set Price — finished-goods lot pricing E2E\n');
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
  // Master price ₹150: lot lines must ignore it, non-lot lines keep it.
  const product = await prisma.product.create({
    data: { name: `APPAM ${testId} 500g`, sku: `FG-APM${testId}-500G`, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', basePrice: 150, taxPercent: 5, isActive: true },
  });

  // Counter sales need an active HQ cash account; use the existing one (balance
  // restored afterwards) or a temporary one removed in cleanup.
  const existingCash = await prisma.account.findFirst({ where: { type: 'CASH', status: 'ACTIVE', franchiseId: hq.id } });
  const cashAccount = existingCash || await prisma.account.create({ data: { name: `Test Cash ${testId}`, type: 'CASH', balance: 0, franchiseId: hq.id } });
  const cashBalanceBefore = cashAccount?.balance ?? null;

  try {
    // ── 1–4. Produce Lot A, confirm packaging, lot exists unpriced ──
    console.log('1️⃣–4️⃣ Produce APPAM 500g Lot A (10 KG raw @ ₹40) → 20 packets');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id, type: 'PURCHASE_IN', quantity: 10, warehouseId: warehouse.id,
      note: `Test stock ${testId}`, receiveAtCost: { unitCost: 40, batchNumber: `RAW1-${testId}` },
    });
    const prodA = await ProductionService.startProduction({ recipeId: recipe.id, quantity: 1, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' });
    const doneA = await ProductionService.approveProduction(prodA.id, undefined, 10);
    const pkA = await ProductionService.packageAndConfirm({ batchId: doneA.batch.id, packetSize: '500g', packedQty: 20, damagedQty: 0, productId: product.id, expectedPackagedQty: 0 });
    const fgItemId = pkA.retailItem.id;
    const lotA = await prisma.inventoryBatch.findFirstOrThrow({ where: { productPackagingId: pkA.packaging.id } });
    const costA = lotA.unitCost!;
    check('Packaging created one finished-goods lot linked to the packaging run', lotA.inventoryItemId === fgItemId && lotA.productBatchId === doneA.batch.id);
    check('Lot production cost = packaging cost snapshot (₹20/packet)', near(costA, 20) && near((pkA.packaging.costBreakdown as any)?.stockUnitCost, costA), `lot ${costA}, snapshot ${(pkA.packaging.costBreakdown as any)?.stockUnitCost}`);
    check('New lot is PRICING_PENDING with no selling price', lotA.pricingStatus === LOT_PRICING_PENDING && lotA.sellingPrice == null);
    check('Lot number = <batch code>-L1', lotA.lotNumber === `${doneA.batch.batchCode}-L1`, `${lotA.lotNumber}`);
    check('No duplicate Product Master SKU created', (await prisma.product.count({ where: { sku: product.sku } })) === 1);

    await expectReject('An unpriced lot cannot be sold', () =>
      SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 100, inventoryBatchId: lotA.id }] }), /no selling price/i);

    // ── 5–6. Set Price on Lot A ──
    console.log('\n5️⃣–6️⃣ Set Price: Lot A');
    const list1 = await LotPricingService.listLots({ sku: product.sku!, location: 'HQ' }, ADMIN);
    check('Set Price lists Lot A as awaiting pricing', list1.lots.length === 1 && list1.lots[0].pricingStatus === LOT_PRICING_PENDING && list1.summary.awaitingPricing === 1);
    check('Only SUPER_ADMIN may edit prices', canEditLotPrice({ role: 'SUPER_ADMIN' }) && !canEditLotPrice({ role: 'FRANCHISE_ADMIN' }));
    await expectReject('Price ≤ 0 is refused', () => LotPricingService.setPrice(lotA.id, { sellingPrice: 0 }, ADMIN), /greater than/);
    await expectReject('Below-cost price needs explicit acknowledgement', () => LotPricingService.setPrice(lotA.id, { sellingPrice: 3 }, ADMIN), /₹17 below production cost per packet\. Estimated loss: ₹17 per packet/);
    check('Refused below-cost attempt changed nothing', (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotA.id } })).sellingPrice == null);
    const below = checkLotPrice({ price: 100, taxInclusive: false, taxPercent: 5, unitCost: 117 });
    check('Warning text matches spec (cost ₹117, price ₹100)', below.warning === 'Warning: Selling price is ₹17 below production cost per packet. Estimated loss: ₹17 per packet.', below.warning || '');
    const setA = await LotPricingService.setPrice(lotA.id, { sellingPrice: 100, taxInclusive: false, expectedPrice: null }, ADMIN);
    check('Lot A priced at ₹100 (profit ₹80/packet)', setA.changed === true && near((setA as any).unitProfit, 100 - costA));
    await expectReject('Stale editor (expected price mismatch) is refused', () => LotPricingService.setPrice(lotA.id, { sellingPrice: 105, expectedPrice: null }, ADMIN), /changed by someone else/);
    const lotAAfter = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotA.id } });
    check('Production cost untouched by pricing', lotAAfter.unitCost === costA && lotAAfter.pricingStatus === LOT_PRICED);

    // ── 7–10. Lot B: separate lot, separate price ──
    console.log('\n7️⃣–🔟 Produce Lot B (30 KG raw @ ₹90) → 55 packets, price ₹200');
    await InventoryService.recordMovement(prisma, {
      itemId: rawItem.id, type: 'PURCHASE_IN', quantity: 30, warehouseId: warehouse.id,
      note: `Test stock ${testId}`, receiveAtCost: { unitCost: 90, batchNumber: `RAW2-${testId}` },
    });
    const prodB = await ProductionService.startProduction({ recipeId: recipe.id, quantity: 3, franchiseId: hq.id, warehouseId: warehouse.id, productionType: 'FINISHED_GOOD' });
    const doneB = await ProductionService.approveProduction(prodB.id, undefined, 30);
    const pkB = await ProductionService.packageAndConfirm({ batchId: doneB.batch.id, packetSize: '500g', packedQty: 55, damagedQty: 0, productId: product.id, expectedPackagedQty: 0 });
    const lotB = await prisma.inventoryBatch.findFirstOrThrow({ where: { productPackagingId: pkB.packaging.id } });
    const costB = lotB.unitCost!;
    check('Lot B is a separate lot of the same SKU', lotB.id !== lotA.id && lotB.inventoryItemId === fgItemId && near(costB, 45), `cost ${costB}`);
    await LotPricingService.setPrice(lotB.id, { sellingPrice: 200 }, ADMIN);
    check('Lot A still ₹100 after pricing Lot B', (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotA.id } })).sellingPrice === 100);

    // ── 11. Stock Hub / listing shows both lots ──
    const list2 = await LotPricingService.listLots({ sku: product.sku!, location: 'HQ' }, ADMIN);
    check('Both lots listed, both priced, 75 packets available', list2.lots.length === 2 && list2.summary.pricedLots === 2 && near(list2.summary.availablePricedQty, 75), JSON.stringify(list2.summary));
    // Product search (POS / Sales Order / Estimate / Invoice) carries the lot prices.
    const [listed] = await ProductService.getAll({ id: product.id }, hq.id) as any[];
    check('Product list shows lot prices ₹100–₹200 (2 priced lots)', listed?.lotPricing?.pricedLots === 2 && listed.lotPricing.minPrice === 100 && listed.lotPricing.maxPrice === 200, JSON.stringify(listed?.lotPricing));
    check('Product Master price is not overwritten by lot pricing', (await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).basePrice === 150);
    const opts = await LotPricingService.saleLotOptions({ productId: product.id, franchiseId: null }, ADMIN);
    check('Sale lot options: both selectable, oldest (Lot A) first', opts.eligibleCount === 2 && opts.lots[0].id === lotA.id && opts.lots[1].id === lotB.id);

    // ── 12–19. Sales Order with lot allocations ──
    console.log('\n1️⃣2️⃣–1️⃣9️⃣ Sales Order: 5 × Lot A + 50 × Lot B');
    const so = await SalesService.createSalesOrder({
      customerName: `Test ${testId}`,
      items: [
        { productId: product.id, productName: product.name, quantity: 5, rate: 1, inventoryBatchId: lotA.id }, // forged rate
        { productId: product.id, productName: product.name, quantity: 50, rate: 1, inventoryBatchId: lotB.id },
      ],
      idempotencyKey: `idem-${testId}`,
    } as any) as any;
    const soItems = await prisma.salesOrderItem.findMany({ where: { salesOrderId: so.id } });
    const soA = soItems.find(i => i.inventoryBatchId === lotA.id);
    const soB = soItems.find(i => i.inventoryBatchId === lotB.id);
    check('Two separate lot allocation lines saved', soItems.length === 2 && !!soA && !!soB);
    check('Server priced each line from its lot (₹100 / ₹200), not the forged rate', soA?.rate === 100 && soB?.rate === 200);
    check('Total quantity 55', (soA?.quantity || 0) + (soB?.quantity || 0) === 55);
    check('Selling value ₹10,500 excl. GST', near(so.subTotal, 10500), `${so.subTotal}`);
    check('GST 5% on top → ₹11,025', near(so.taxAmount, 525) && near(so.totalAmount, 11025), `${so.taxAmount} / ${so.totalAmount}`);
    check('Lot number and cost snapshotted on the lines', soA?.lotNumber === lotA.lotNumber && near(soA?.lotUnitCost, costA) && near(soB?.lotUnitCost, costB));
    const expectedProfit = 5 * (100 - costA) + 50 * (200 - costB);
    check(`Estimated gross profit = Σ lot profit (₹${expectedProfit})`, near(so.estimatedGrossProfit, expectedProfit), `${so.estimatedGrossProfit}`);
    const avg = summarizeLotAllocations([{ quantity: 5, price: 100, unitCost: costA }, { quantity: 50, price: 200, unitCost: costB }]);
    check('Weighted average selling price ₹190.91 (display only)', avg.weightedAvgPrice === 190.91 && avg.totalValue === 10500, JSON.stringify(avg));
    const dup = await SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 5, rate: 1, inventoryBatchId: lotA.id }], idempotencyKey: `idem-${testId}` } as any) as any;
    check('Duplicate submission (same idempotency key) returns the same order', dup.id === so.id);
    const lotsAfterSO = await prisma.inventoryBatch.findMany({ where: { id: { in: [lotA.id, lotB.id] } } });
    check('Saving the Sales Order deducted no stock', lotsAfterSO.every(l => l.currentQty === l.initialQty));
    await expectReject('Overselling a lot is refused (60 > 20 in Lot A)', () =>
      SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 60, rate: 1, inventoryBatchId: lotA.id }] }), /only 20 available/);

    // ── 20–22. Below-cost line warning, not hidden by the profitable average ──
    console.log('\n2️⃣0️⃣–2️⃣2️⃣ Below-cost warning per lot');
    const est = await SalesProfitabilityService.estimateSalesOrder({
      items: [
        { productId: product.id, productName: product.name, quantity: 5, inventoryBatchId: lotA.id, discountPercent: 90 }, // net ₹10 < cost ₹20
        { productId: product.id, productName: product.name, quantity: 50, inventoryBatchId: lotB.id },
      ],
    });
    const lossLine = est.lines.find(l => l.inventoryBatchId === lotA.id)!;
    check('Lot A line is a loss of ₹10/packet, ₹50 for 5', lossLine.status === 'LOSS' && near(lossLine.unitProfit, -10) && near(lossLine.profit, -50), JSON.stringify(lossLine));
    check('Lot-specific warning text', lossLine.warning === `Lot ${lotA.lotNumber} is being sold ₹10 below production cost per packet. Estimated loss for 5 packets: ₹50.`, lossLine.warning || '');
    check('Order is still profitable overall, warning not hidden', (est.summary.profit || 0) > 0 && !!lossLine.warning);
    check('Per-product weighted averages reported', est.products.length === 1 && est.products[0].weightedAvgSellingPrice === 190.91 && est.products[0].lots === 2, JSON.stringify(est.products));

    // ── 23–24. Existing workflow: confirm, convert to Sale Invoice ──
    console.log('\n2️⃣3️⃣–2️⃣4️⃣ Confirm and convert the Sales Order');
    await SalesService.updateSalesOrder(so.id, { status: 'CONFIRMED' });
    const conv = await SalesService.convertSalesOrderToSale(so.id, 'test', { franchiseId: hq.id }) as any;
    const convItems = await prisma.orderItem.findMany({ where: { orderId: conv.sale.id } });
    check('Converted sale keeps both lot identities and lot prices', convItems.length === 2 && convItems.some(i => i.inventoryBatchId === lotA.id && i.price === 100) && convItems.some(i => i.inventoryBatchId === lotB.id && i.price === 200));
    check('Converted totals copied, not rebuilt from the average', near(conv.sale.subTotal, 10500) && near(conv.sale.totalAmount, 11025));

    // Stock is issued when the Sale Invoice is created — from the chosen lots.
    const lotQty = async (id: string) => (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id } })).currentQty;
    check('Conversion issued the chosen lots (A 20→15, B 55→5)', (await lotQty(lotA.id)) === 15 && (await lotQty(lotB.id)) === 5, `${await lotQty(lotA.id)} / ${await lotQty(lotB.id)}`);
    const convMoves = await prisma.stockMovement.findMany({ where: { referenceType: 'ORDER', referenceId: conv.sale.id, movementType: 'SALES_OUT' } });
    check('One SALES_OUT movement per lot, with lot id and cost', convMoves.length === 2 && convMoves.some(m => m.batchId === lotA.id && near(m.unitCost, costA)) && convMoves.some(m => m.batchId === lotB.id && near(m.unitCost, costB)));
    const convOrder = await prisma.order.findUniqueOrThrow({ where: { id: conv.sale.id }, include: { orderItems: true } });
    check('Invoice marked deducted, linked to its Sales Order', convOrder.inventory_deducted === true && convOrder.sourceSalesOrderId === so.id);
    check('Actual cost (COGS) recorded per line from the lot', convOrder.orderItems.some(i => i.inventoryBatchId === lotA.id && near(i.totalCost, 5 * costA)) && convOrder.orderItems.some(i => i.inventoryBatchId === lotB.id && near(i.totalCost, 50 * costB)));
    await expectReject('Converting the same Sales Order again is refused', () => SalesService.convertSalesOrderToSale(so.id, 'test', { franchiseId: hq.id }), /already been converted/);
    const rerun = await prisma.$transaction((tx) => SalesService.issueInvoiceStock(tx, conv.sale.id, hq.id));
    check('Re-running the stock issue is a no-op (no double deduction)', rerun.skipped === true && (await lotQty(lotA.id)) === 15 && (await lotQty(lotB.id)) === 5);
    const dcFromInv = await SalesService.createDeliveryChallan({
      sourceInvoiceId: conv.sale.id, status: 'IN_TRANSIT', deductStockOnDispatch: true,
      items: [{ productId: product.id, productName: product.name, quantity: 5, inventoryBatchId: lotA.id }],
    } as any) as any;
    check('Challan for the already-issued invoice deducts nothing again', (await lotQty(lotA.id)) === 15 && dcFromInv.items[0].inventoryBatchId === lotA.id);

    // ── Estimate: no reservation, revalidated on conversion ──
    console.log('\n📝 Estimate with lot price');
    const qt = await SalesService.createQuotation({ items: [{ productId: product.id, productName: product.name, quantity: 25, rate: 1, inventoryBatchId: lotA.id }] }) as any;
    check('Estimate priced from the lot (₹100), no stock check or deduction', qt.items[0].rate === 100 && qt.items[0].inventoryBatchId === lotA.id
      && (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotA.id } })).currentQty === 15);
    await expectReject('Converting the estimate revalidates lot stock (25 > 15)', () => SalesService.convertQuotationToSalesOrder(qt.id, 'test'), /only 15 available/);

    // ── Sale Invoice: exact lot deduction ──
    console.log('\n🧾 Sale Invoice from lots');
    const inv = await FinanceService.createInvoice({
      franchiseId: hq.id, partyType: 'CUSTOMER', receivedAmount: 0, createdBy: 'test',
      items: [
        { productId: product.id, productName: product.name, qty: 3, rate: 1, gst: 0, inventoryBatchId: lotA.id },
        { productId: product.id, productName: product.name, qty: 2, rate: 1, gst: 0, inventoryBatchId: lotB.id },
      ],
    }) as any;
    const invItems = await prisma.orderItem.findMany({ where: { orderId: inv.order.id } });
    check('Invoice lines priced from lots with lot GST (₹100/₹200 @5%)', invItems.some(i => i.inventoryBatchId === lotA.id && i.price === 100) && invItems.some(i => i.inventoryBatchId === lotB.id && i.price === 200) && near(inv.order.taxAmount, 35));
    const [aInv, bInv] = await Promise.all([lotA.id, lotB.id].map(id => prisma.inventoryBatch.findUniqueOrThrow({ where: { id } })));
    check('Deducted from the exact lots (A 15→12, B 5→3)', aInv.currentQty === 12 && bInv.currentQty === 3, `${aInv.currentQty} / ${bInv.currentQty}`);
    const invMoves = await prisma.stockMovement.findMany({ where: { referenceId: inv.order.id, itemId: fgItemId } });
    check('Each stock movement carries its lot id and cost', invMoves.length === 2 && invMoves.some(m => m.batchId === lotA.id && near(m.unitCost, costA)) && invMoves.some(m => m.batchId === lotB.id && near(m.unitCost, costB)));

    // ── 25–27. POS with lot allocation + return to the originating lot ──
    console.log('\n2️⃣5️⃣–2️⃣7️⃣ POS counter sale from Lot B, then a return');
    const settled = await prisma.dailySettlement.findFirst({ where: { franchiseId: hq.id, businessDate: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } });
    if (settled) {
      console.log('   ⏭️  SKIP: HQ business day already closed — POS checkout not possible today');
    } else {
      const pos = await POSService.checkout({
        franchiseId: hq.id, accountId: cashAccount.id, items: [{ productId: product.id, quantity: 2, price: 999, inventoryBatchId: lotB.id }],
        subTotal: 0, taxAmount: 0, discountAmount: 0, totalAmount: 0, paymentMode: 'CASH', paidAmount: 1000,
      }) as any;
      const posItem = pos.orderItems[0];
      check('POS charged the lot price ₹200 (not the sent ₹999 / master ₹150)', posItem.price === 200 && posItem.inventoryBatchId === lotB.id && posItem.lotNumber === lotB.lotNumber);
      check('POS line cost = Lot B production cost', near(posItem.unitCost, costB));
      check('Lot B deducted 3 → 1', (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotB.id } })).currentQty === 1);

      await SalesService.createReturnOrder({
        posOrderId: pos.id, reason: 'Test return', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 200, condition: 'GOOD' }],
      } as any) as any;
      check('Return restored stock to the originating lot (Lot B 1 → 2)', (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: lotB.id } })).currentQty === 2);
    }

    // ── 28. Delivery Challan keeps the lot (traceability only) ──
    console.log('\n2️⃣8️⃣ Delivery Challan');
    const dc = await SalesService.createDeliveryChallan({
      customerId: undefined, status: 'DRAFT',
      items: [{ productId: product.id, productName: product.name, quantity: 2, inventoryBatchId: lotA.id }],
    }) as any;
    check('Challan line keeps the lot id and number', dc.items[0].inventoryBatchId === lotA.id && dc.items[0].lotNumber === lotA.lotNumber);
    check('Challan does not invent a lot selling price (master price kept)', dc.items[0].rate === 150, `${dc.items[0].rate}`);

    // ── 29. Historical prices unchanged after a price edit ──
    console.log('\n2️⃣9️⃣ Price change does not touch finalized documents');
    await LotPricingService.setPrice(lotA.id, { sellingPrice: 120, reason: 'Revised' }, ADMIN);
    const invAfter = await prisma.orderItem.findFirstOrThrow({ where: { orderId: inv.order.id, inventoryBatchId: lotA.id } });
    check('Invoice line still ₹100', invAfter.price === 100);
    const [relisted] = await ProductService.getAll({ id: product.id }, hq.id) as any[];
    check('Product search shows the new lot price at once (₹120–₹200)', relisted?.lotPricing?.minPrice === 120 && relisted.lotPricing.maxPrice === 200, JSON.stringify(relisted?.lotPricing));
    const detail = await LotPricingService.getLot(lotA.id, ADMIN);
    check('Price history: ₹100 then ₹100 → ₹120, with reason', detail.history.length === 2 && detail.history[0].previousPrice === 100 && detail.history[0].newPrice === 120 && detail.history[0].reason === 'Revised');

    // ── Expired / unavailable lots are never offered ──
    console.log('\n⛔ Expired lot');
    await prisma.inventoryBatch.update({ where: { id: lotA.id }, data: { expDate: new Date(Date.now() - 86400000) } });
    const optsExpired = await LotPricingService.saleLotOptions({ productId: product.id, franchiseId: null }, ADMIN);
    check('Expired Lot A not offered for sale', !optsExpired.lots.some(l => l.id === lotA.id));
    await expectReject('Expired lot cannot be invoiced', () => FinanceService.createInvoice({
      franchiseId: hq.id, partyType: 'CUSTOMER', receivedAmount: 0, items: [{ productId: product.id, qty: 1, inventoryBatchId: lotA.id }],
    }), /expired/);

    // ── 30. Standard (non-lot) flow unchanged ──
    console.log('\n3️⃣0️⃣ Non-lot lines keep the existing master-price flow');
    const plain = await SalesService.createSalesOrder({ items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 1 }] }) as any;
    check('Non-lot Sales Order line priced at master ₹150, no lot', plain.items[0].rate === 150 && plain.items[0].inventoryBatchId === null);
  } finally {
    if (existingCash && cashBalanceBefore != null) await prisma.account.update({ where: { id: existingCash.id }, data: { balance: cashBalanceBefore } });
    await cleanup(testId);
  }

  if (failures === 0) console.log('🎉 ALL SET PRICE / LOT PRICING TESTS PASSED');
  else { console.error(`💥 ${failures} CHECK(S) FAILED`); process.exit(1); }
}

// Removes everything a run created, found through its products / recipe (so
// it also clears an interrupted run: npx tsx <this file> --cleanup SP123456).
async function cleanup(testId: string) {
  console.log('\n🧹 Cleaning up test records...');
  const productIds = (await prisma.product.findMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] }, select: { id: true } })).map(p => p.id);
  const itemIds = (await prisma.inventoryItem.findMany({ where: { OR: [{ sku: { contains: testId } }, { name: { contains: testId } }] }, select: { id: true } })).map(i => i.id);
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
