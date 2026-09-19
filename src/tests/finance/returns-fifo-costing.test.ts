import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Phase 3 of the Sales/POS Return work: inventory-COST reversal. Phase 1
// (refund/discount/GST calculation, sales.service.ts createReturnOrder) and
// Phase 2 (refund Payment/ledger/Day-Closing wiring, recordRefund) are
// already correct and untouched by this phase — this suite only exercises
// the NEW cost-reversal machinery:
//   - sales.service.ts: _lockOriginalDocumentForReturn,
//     _resolveReturnProvenanceRefs, _resolveInventoryItemForReturnLine,
//     _computeReturnFifoAllocation (createReturnOrder time — computed once)
//   - sales.service.ts: restoreStockForReturnOrder (idempotency guard +
//     InventoryService.restoreToBatches for Case A/B, SALES_RETURN_IN
//     movementType for both A/B and the Case C fallback)
//   - inventory.service.ts: InventoryService.restoreToBatches (new)
//   - prisma/schema.prisma: StockMovementType.SALES_RETURN_IN,
//     ReturnItem.costAllocation/costReversal/costProvenance
const closeEnough = (a: number | null | undefined, b: number | null | undefined, tol = 0.01) => Math.abs((a ?? NaN) - (b ?? NaN)) <= tol;

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING RETURNS FIFO-COSTING SUITE (Phase 3)');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();
  const suffix = Date.now();

  const createdInventoryItemIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdSalesOrderIds: string[] = [];
  const createdChallanIds: string[] = [];
  const createdFranchiseOrderIds: string[] = [];
  const createdReturnIds: string[] = [];
  const createdFranchiseIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAccountIds: string[] = [];
  const createdPaymentIds: string[] = [];
  const createdRecallIds: string[] = [];

  let failures = 0;
  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) {
      console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
    } else {
      console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`);
      failures++;
    }
  };

  // ── Fixture helpers ──────────────────────────────────────────────────
  let skuCounter = 0;
  async function makeItemAndProduct(name: string, franchiseId: string | null = null) {
    skuCounter++;
    const sku = `P3-${suffix}-${skuCounter}`;
    const invItem = await prisma.inventoryItem.create({
      data: {
        name: `${name} ${suffix}-${skuCounter}`, sku, category: 'FINISHED_GOOD',
        currentStock: 0, unit: 'PC', costPrice: 0,
        customerPrice: 50, dealerPrice: 45, franchisePrice: 40, basePrice: 50,
        gstRate: 5, franchiseId,
      }
    });
    createdInventoryItemIds.push(invItem.id);
    const product = await prisma.product.create({
      data: {
        name: invItem.name, sku, productType: 'FINISHED_GOOD', category: 'FINISHED_GOOD',
        basePrice: 50, taxPercent: 5, isActive: true, is_menu_item: false,
      }
    });
    createdProductIds.push(product.id);
    return { invItem, product };
  }

  async function receiveBatch(itemId: string, qty: number, unitCost: number, batchNumber?: string) {
    const { fifo, item } = await InventoryService.recordMovement(prisma, {
      itemId, type: 'PURCHASE_IN', quantity: qty,
      receiveAtCost: { unitCost, batchNumber: batchNumber || `P3-LOT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
    const batch = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: itemId, unitCost }, orderBy: { createdAt: 'desc' } });
    return { batch, item, fifo };
  }

  async function sellFifo(itemId: string, qty: number, referenceType: string, referenceId: string) {
    return InventoryService.recordMovement(prisma, {
      itemId, type: 'SALES_OUT', quantity: -qty, referenceType, referenceId, note: 'Simulated sale (Phase 3 test)',
    });
  }

  async function makePosOrder(productId: string, quantity: number, rate: number, franchiseId: string = hq.id, customerId?: string) {
    const order = await prisma.order.create({
      data: {
        invoiceNum: `P3-INV-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
        franchiseId, customerId: customerId || null, partyType: customerId ? 'CUSTOMER' : undefined,
        subTotal: rate * quantity, taxAmount: 0, discountAmount: 0, totalAmount: rate * quantity,
        status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId, quantity, price: rate, discountPct: 0, taxAmount: 0, totalAmount: rate * quantity }] }
      }
    });
    createdOrderIds.push(order.id);
    return order;
  }

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    const step = async (label: string, fn: () => Promise<any>) => {
      try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
    };
    await step('payment', () => prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } }));
    await step('returnItem', () => prisma.returnItem.deleteMany({ where: { returnId: { in: createdReturnIds } } }));
    await step('returnOrder', () => prisma.returnOrder.deleteMany({ where: { id: { in: createdReturnIds } } }));
    await step('batchRecallEvent', () => prisma.batchRecallEvent.deleteMany({ where: { recallId: { in: createdRecallIds } } }));
    await step('batchRecall', () => prisma.batchRecall.deleteMany({ where: { id: { in: createdRecallIds } } }));
    await step('deliveryChallanItem', () => prisma.deliveryChallanItem.deleteMany({ where: { challanId: { in: createdChallanIds } } }));
    await step('deliveryChallan', () => prisma.deliveryChallan.deleteMany({ where: { id: { in: createdChallanIds } } }));
    await step('salesOrderItem', () => prisma.salesOrderItem.deleteMany({ where: { salesOrderId: { in: createdSalesOrderIds } } }));
    await step('salesOrder', () => prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } }));
    await step('franchiseOrderItem', () => prisma.franchiseOrderItem.deleteMany({ where: { orderId: { in: createdFranchiseOrderIds } } }));
    await step('franchiseOrder', () => prisma.franchiseOrder.deleteMany({ where: { id: { in: createdFranchiseOrderIds } } }));
    await step('orderItem', () => prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }));
    await step('order', () => prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }));
    await step('stockMovement (by item)', () => prisma.stockMovement.deleteMany({ where: { itemId: { in: createdInventoryItemIds } } }));
    await step('inventoryBatch', () => prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: createdInventoryItemIds } } }));
    await step('product', () => prisma.product.deleteMany({ where: { id: { in: createdProductIds } } }));
    await step('inventoryItem', () => prisma.inventoryItem.deleteMany({ where: { id: { in: createdInventoryItemIds } } }));
    await step('customerLedger', () => prisma.customerLedger.deleteMany({ where: { customerId: { in: createdCustomerIds } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } }));
    await step('account', () => prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } }));
    await step('franchise', () => prisma.franchise.deleteMany({ where: { id: { in: createdFranchiseIds } } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  };

  try {
    // ── Test 1: single-layer sale, partial return ────────────────────────
    console.log('--- 1. Single-layer sale (10 @ ₹20), sell 5, return 2 → cost reversal ₹40, same batch +2, movementType SALES_RETURN_IN ---');
    {
      const { invItem, product } = await makeItemAndProduct('SingleLayer');
      const { batch } = await receiveBatch(invItem.id, 10, 20);
      const order = await makePosOrder(product.id, 5, 30);
      await sellFifo(invItem.id, 5, 'ORDER', order.id);
      const batchAfterSale = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('Batch depleted to 5 after sale', batchAfterSale.currentQty === 5, `got ${batchAfterSale.currentQty}`);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Test 1', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 999 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('costProvenance EXACT', ri.costProvenance === 'EXACT', `got ${ri.costProvenance}`);
      check('costReversal = 40', closeEnough(ri.costReversal, 40), `got ${ri.costReversal}`);
      const alloc = ri.costAllocation as any[];
      check('allocation is single-layer [{batchId, qty:2, unitCost:20}]', alloc.length === 1 && alloc[0].batchId === batch!.id && alloc[0].qty === 2 && alloc[0].unitCost === 20, JSON.stringify(alloc));

      const batchAfterReturn = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('SAME batch incremented by 2 (5 -> 7)', batchAfterReturn.currentQty === 7, `got ${batchAfterReturn.currentQty}`);

      const restockMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'SALES_RETURN', referenceId: ret.id } });
      check('movementType is SALES_RETURN_IN (not PURCHASE_IN)', restockMv.movementType === 'SALES_RETURN_IN', `got ${restockMv.movementType}`);
      check('restock movement batchId points at the SAME original batch', restockMv.batchId === batch!.id);

      // ── Test 20 (piggybacks on this return): GST/refund separation ──────
      console.log('--- 20. GST/refund separation: Phase 1 fields present and numerically independent of Phase 3 cost fields ---');
      check('refundAmount is a real Phase 1 number, independent of costReversal', typeof ret.refundAmount === 'number' && ret.refundAmount !== ri.costReversal, `refundAmount=${ret.refundAmount}, costReversal=${ri.costReversal}`);
      check('taxableValue/taxAmount present (Phase 1) alongside costReversal (Phase 3) on the same ReturnItem row', ri.taxableValue != null && ri.taxAmount != null && ri.costReversal != null);

      // ── Test 19: forged client cost fields ignored ──────────────────────
      console.log('--- 19. Forged client cost fields in the request body have zero effect on the computed allocation ---');
      await sellFifo(invItem.id, 1, 'ORDER', order.id); // shrink returnable window isn't needed; use a fresh small return
      const forgedRet = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Test 19 forged cost', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 1, rate: 999, unitCost: 999999, totalCost: 99999999 } as any]
      } as any);
      createdReturnIds.push(forgedRet.id);
      const forgedRi = forgedRet.items[0];
      check('Forged unitCost/totalCost in request body ignored — real allocation still ₹20/unit', closeEnough(forgedRi.costReversal, 20), `got ${forgedRi.costReversal}`);
      const forgedAlloc = forgedRi.costAllocation as any[];
      check('Forged batchId never leaks into persisted allocation', forgedAlloc.every(a => a.unitCost === 20 && a.batchId === batch!.id));
    }

    // ── Test 2: multi-layer sale ──────────────────────────────────────────
    console.log('\n--- 2. Multi-layer sale: 5@₹20 + 5@₹30, sell 8, return 3 ---');
    {
      const { invItem, product } = await makeItemAndProduct('MultiLayer');
      const { batch: batch1 } = await receiveBatch(invItem.id, 5, 20, `P3-B1-${suffix}`);
      const { batch: batch2 } = await receiveBatch(invItem.id, 5, 30, `P3-B2-${suffix}`);
      const order = await makePosOrder(product.id, 8, 40);
      const saleResult = await sellFifo(invItem.id, 8, 'ORDER', order.id);
      const saleCogs = saleResult.fifo!.totalCost;
      // 5 units @20 (batch1 fully) + 3 units @30 (batch2 partial) = 100 + 90 = 190.
      check('Original sale COGS = ₹190 (5x20 + 3x30)', closeEnough(saleCogs, 190), `got ${saleCogs}`);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Test 2', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 3, rate: 40 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      // Design steps 1-5: with zero prior returns, allocation starts from the
      // FIRST (oldest, FIRST-consumed-in-the-sale) layer in the replayed
      // list — batch1 @ ₹20 — not the layer consumed LAST. Returning 3 units
      // takes all 3 from batch1 @ ₹20 = ₹60.
      check('costReversal = ₹60 (3 units from batch1 @ ₹20, the FIRST layer in FIFO consumption order)', closeEnough(ri.costReversal, 60), `got ${ri.costReversal}`);
      const alloc = ri.costAllocation as any[];
      check('Allocation draws entirely from batch1 (oldest layer), not batch2', alloc.length === 1 && alloc[0].batchId === batch1!.id && alloc[0].qty === 3 && alloc[0].unitCost === 20, JSON.stringify(alloc));
    }

    // ── Test 3 & 14: sequential partial returns spanning layers, disjoint ─
    console.log('\n--- 3/14. Sequential partial returns (3, 4, 3) on a 10-unit mixed-layer sale — disjoint, sums to full COGS ---');
    {
      const { invItem, product } = await makeItemAndProduct('Sequential');
      const { batch: b1 } = await receiveBatch(invItem.id, 4, 10, `P3-SEQ1-${suffix}`);
      const { batch: b2 } = await receiveBatch(invItem.id, 6, 15, `P3-SEQ2-${suffix}`);
      const order = await makePosOrder(product.id, 10, 25);
      const saleResult = await sellFifo(invItem.id, 10, 'ORDER', order.id);
      const totalCogs = saleResult.fifo!.totalCost; // 4*10 + 6*15 = 40+90 = 130
      check('Original sale COGS = ₹130', closeEnough(totalCogs, 130));

      const r1 = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Seq return 1', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 3, rate: 25 }]
      } as any);
      createdReturnIds.push(r1.id);
      const r2 = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Seq return 2', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 4, rate: 25 }]
      } as any);
      createdReturnIds.push(r2.id);
      const r3 = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Seq return 3', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 3, rate: 25 }]
      } as any);
      createdReturnIds.push(r3.id);

      const cost1 = r1.items[0].costReversal ?? 0, cost2 = r2.items[0].costReversal ?? 0, cost3 = r3.items[0].costReversal ?? 0;
      console.log(`   Return costs: r1=₹${cost1}, r2=₹${cost2}, r3=₹${cost3}`);
      check('r1 (3 units) = ₹30 (all from batch1 @₹10)', closeEnough(cost1, 30), `got ${cost1}`);
      check('r2 (4 units) = ₹55 (1 unit @₹10 finishing batch1 + 3 units @₹15 from batch2)', closeEnough(cost2, 55), `got ${cost2}`);
      check('r3 (3 units) = ₹45 (3 units @₹15 from batch2)', closeEnough(cost3, 45), `got ${cost3}`);
      check('Sum of all 3 sequential returns = full original COGS ₹130 exactly', closeEnough(cost1 + cost2 + cost3, 130), `sum=${cost1 + cost2 + cost3}`);

      // Disjointness: total units allocated to batch1 across all 3 returns
      // must equal batch1's own consumed qty (4), same for batch2 (6).
      const allAllocations = [...(r1.items[0].costAllocation as any[]), ...(r2.items[0].costAllocation as any[]), ...(r3.items[0].costAllocation as any[])];
      const b1Qty = allAllocations.filter(a => a.batchId === b1!.id).reduce((s, a) => s + a.qty, 0);
      const b2Qty = allAllocations.filter(a => a.batchId === b2!.id).reduce((s, a) => s + a.qty, 0);
      check('No double-counting: batch1 allocated exactly 4 units total across all returns', b1Qty === 4, `got ${b1Qty}`);
      check('No double-counting: batch2 allocated exactly 6 units total across all returns', b2Qty === 6, `got ${b2Qty}`);

      // Test 14 lives here too: a single line crossing multiple layers is
      // exactly what r2 demonstrates (1 unit from batch1 + 3 from batch2).
      const r2Alloc = r2.items[0].costAllocation as any[];
      check('Test 14: r2 (a single return line) spans BOTH layers with the right split (1@10 + 3@15)',
        r2Alloc.length === 2
        && r2Alloc.some(a => a.batchId === b1!.id && a.qty === 1 && a.unitCost === 10)
        && r2Alloc.some(a => a.batchId === b2!.id && a.qty === 3 && a.unitCost === 15),
        JSON.stringify(r2Alloc));
    }

    // ── Test 4: over-return guard still intact ────────────────────────────
    console.log('\n--- 4. Over-return guard: sale of 10, attempt to return 11 total → must fail ---');
    {
      const { invItem, product } = await makeItemAndProduct('OverReturn');
      await receiveBatch(invItem.id, 10, 15, `P3-OVR-${suffix}`);
      const order = await makePosOrder(product.id, 10, 20);
      await sellFifo(invItem.id, 10, 'ORDER', order.id);

      const r1 = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Partial 1', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 6, rate: 20 }]
      } as any);
      createdReturnIds.push(r1.id);

      let threw = false;
      try {
        const r2 = await SalesService.createReturnOrder({
          posOrderId: order.id, reason: 'Over return', status: 'APPROVED',
          items: [{ productId: product.id, productName: product.name, quantity: 5, rate: 20 }] // 6 + 5 = 11 > 10
        } as any);
        createdReturnIds.push(r2.id);
      } catch (e: any) {
        threw = true;
        console.log(`   Rejected with: "${e.message}"`);
      }
      check('Over-return (6 already + 5 more = 11 > 10 sold) was rejected', threw);
    }

    // ── Test 5: concurrent partial returns ────────────────────────────────
    console.log('\n--- 5. Concurrent returns: fire 7 and 5 simultaneously against a sale of 10 ---');
    {
      const { invItem, product } = await makeItemAndProduct('Concurrent');
      await receiveBatch(invItem.id, 10, 12, `P3-CONC-${suffix}`);
      const order = await makePosOrder(product.id, 10, 20);
      await sellFifo(invItem.id, 10, 'ORDER', order.id);

      const results = await Promise.allSettled([
        SalesService.createReturnOrder({
          posOrderId: order.id, reason: 'Concurrent A (7)', status: 'APPROVED',
          items: [{ productId: product.id, productName: product.name, quantity: 7, rate: 20 }]
        } as any),
        SalesService.createReturnOrder({
          posOrderId: order.id, reason: 'Concurrent B (5)', status: 'APPROVED',
          items: [{ productId: product.id, productName: product.name, quantity: 5, rate: 20 }]
        } as any),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      for (const f of fulfilled) createdReturnIds.push(f.value.id);
      console.log(`   Outcome: ${fulfilled.length} fulfilled, ${rejected.length} rejected`);
      if (rejected.length) console.log(`   Rejection reason: ${rejected[0].reason?.message}`);

      check('Exactly one of the two concurrent 7+5 requests succeeded (12 > 10 sold, cannot both fit)', fulfilled.length === 1 && rejected.length === 1, `fulfilled=${fulfilled.length}, rejected=${rejected.length}`);

      const totalReturnedQty = await prisma.returnItem.aggregate({
        _sum: { quantity: true },
        where: { returnId: { in: fulfilled.map(f => f.value.id) } }
      });
      const returnedQty = totalReturnedQty._sum.quantity || 0;
      check('Total successfully-returned quantity never exceeds 10', returnedQty <= 10, `got ${returnedQty}`);

      const batchAfter = await prisma.inventoryBatch.findFirstOrThrow({ where: { inventoryItemId: invItem.id } });
      check('Batch currentQty reflects exactly one restock, no double-allocation', batchAfter.currentQty === returnedQty, `batch currentQty=${batchAfter.currentQty}, returnedQty=${returnedQty}`);
    }

    // ── Test 6: duplicate restoration is idempotent ───────────────────────
    console.log('\n--- 6. Duplicate approval/completion: restoreStockForReturnOrder called twice must not double-restore ---');
    {
      const { invItem, product } = await makeItemAndProduct('DupRestore');
      const { batch } = await receiveBatch(invItem.id, 10, 18, `P3-DUP-${suffix}`);
      const order = await makePosOrder(product.id, 6, 25);
      await sellFifo(invItem.id, 6, 'ORDER', order.id);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Dup restore test',
        items: [{ productId: product.id, productName: product.name, quantity: 4, rate: 25 }]
      } as any); // PENDING — not yet restored
      createdReturnIds.push(ret.id);

      const fetched = await prisma.returnOrder.findUniqueOrThrow({
        where: { id: ret.id },
        include: { items: true, posOrder: { select: { franchiseId: true } } }
      });

      await prisma.$transaction(tx => SalesService.restoreStockForReturnOrder(tx, fetched, 'tester-1'));
      const afterFirst = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      // First call: sale drained batch to 6 (10-4... wait sale was 6 units,
      // so batch went 10 -> 4), first restore returns 4 units back -> 8.
      check('First restore call increments stock as expected', afterFirst.currentQty === 8, `got ${afterFirst.currentQty}`);

      // Call again with the SAME (now-stale) fetched object — simulates a
      // retried/duplicate approval invocation.
      await prisma.$transaction(tx => SalesService.restoreStockForReturnOrder(tx, fetched, 'tester-2'));
      const afterSecond = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('Second (duplicate) restore call is a no-op — stock unchanged', afterSecond.currentQty === 8, `got ${afterSecond.currentQty}`);

      const restockMovements = await prisma.stockMovement.count({ where: { referenceType: 'SALES_RETURN', referenceId: ret.id } });
      check('Exactly ONE restock StockMovement exists, not two', restockMovements === 1, `got ${restockMovements}`);
    }

    // ── Test 7/8/9: historical immutability ───────────────────────────────
    console.log('\n--- 7/8/9. Historical immutability: Product Master price, InventoryItem.costPrice, and a new later purchase batch must not affect the return\'s cost ---');
    {
      const { invItem, product } = await makeItemAndProduct('Immutable');
      const { batch } = await receiveBatch(invItem.id, 10, 22, `P3-IMMUT-${suffix}`);
      const order = await makePosOrder(product.id, 4, 30);
      await sellFifo(invItem.id, 4, 'ORDER', order.id);

      // Mutate everything that must NOT influence the return's cost.
      await prisma.product.update({ where: { id: product.id }, data: { basePrice: 999 } });
      await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { costPrice: 500, customerPrice: 999, dealerPrice: 999, franchisePrice: 999, basePrice: 999 } });
      await receiveBatch(invItem.id, 10, 999, `P3-NEWPRICEY-${suffix}`); // a new, much pricier batch received AFTER the sale

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Immutability test', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 999 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Cost reversal still uses the ORIGINAL ₹22/unit, unaffected by Product Master price changes (test 7)', closeEnough(ri.costReversal, 44), `got ${ri.costReversal}`);
      check('Cost reversal unaffected by InventoryItem.costPrice change to ₹500 (test 8)', closeEnough(ri.costReversal, 44));
      const alloc = ri.costAllocation as any[];
      check('Cost reversal draws from the OLD batch (₹22), never the new ₹999 batch received after the sale (test 9)', alloc.every(a => a.unitCost === 22 && a.batchId === batch!.id), JSON.stringify(alloc));
    }

    // ── Test 10/11: franchise vs HQ scope ─────────────────────────────────
    console.log('\n--- 10/11. Franchise-scoped vs HQ-scoped returns land in the correct inventory scope ---');
    {
      const franchise = await prisma.franchise.create({
        data: { name: `P3 Franchise ${suffix}`, isHQ: false, location: 'Test', ownerName: 'Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}` }
      });
      createdFranchiseIds.push(franchise.id);

      // 10. Franchise-scoped: item+sale+return all at the SAME non-HQ franchise.
      const { invItem: fItem, product: fProduct } = await makeItemAndProduct('FranchiseScoped', franchise.id);
      await receiveBatch(fItem.id, 10, 14, `P3-FRAN-${suffix}`);
      const fOrder = await makePosOrder(fProduct.id, 4, 20, franchise.id);
      await sellFifo(fItem.id, 4, 'ORDER', fOrder.id);
      const fRet = await SalesService.createReturnOrder({
        posOrderId: fOrder.id, reason: 'Franchise scope test', status: 'APPROVED',
        items: [{ productId: fProduct.id, productName: fProduct.name, quantity: 2, rate: 20 }]
      } as any);
      createdReturnIds.push(fRet.id);
      check('Franchise-scoped return: cost reversal correct (EXACT, ₹28)', fRet.items[0].costProvenance === 'EXACT' && closeEnough(fRet.items[0].costReversal, 28), `provenance=${fRet.items[0].costProvenance}, cost=${fRet.items[0].costReversal}`);
      const fItemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: fItem.id } });
      check('Restored stock landed on the FRANCHISE item (franchiseId set), not HQ', fItemAfter.franchiseId === franchise.id, `got ${fItemAfter.franchiseId}`);
      const hqSameSkuAfter = await prisma.inventoryItem.findFirst({ where: { sku: fItem.sku, franchiseId: null } });
      check('No stray HQ (franchiseId:null) item was created/credited for this SKU', !hqSameSkuAfter);

      // 11. HQ-scoped: item+sale+return all at HQ (franchiseId: null).
      const { invItem: hItem, product: hProduct } = await makeItemAndProduct('HqScoped', null);
      await receiveBatch(hItem.id, 10, 14, `P3-HQ-${suffix}`);
      const hOrder = await makePosOrder(hProduct.id, 4, 20, hq.id);
      await sellFifo(hItem.id, 4, 'ORDER', hOrder.id);
      const hRet = await SalesService.createReturnOrder({
        posOrderId: hOrder.id, reason: 'HQ scope test', status: 'APPROVED',
        items: [{ productId: hProduct.id, productName: hProduct.name, quantity: 2, rate: 20 }]
      } as any);
      createdReturnIds.push(hRet.id);
      const hItemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: hItem.id } });
      check('HQ-scoped return: restored stock stays at franchiseId: null (HQ)', hItemAfter.franchiseId === null, `got ${hItemAfter.franchiseId}`);
    }

    // ── Test 12: recall-affected return ───────────────────────────────────
    console.log('\n--- 12. Recall-affected return: quarantined regardless of Case A/B/C classification ---');
    {
      const { RecallService } = require('../../modules/production/recall.service');
      const franchise = await prisma.franchise.create({
        data: { name: `P3 Recall Franchise ${suffix}`, isHQ: false, location: 'Test', ownerName: 'Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}` }
      });
      createdFranchiseIds.push(franchise.id);
      const { invItem, product } = await makeItemAndProduct('RecallReturn', franchise.id);
      const { batch } = await receiveBatch(invItem.id, 10, 16, `P3-RECALL-${suffix}`);
      // Tag the batch with a ProductBatch so RecallService has something to key off — mirrors production flow minimally.
      const productBatch = await prisma.productBatch.create({ data: { productId: product.id, franchiseId: franchise.id, quantity: 10, batchCode: `P3-PB-${suffix}`, qcStatus: 'APPROVED', approvedQty: 10 } });
      await prisma.inventoryBatch.update({ where: { id: batch!.id }, data: { productBatchId: productBatch.id } });

      const order = await makePosOrder(product.id, 5, 25, franchise.id);
      await sellFifo(invItem.id, 5, 'ORDER', order.id);

      const recall = await RecallService.initiateRecall(productBatch.id, { reason: 'Contamination' });
      createdRecallIds.push(recall.id);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Recall-affected return', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 25, condition: 'GOOD' }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Return line has a real Phase 3 cost allocation computed regardless of the recall', ri.costProvenance === 'EXACT', `costProvenance=${ri.costProvenance}`);
      // recallId is written via a DB update inside restoreStockForReturnOrder
      // AFTER createReturnOrder's own `returnOrder` object was already
      // constructed — re-fetch from the DB rather than trusting the
      // in-memory `ret.items[0]` snapshot (same pattern the existing
      // customer-return-recall-quarantine.script.ts regression uses).
      const riFromDb = await prisma.returnItem.findUniqueOrThrow({ where: { id: ri.id } });
      check('Return item IS recall-flagged despite condition GOOD', !!riFromDb.recallId, `recallId=${riFromDb.recallId}`);

      const restockMv = await prisma.stockMovement.findFirst({ where: { referenceType: 'SALES_RETURN', referenceId: ret.id } });
      check('NO SALES_RETURN_IN movement was written for the quarantined line (recall takes priority)', !restockMv, `found=${!!restockMv}`);
      const quarantineBatch = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: invItem.id, status: 'RETURNED', currentQty: 2 } });
      check('Stock was quarantined (InventoryBatch.status RETURNED), never saleable', !!quarantineBatch, `found=${!!quarantineBatch}`);
      const recallMv = await prisma.stockMovement.findFirst({ where: { movementType: 'RECALL_RETURN_IN', itemId: invItem.id } });
      check('The actual movement recorded is RECALL_RETURN_IN (the existing, untouched recall path)', !!recallMv);
    }

    // ── Test 13: multi-line return, independent cost histories ───────────
    console.log('\n--- 13. Multi-line return: two products, independently-computed cost reversal ---');
    {
      const { invItem: itemX, product: productX } = await makeItemAndProduct('MultiLineX');
      await receiveBatch(itemX.id, 10, 11, `P3-MLX-${suffix}`);
      const { invItem: itemY, product: productY } = await makeItemAndProduct('MultiLineY');
      await receiveBatch(itemY.id, 10, 33, `P3-MLY-${suffix}`);

      const order = await prisma.order.create({
        data: {
          invoiceNum: `P3-INV-ML-${suffix}`, franchiseId: hq.id, subTotal: 100, taxAmount: 0, discountAmount: 0, totalAmount: 100,
          status: 'COMPLETED', paymentStatus: 'PAID',
          orderItems: { create: [
            { productId: productX.id, quantity: 5, price: 20, discountPct: 0, taxAmount: 0, totalAmount: 100 },
            { productId: productY.id, quantity: 5, price: 40, discountPct: 0, taxAmount: 0, totalAmount: 200 },
          ] }
        }
      });
      createdOrderIds.push(order.id);
      await sellFifo(itemX.id, 5, 'ORDER', order.id);
      await sellFifo(itemY.id, 5, 'ORDER', order.id);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Multi-line test', status: 'APPROVED',
        items: [
          { productId: productX.id, productName: productX.name, quantity: 2, rate: 20 },
          { productId: productY.id, productName: productY.name, quantity: 3, rate: 40 },
        ]
      } as any);
      createdReturnIds.push(ret.id);
      const riX = ret.items.find((i: any) => i.productId === productX.id)!;
      const riY = ret.items.find((i: any) => i.productId === productY.id)!;
      check('Line X cost reversal correct (2 x ₹11 = ₹22)', closeEnough(riX.costReversal, 22), `got ${riX.costReversal}`);
      check('Line Y cost reversal correct (3 x ₹33 = ₹99), independent of line X', closeEnough(riY.costReversal, 99), `got ${riY.costReversal}`);
    }

    // ── Test 15 (explicit): POS-sourced Case A ───────────────────────────
    console.log('\n--- 15. POS-sourced sale (referenceType ORDER) → exact cost reversal (explicit, mirrors test 1) ---');
    {
      const { invItem, product } = await makeItemAndProduct('PosExplicit');
      await receiveBatch(invItem.id, 10, 19, `P3-POS-${suffix}`);
      const order = await makePosOrder(product.id, 5, 25);
      await sellFifo(invItem.id, 5, 'ORDER', order.id);
      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'POS explicit', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 3, rate: 25 }]
      } as any);
      createdReturnIds.push(ret.id);
      check('POS-sourced return is Case A (EXACT) via referenceType ORDER', ret.items[0].costProvenance === 'EXACT' && closeEnough(ret.items[0].costReversal, 57), `provenance=${ret.items[0].costProvenance}, cost=${ret.items[0].costReversal}`);
    }

    // ── Test 16: Delivery-Challan-dispatched sale ─────────────────────────
    console.log('\n--- 16. Delivery-Challan-dispatched sale (referenceType DELIVERY_CHALLAN, movementType PRODUCTION_OUT on original) → exact cost reversal ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcDispatch', null); // HQ scope, matches dispatchChallanStock's raw hq.id convention
      // dispatchChallanStock looks up InventoryItem by { franchiseId: sourceId, sku } where
      // sourceId defaults to HQ's RAW id (not null) — align the fixture item to that exact convention.
      await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { franchiseId: hq.id } });
      await receiveBatch(invItem.id, 10, 27, `P3-DC-${suffix}`);

      const customer = await prisma.customer.create({ data: { name: `P3 DC Customer ${suffix}`, franchiseId: hq.id } });
      createdCustomerIds.push(customer.id);
      const so = await SalesService.createSalesOrder({
        customerId: customer.id,
        items: [{ productId: product.id, productName: product.name, quantity: 6, rate: 25, taxPercent: 0 }]
      } as any);
      createdSalesOrderIds.push(so.id);

      const challan = await SalesService.createDeliveryChallan({
        customerId: customer.id, salesOrderId: so.id, sourceFranchiseId: hq.id, status: 'IN_TRANSIT', deductStockOnDispatch: true,
        items: [{ productId: product.id, productName: product.name, quantity: 6, rate: 25, taxPercent: 0 }]
      } as any, 'tester');
      createdChallanIds.push(challan.id);

      const dispatchMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'DELIVERY_CHALLAN', referenceId: challan.id, itemId: invItem.id } });
      check('Original dispatch movementType is PRODUCTION_OUT (the known pre-existing labeling quirk, out of scope)', dispatchMv.movementType === 'PRODUCTION_OUT', `got ${dispatchMv.movementType}`);

      const ret = await SalesService.createReturnOrder({
        salesOrderId: so.id, reason: 'DC dispatch return', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 25 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('DC-dispatched sale return classified Case A (EXACT) despite movementType PRODUCTION_OUT — lookup is NOT filtering by movementType', ri.costProvenance === 'EXACT', `got ${ri.costProvenance}`);
      check('Cost reversal correct (2 x ₹27 = ₹54)', closeEnough(ri.costReversal, 54), `got ${ri.costReversal}`);
    }

    // ── Test 17: Franchise-order (HQ→Franchise transfer) return ───────────
    console.log('\n--- 17. Franchise-order (HQ→Franchise transfer) return via referenceType FRANCHISE_ORDER ---');
    {
      const franchise = await prisma.franchise.create({
        data: { name: `P3 FO Franchise ${suffix}`, isHQ: false, location: 'Test', ownerName: 'Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}` }
      });
      createdFranchiseIds.push(franchise.id);
      const { product } = await makeItemAndProduct('FoTransferHqSide', null);
      // Franchise's own receiving InventoryItem (what TRANSFER_IN targets).
      const franchiseItem = await prisma.inventoryItem.create({
        data: { name: `FO Transfer Franchise Side ${suffix}`, sku: `P3-FO-FRANCH-${suffix}`, category: 'FINISHED_GOOD', currentStock: 0, unit: 'PC', costPrice: 0, franchiseId: franchise.id }
      });
      createdInventoryItemIds.push(franchiseItem.id);
      // A distinct Product entry matching the FRANCHISE item's own SKU, since
      // restoreStockForReturnOrder/provenance lookup resolve by product.sku.
      await prisma.product.update({ where: { id: product.id }, data: { sku: franchiseItem.sku } });

      const fo = await prisma.franchiseOrder.create({
        data: {
          orderNumber: `P3-FO-${suffix}`, franchiseId: franchise.id, totalAmount: 150,
          items: { create: [{ productId: product.id, quantity: 6, unitPrice: 25, totalAmount: 150 }] }
        }
      });
      createdFranchiseOrderIds.push(fo.id);

      // Simulate the TRANSFER_IN receipt exactly as franchise-order.service.ts does.
      const { fifo } = await InventoryService.recordMovement(prisma, {
        itemId: franchiseItem.id, type: 'TRANSFER_IN', quantity: 6,
        referenceType: 'FRANCHISE_ORDER', referenceId: fo.id,
        receiveAtCost: { unitCost: 25, batchNumber: `P3-FO-LOT-${suffix}` },
      });
      const transferBatch = await prisma.inventoryBatch.findFirstOrThrow({ where: { inventoryItemId: franchiseItem.id } });

      const ret = await SalesService.createReturnOrder({
        franchiseOrderId: fo.id, reason: 'Franchise order return', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 25 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Franchise-order return classified Case A (EXACT) via referenceType FRANCHISE_ORDER', ri.costProvenance === 'EXACT', `got ${ri.costProvenance}`);
      check('Cost reversal correct (2 x ₹25 = ₹50)', closeEnough(ri.costReversal, 50), `got ${ri.costReversal}`);
      const batchAfter = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: transferBatch.id } });
      // This fixture never "sells" the transferred stock back out again — it
      // goes straight from a 6-unit TRANSFER_IN receipt to a 2-unit return,
      // so the SAME batch should now read 6 + 2 = 8 (not a deplete-then-
      // restore round trip, unlike tests 1/6 which do sell first).
      check('Restored into the SAME original TRANSFER_IN batch (6 -> 8)', batchAfter.currentQty === 8, `got ${batchAfter.currentQty}`);
    }

    // ── Test 18: Group-B fallback (no real inventory deduction at all) ────
    console.log('\n--- 18. Group-B fallback: a Quotation/SalesOrder/Proforma-converted Order with no matching StockMovement → Case C ---');
    {
      const { invItem, product } = await makeItemAndProduct('GroupBFallback');
      // NOTE: deliberately NO receiveBatch/sellFifo call — this Order mimics
      // convertQuotationToSale/convertSalesOrderToSale/convertProformaToInvoice,
      // which set inventory_deducted:true but call zero inventory functions.
      const order = await prisma.order.create({
        data: {
          invoiceNum: `P3-GRPB-${suffix}`, franchiseId: hq.id, orderType: 'TAX_INVOICE', status: 'COMPLETED',
          subTotal: 100, taxAmount: 0, discountAmount: 0, totalAmount: 100, paymentStatus: 'PAID',
          inventory_deducted: true,
          orderItems: { create: [{ productId: product.id, quantity: 5, price: 20, discountPct: 0, taxAmount: 0, totalAmount: 100 }] }
        }
      });
      createdOrderIds.push(order.id);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Group B fallback test', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 20 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Classified Case C: costProvenance PROVENANCE_UNAVAILABLE', ri.costProvenance === 'PROVENANCE_UNAVAILABLE', `got ${ri.costProvenance}`);
      check('No fabricated costAllocation/costReversal written', ri.costAllocation === null && ri.costReversal === null, `costAllocation=${JSON.stringify(ri.costAllocation)}, costReversal=${ri.costReversal}`);
      const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
      check('Physical quantity STILL restored via the existing (unrelated) stock logic', itemAfter.currentStock === 2, `got ${itemAfter.currentStock}`);
      const restockMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'SALES_RETURN', referenceId: ret.id } });
      check('Restock still uses SALES_RETURN_IN (relabeled from PURCHASE_IN) even in the Case C fallback', restockMv.movementType === 'SALES_RETURN_IN', `got ${restockMv.movementType}`);
    }

    // ── Test 21: Phase 2 separation (refund Payment vs Phase 3 cost) ──────
    console.log('\n--- 21. Phase 2 separation: refund Payment amount and Phase 3 cost-reversal amount are independent, from independent paths ---');
    {
      const { invItem, product } = await makeItemAndProduct('Phase2Separation');
      await receiveBatch(invItem.id, 10, 17, `P3-P2SEP-${suffix}`);
      const customer = await prisma.customer.create({ data: { name: `P3 Phase2 Customer ${suffix}`, franchiseId: hq.id } });
      createdCustomerIds.push(customer.id);
      const account = await prisma.account.create({ data: { name: `P3 Phase2 Cash ${suffix}`, type: 'CASH', balance: 100000, franchiseId: hq.id } });
      createdAccountIds.push(account.id);

      const order = await makePosOrder(product.id, 4, 55, hq.id, customer.id);
      await sellFifo(invItem.id, 4, 'ORDER', order.id);

      const ret = await SalesService.createReturnOrder({
        posOrderId: order.id, reason: 'Phase 2 separation test', status: 'APPROVED',
        items: [{ productId: product.id, productName: product.name, quantity: 2, rate: 55 }]
      } as any);
      createdReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Return has a real Phase 3 cost reversal (2 x ₹17 = ₹34)', closeEnough(ri.costReversal, 34), `got ${ri.costReversal}`);
      check('Return has a real Phase 1 refund amount (2 x ₹55 = ₹110), a totally different number', closeEnough(ret.refundAmount, 110), `got ${ret.refundAmount}`);

      const refund = await SalesService.recordRefund(ret.id, { refundMethod: 'Cash Voucher', accountId: account.id, method: 'CASH', createdBy: 'tester' });
      createdPaymentIds.push(refund.payment.id);
      check('Phase 2 refund Payment.paidAmount = refundAmount (₹110), NOT the cost reversal (₹34)', closeEnough(refund.payment.paidAmount, 110), `got ${refund.payment.paidAmount}`);
      check('Phase 3 cost reversal (₹34) and Phase 2 refund (₹110) remain two distinct numbers on the same return', !closeEnough(ri.costReversal, refund.payment.paidAmount));
    }

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎉 ALL RETURNS FIFO-COSTING (PHASE 3) CHECKS PASSED');
    } else {
      console.error(`💥 ${failures} CHECK(S) FAILED`);
    }
    console.log('====================================================');
  } catch (e) {
    console.error('❌ Exception during Phase 3 FIFO costing suite:', e);
    failures++;
  } finally {
    await cleanup();
  }

  if (failures > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error('❌ Test failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
