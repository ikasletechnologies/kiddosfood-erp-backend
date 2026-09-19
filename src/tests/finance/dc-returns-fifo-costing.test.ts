import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Phase 3A: Delivery-Challan returns had a completely separate return model/
// flow (DeliveryChallanReturn/receiveDeliveryChallanReturn) that still had
// the exact bug Phase 3 fixed everywhere else — it restored returned "GOOD"
// stock into a brand-new batch at TODAY'S current InventoryItem.costPrice,
// labeled PURCHASE_IN, discarding the original dispatch's actual FIFO cost.
// This suite exercises the fix, which REUSES (never reimplements) the two
// Phase 3 generic helpers:
//   - SalesService._computeReturnFifoAllocation (unchanged signature/logic)
//   - InventoryService.restoreToBatches (unchanged)
// New in this phase:
//   - sales.service.ts: _lockDeliveryChallanForReturn (new, DC-specific lock
//     helper — does NOT touch _lockOriginalDocumentForReturn)
//   - sales.service.ts: createDeliveryChallanReturn (now transactional +
//     row-locked end-to-end, and computes FIFO allocation ONCE at create
//     time, persisted on DeliveryChallanReturnItem)
//   - sales.service.ts: receiveDeliveryChallanReturn (now row-locked before
//     the idempotency status check; GOOD-condition restore now reads the
//     persisted allocation and calls InventoryService.restoreToBatches with
//     movementType SALES_RETURN_IN instead of PURCHASE_IN)
//   - prisma/schema.prisma: DeliveryChallanReturnItem.costAllocation/
//     costReversal/costProvenance (additive, mirrors ReturnItem)
const closeEnough = (a: number | null | undefined, b: number | null | undefined, tol = 0.01) => Math.abs((a ?? NaN) - (b ?? NaN)) <= tol;

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING DC-RETURNS FIFO-COSTING SUITE (Phase 3A)');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();
  const suffix = Date.now();

  const createdInventoryItemIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdChallanIds: string[] = [];
  const createdDcReturnIds: string[] = [];
  const createdFranchiseIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdRecallIds: string[] = [];
  const createdProductBatchIds: string[] = [];

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
    const sku = `P3A-${suffix}-${skuCounter}`;
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
      receiveAtCost: { unitCost, batchNumber: batchNumber || `P3A-LOT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
    const batch = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: itemId, unitCost }, orderBy: { createdAt: 'desc' } });
    return { batch, item, fifo };
  }

  async function makeCustomer(name: string) {
    const customer = await prisma.customer.create({ data: { name: `${name} ${suffix}`, franchiseId: hq.id } });
    createdCustomerIds.push(customer.id);
    return customer;
  }

  // Dispatches a Delivery Challan (customer-bound, status IN_TRANSIT ->
  // triggers dispatchChallanStock immediately) sourced from `sourceFranchiseId`
  // (undefined -> defaults to HQ's own raw id, per dispatchChallanStock's
  // established convention).
  async function dispatchDc(customerId: string, productId: string, productName: string, quantity: number, sourceFranchiseId?: string) {
    const challan = await SalesService.createDeliveryChallan({
      customerId, sourceFranchiseId, status: 'IN_TRANSIT',
      items: [{ productId, productName, quantity, rate: 25, taxPercent: 0 }]
    } as any, 'tester');
    createdChallanIds.push(challan.id);
    return challan;
  }

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    const step = async (label: string, fn: () => Promise<any>) => {
      try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
    };
    await step('batchRecallEvent', () => prisma.batchRecallEvent.deleteMany({ where: { recallId: { in: createdRecallIds } } }));
    await step('batchRecall', () => prisma.batchRecall.deleteMany({ where: { id: { in: createdRecallIds } } }));
    await step('productBatch', () => prisma.productBatch.deleteMany({ where: { id: { in: createdProductBatchIds } } }));
    await step('deliveryChallanReturnItem', () => prisma.deliveryChallanReturnItem.deleteMany({ where: { returnId: { in: createdDcReturnIds } } }));
    await step('deliveryChallanReturn', () => prisma.deliveryChallanReturn.deleteMany({ where: { id: { in: createdDcReturnIds } } }));
    await step('deliveryChallanItem', () => prisma.deliveryChallanItem.deleteMany({ where: { challanId: { in: createdChallanIds } } }));
    await step('deliveryChallan', () => prisma.deliveryChallan.deleteMany({ where: { id: { in: createdChallanIds } } }));
    await step('stockMovement (by item)', () => prisma.stockMovement.deleteMany({ where: { itemId: { in: createdInventoryItemIds } } }));
    await step('inventoryBatch', () => prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: { in: createdInventoryItemIds } } }));
    await step('product', () => prisma.product.deleteMany({ where: { id: { in: createdProductIds } } }));
    await step('inventoryItem', () => prisma.inventoryItem.deleteMany({ where: { id: { in: createdInventoryItemIds } } }));
    await step('customerLedger', () => prisma.customerLedger.deleteMany({ where: { customerId: { in: createdCustomerIds } } }));
    await step('customer', () => prisma.customer.deleteMany({ where: { id: { in: createdCustomerIds } } }));
    await step('franchise', () => prisma.franchise.deleteMany({ where: { id: { in: createdFranchiseIds } } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  };

  try {
    // ── Test 1 & 14: single FIFO layer, partial return ────────────────────
    console.log('--- 1/14. Single-layer dispatch (10 @ ₹20), dispatch 5, return 2 → cost reversal ₹40, same batch, movementType SALES_RETURN_IN ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcSingle', hq.id);
      const { batch } = await receiveBatch(invItem.id, 10, 20);
      const customer = await makeCustomer('DcSingleCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 5, hq.id);
      const batchAfterDispatch = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('Batch depleted to 5 after dispatch', batchAfterDispatch.currentQty === 5, `got ${batchAfterDispatch.currentQty}`);

      const dcItem = challan.items[0];
      const ret = await SalesService.createDeliveryChallanReturn({
        challanId: challan.id, reason: 'Test 1', items: [{ challanItemId: dcItem.id, quantity: 2 }]
      });
      createdDcReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('costProvenance EXACT at CREATE time', ri.costProvenance === 'EXACT', `got ${ri.costProvenance}`);
      check('costReversal = 40 persisted at CREATE time', closeEnough(ri.costReversal, 40), `got ${ri.costReversal}`);
      const alloc = ri.costAllocation as any[];
      check('allocation is single-layer [{batchId, qty:2, unitCost:20}]', alloc.length === 1 && alloc[0].batchId === batch!.id && alloc[0].qty === 2 && alloc[0].unitCost === 20, JSON.stringify(alloc));

      const received = await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ri.id, condition: 'GOOD' }]);
      check('Return status RECEIVED', received?.status === 'RECEIVED', `got ${received?.status}`);

      const batchAfterReturn = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('SAME batch incremented by 2 (5 -> 7)', batchAfterReturn.currentQty === 7, `got ${batchAfterReturn.currentQty}`);

      const restockMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'DELIVERY_CHALLAN_RETURN', referenceId: ret.id } });
      check('Test 14: movementType is SALES_RETURN_IN (NOT PURCHASE_IN)', restockMv.movementType === 'SALES_RETURN_IN', `got ${restockMv.movementType}`);
      check('restock movement batchId points at the SAME original batch', restockMv.batchId === batch!.id);
      check('restock movement unitCost is the historical ₹20, not any current cost', closeEnough(restockMv.unitCost, 20), `got ${restockMv.unitCost}`);
    }

    // ── Test 2: multi-layer dispatch ──────────────────────────────────────
    console.log('\n--- 2. Multi-layer dispatch: 5@₹20 + 5@₹30, dispatch 8, return 3 ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcMulti', hq.id);
      const { batch: batch1 } = await receiveBatch(invItem.id, 5, 20, `P3A-B1-${suffix}`);
      const { batch: batch2 } = await receiveBatch(invItem.id, 5, 30, `P3A-B2-${suffix}`);
      const customer = await makeCustomer('DcMultiCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 8, hq.id);
      const dispatchMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'DELIVERY_CHALLAN', referenceId: challan.id, itemId: invItem.id } });
      check('Original dispatch COGS = ₹190 (5x20 + 3x30, blended unitCost x total qty)', closeEnough(Math.abs(dispatchMv.quantity) * (dispatchMv.unitCost || 0), 190), `qty=${dispatchMv.quantity}, unitCost=${dispatchMv.unitCost}`);

      const dcItem = challan.items[0];
      const ret = await SalesService.createDeliveryChallanReturn({
        challanId: challan.id, reason: 'Test 2', items: [{ challanItemId: dcItem.id, quantity: 3 }]
      });
      createdDcReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('costReversal = ₹60 (3 units from batch1 @ ₹20, the FIRST layer consumed)', closeEnough(ri.costReversal, 60), `got ${ri.costReversal}`);
      const alloc = ri.costAllocation as any[];
      check('Allocation draws entirely from batch1 (oldest layer), not batch2', alloc.length === 1 && alloc[0].batchId === batch1!.id && alloc[0].qty === 3 && alloc[0].unitCost === 20, JSON.stringify(alloc));
    }

    // ── Test 3/4: sequential partial returns, remainder trackable ─────────
    console.log('\n--- 3/4. Sequential partial returns (4, 6, 5) on a 15-unit mixed-layer dispatch (10@₹20+5@₹30) → sums to full dispatch COGS, further return fails ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcSequential', hq.id);
      const { batch: b1 } = await receiveBatch(invItem.id, 10, 20, `P3A-SEQ1-${suffix}`);
      const { batch: b2 } = await receiveBatch(invItem.id, 5, 30, `P3A-SEQ2-${suffix}`);
      const customer = await makeCustomer('DcSeqCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 15, hq.id);
      const dcItem = challan.items[0];

      const r1 = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Seq 1', items: [{ challanItemId: dcItem.id, quantity: 4 }] });
      createdDcReturnIds.push(r1.id);
      const r2 = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Seq 2', items: [{ challanItemId: dcItem.id, quantity: 6 }] });
      createdDcReturnIds.push(r2.id);
      const r3 = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Seq 3', items: [{ challanItemId: dcItem.id, quantity: 5 }] });
      createdDcReturnIds.push(r3.id);

      const cost1 = r1.items[0].costReversal ?? 0, cost2 = r2.items[0].costReversal ?? 0, cost3 = r3.items[0].costReversal ?? 0;
      console.log(`   Return costs: r1(4)=₹${cost1}, r2(6)=₹${cost2}, r3(5)=₹${cost3}`);
      check('r1 (4 units) = ₹80 (all from batch1 @₹20)', closeEnough(cost1, 80), `got ${cost1}`);
      check('r2 (6 units) = ₹120 (remaining 6 units of batch1 @₹20)', closeEnough(cost2, 120), `got ${cost2}`);
      check('r3 (5 units) = ₹150 (5 units @₹30 from batch2)', closeEnough(cost3, 150), `got ${cost3}`);
      check('Test 4: sum of all 3 sequential returns = full dispatch COGS ₹350 exactly (10x20 + 5x30)', closeEnough(cost1 + cost2 + cost3, 350), `sum=${cost1 + cost2 + cost3}`);

      const allAllocations = [...(r1.items[0].costAllocation as any[]), ...(r2.items[0].costAllocation as any[]), ...(r3.items[0].costAllocation as any[])];
      const b1Qty = allAllocations.filter(a => a.batchId === b1!.id).reduce((s, a) => s + a.qty, 0);
      const b2Qty = allAllocations.filter(a => a.batchId === b2!.id).reduce((s, a) => s + a.qty, 0);
      check('No double-counting: batch1 allocated exactly 10 units total across all returns', b1Qty === 10, `got ${b1Qty}`);
      check('No double-counting: batch2 allocated exactly 5 units total across all returns', b2Qty === 5, `got ${b2Qty}`);

      let threw = false;
      try {
        await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Seq 4 (over)', items: [{ challanItemId: dcItem.id, quantity: 1 }] });
      } catch (e: any) {
        threw = true;
        console.log(`   Rejected with: "${e.message}"`);
      }
      check('A further return attempt (15 already returned = 15 dispatched) is rejected', threw);

      // Receive all three and confirm the SAME two original batches absorb
      // exactly their own share, never a fabricated new batch.
      await SalesService.receiveDeliveryChallanReturn(r1.id, [{ returnItemId: r1.items[0].id, condition: 'GOOD' }]);
      await SalesService.receiveDeliveryChallanReturn(r2.id, [{ returnItemId: r2.items[0].id, condition: 'GOOD' }]);
      await SalesService.receiveDeliveryChallanReturn(r3.id, [{ returnItemId: r3.items[0].id, condition: 'GOOD' }]);
      const b1After = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: b1!.id } });
      const b2After = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: b2!.id } });
      check('Batch1 restored to its full original 10 (0 -> 10 after dispatch depleted it)', b1After.currentQty === 10, `got ${b1After.currentQty}`);
      check('Batch2 restored to its full original 5 (0 -> 5)', b2After.currentQty === 5, `got ${b2After.currentQty}`);
    }

    // ── Test 5: single-call over-return guard ──────────────────────────────
    console.log('\n--- 5. Over-return guard: dispatch of 10, return 6, then attempt to return 5 more (11 > 10) → must fail ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcOverReturn', hq.id);
      await receiveBatch(invItem.id, 10, 15, `P3A-OVR-${suffix}`);
      const customer = await makeCustomer('DcOverCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 10, hq.id);
      const dcItem = challan.items[0];

      const r1 = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Partial 1', items: [{ challanItemId: dcItem.id, quantity: 6 }] });
      createdDcReturnIds.push(r1.id);

      let threw = false;
      try {
        const r2 = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Over return', items: [{ challanItemId: dcItem.id, quantity: 5 }] });
        createdDcReturnIds.push(r2.id);
      } catch (e: any) {
        threw = true;
        console.log(`   Rejected with: "${e.message}"`);
      }
      check('Over-return (6 already + 5 more = 11 > 10 dispatched) was rejected', threw);
    }

    // ── Test 6: concurrent createDeliveryChallanReturn (TOCTOU fix) ────────
    console.log('\n--- 6. Concurrent returns: fire 7 and 5 simultaneously against a dispatch of 10 ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcConcurrent', hq.id);
      await receiveBatch(invItem.id, 10, 12, `P3A-CONC-${suffix}`);
      const customer = await makeCustomer('DcConcCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 10, hq.id);
      const dcItem = challan.items[0];

      const results = await Promise.allSettled([
        SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Concurrent A (7)', items: [{ challanItemId: dcItem.id, quantity: 7 }] }),
        SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Concurrent B (5)', items: [{ challanItemId: dcItem.id, quantity: 5 }] }),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
      const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
      for (const f of fulfilled) createdDcReturnIds.push(f.value.id);
      console.log(`   Outcome: ${fulfilled.length} fulfilled, ${rejected.length} rejected`);
      if (rejected.length) console.log(`   Rejection reason: ${rejected[0].reason?.message}`);

      check('Exactly one of the two concurrent 7+5 requests succeeded (12 > 10 dispatched, cannot both fit)', fulfilled.length === 1 && rejected.length === 1, `fulfilled=${fulfilled.length}, rejected=${rejected.length}`);

      const totalReturnedQty = await prisma.deliveryChallanReturnItem.aggregate({
        _sum: { quantity: true },
        where: { returnId: { in: fulfilled.map(f => f.value.id) } }
      });
      const returnedQty = totalReturnedQty._sum.quantity || 0;
      check('Total accepted quantity across both concurrent calls never exceeds 10', returnedQty <= 10, `got ${returnedQty}`);
    }

    // ── Test 7: duplicate receiveDeliveryChallanReturn completion ──────────
    console.log('\n--- 7. Duplicate receive: same return received twice (sequential AND concurrent) must not double-restore ---');
    {
      // 7a. Sequential duplicate call.
      const { invItem, product } = await makeItemAndProduct('DcDupSeq', hq.id);
      const { batch } = await receiveBatch(invItem.id, 10, 18, `P3A-DUPSEQ-${suffix}`);
      const customer = await makeCustomer('DcDupSeqCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 6, hq.id);
      const dcItem = challan.items[0];
      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Dup seq', items: [{ challanItemId: dcItem.id, quantity: 4 }] });
      createdDcReturnIds.push(ret.id);

      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);
      const afterFirst = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('First receive call restores stock as expected (dispatched to 4, +4 back = 8)', afterFirst.currentQty === 8, `got ${afterFirst.currentQty}`);

      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);
      const afterSecond = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch!.id } });
      check('Second (duplicate, sequential) receive call is a no-op — stock unchanged', afterSecond.currentQty === 8, `got ${afterSecond.currentQty}`);

      const restockCount = await prisma.stockMovement.count({ where: { referenceType: 'DELIVERY_CHALLAN_RETURN', referenceId: ret.id } });
      check('Exactly ONE restock StockMovement exists, not two', restockCount === 1, `got ${restockCount}`);

      // 7b. Concurrent duplicate call — the actual concurrency-fix proof.
      const { invItem: invItem2, product: product2 } = await makeItemAndProduct('DcDupConc', hq.id);
      const { batch: batch2 } = await receiveBatch(invItem2.id, 10, 22, `P3A-DUPCONC-${suffix}`);
      const customer2 = await makeCustomer('DcDupConcCust');
      const challan2 = await dispatchDc(customer2.id, product2.id, product2.name, 6, hq.id);
      const dcItem2 = challan2.items[0];
      const ret2 = await SalesService.createDeliveryChallanReturn({ challanId: challan2.id, reason: 'Dup conc', items: [{ challanItemId: dcItem2.id, quantity: 4 }] });
      createdDcReturnIds.push(ret2.id);

      const concResults = await Promise.allSettled([
        SalesService.receiveDeliveryChallanReturn(ret2.id, [{ returnItemId: ret2.items[0].id, condition: 'GOOD' }]),
        SalesService.receiveDeliveryChallanReturn(ret2.id, [{ returnItemId: ret2.items[0].id, condition: 'GOOD' }]),
      ]);
      const concFulfilled = concResults.filter(r => r.status === 'fulfilled');
      console.log(`   Concurrent duplicate receive outcome: ${concFulfilled.length} fulfilled (both should succeed — second is a no-op, not an error), ${concResults.length - concFulfilled.length} rejected`);

      const batch2After = await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batch2!.id } });
      check('Concurrent duplicate receive: stock restored exactly once (dispatched to 4, +4 back = 8, never 12)', batch2After.currentQty === 8, `got ${batch2After.currentQty}`);
      const restockCount2 = await prisma.stockMovement.count({ where: { referenceType: 'DELIVERY_CHALLAN_RETURN', referenceId: ret2.id } });
      check('Exactly ONE restock StockMovement exists for the concurrently-double-received return', restockCount2 === 1, `got ${restockCount2}`);
    }

    // ── Test 8/9: historical immutability ───────────────────────────────
    console.log('\n--- 8/9. Historical immutability: Product Master price and InventoryItem.costPrice changed after dispatch, before return, must not affect cost reversal ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcImmutable', hq.id);
      const { batch } = await receiveBatch(invItem.id, 10, 22, `P3A-IMMUT-${suffix}`);
      const customer = await makeCustomer('DcImmutCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, hq.id);
      const dcItem = challan.items[0];

      // Mutate everything that must NOT influence the return's cost.
      await prisma.product.update({ where: { id: product.id }, data: { basePrice: 999 } });
      await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { costPrice: 500, customerPrice: 999, dealerPrice: 999, franchisePrice: 999, basePrice: 999 } });
      await receiveBatch(invItem.id, 10, 999, `P3A-NEWPRICEY-${suffix}`); // a new, much pricier batch received AFTER the dispatch

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Immutability test', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Test 8: Cost reversal still uses the ORIGINAL ₹22/unit, unaffected by Product Master price change', closeEnough(ri.costReversal, 44), `got ${ri.costReversal}`);
      check('Test 9: Cost reversal unaffected by InventoryItem.costPrice change to ₹500', closeEnough(ri.costReversal, 44));
      const alloc = ri.costAllocation as any[];
      check('Cost reversal draws from the OLD batch (₹22), never the new ₹999 batch received after dispatch', alloc.every(a => a.unitCost === 22 && a.batchId === batch!.id), JSON.stringify(alloc));

      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ri.id, condition: 'GOOD' }]);
      const restockMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'DELIVERY_CHALLAN_RETURN', referenceId: ret.id } });
      check('Restored movement unitCost is still the historical ₹22, not ₹500/₹999', closeEnough(restockMv.unitCost, 22), `got ${restockMv.unitCost}`);
    }

    // ── Test 10: forged client cost fields ignored ─────────────────────────
    console.log('\n--- 10. Forged client unitCost/totalCost/batchId in the request body have zero effect ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcForged', hq.id);
      const { batch } = await receiveBatch(invItem.id, 10, 20, `P3A-FORGE-${suffix}`);
      const customer = await makeCustomer('DcForgedCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, hq.id);
      const dcItem = challan.items[0];

      const ret = await SalesService.createDeliveryChallanReturn({
        challanId: challan.id, reason: 'Forged cost test',
        items: [{ challanItemId: dcItem.id, quantity: 2, unitCost: 999999, totalCost: 99999999, batchId: 'fake-batch-id' } as any]
      });
      createdDcReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('Forged unitCost/totalCost/batchId in request body ignored — real allocation still ₹20/unit', closeEnough(ri.costReversal, 40), `got ${ri.costReversal}`);
      const alloc = ri.costAllocation as any[];
      check('Forged batchId never leaks into persisted allocation', alloc.every(a => a.unitCost === 20 && a.batchId === batch!.id), JSON.stringify(alloc));
    }

    // ── Test 11: franchise-scoped dispatch/return ──────────────────────────
    console.log('\n--- 11. Franchise-scoped DC dispatch/return: stock restored to the correct franchise InventoryItem, not HQ ---');
    {
      const franchise = await prisma.franchise.create({
        data: { name: `P3A Franchise ${suffix}`, isHQ: false, location: 'Test', ownerName: 'Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}` }
      });
      createdFranchiseIds.push(franchise.id);
      const { invItem, product } = await makeItemAndProduct('DcFranchiseScoped', franchise.id);
      await receiveBatch(invItem.id, 10, 14, `P3A-FRAN-${suffix}`);
      const customer = await makeCustomer('DcFranchiseCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, franchise.id);
      const dcItem = challan.items[0];

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Franchise scope test', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      check('Franchise-scoped return: cost reversal correct (EXACT, ₹28)', ret.items[0].costProvenance === 'EXACT' && closeEnough(ret.items[0].costReversal, 28), `provenance=${ret.items[0].costProvenance}, cost=${ret.items[0].costReversal}`);

      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);
      const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
      check('Restored stock landed on the FRANCHISE item (franchiseId set), not HQ', itemAfter.franchiseId === franchise.id, `got ${itemAfter.franchiseId}`);
      const hqSameSkuAfter = await prisma.inventoryItem.findFirst({ where: { sku: invItem.sku, franchiseId: hq.id } });
      check('No stray HQ-scoped item was created/credited for this SKU', !hqSameSkuAfter);
    }

    // ── Test 12: HQ-scoped dispatch/return ─────────────────────────────────
    console.log('\n--- 12. HQ-scoped DC dispatch/return: stock stays on the HQ-sourced InventoryItem, not misassigned to a franchise ---');
    {
      // NOTE: dispatchChallanStock's own sourceId convention (verified by
      // reading the code) resolves an HQ-sourced DC to InventoryItem.
      // franchiseId === HQ's own RAW id — NOT null. (This differs from the
      // POS/ReturnOrder path, which converts through
      // FranchiseService.toInventoryScopeId, HQ -> null; DC dispatch/receive
      // never does that conversion.) The fixture is aligned to the REAL
      // convention rather than the generic "HQ = null" assumption, matching
      // returns-fifo-costing.test.ts's own test 16 precedent for DC flows.
      const { invItem, product } = await makeItemAndProduct('DcHqScoped', hq.id);
      await receiveBatch(invItem.id, 10, 14, `P3A-HQ-${suffix}`);
      const customer = await makeCustomer('DcHqCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, undefined); // no sourceFranchiseId -> defaults to HQ
      const dcItem = challan.items[0];

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'HQ scope test', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      check('HQ-scoped return: cost reversal correct (EXACT, ₹28)', ret.items[0].costProvenance === 'EXACT' && closeEnough(ret.items[0].costReversal, 28), `provenance=${ret.items[0].costProvenance}`);

      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);
      const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
      check('HQ-scoped return: restored stock stays on the HQ-sourced item (franchiseId === hq.id), never assigned to a franchise', itemAfter.franchiseId === hq.id, `got ${itemAfter.franchiseId}`);
    }

    // ── Test 13: recall-affected DC return ─────────────────────────────────
    console.log('\n--- 13. Recall-affected DC return: quarantined regardless of cost-provenance classification ---');
    {
      const { RecallService } = require('../../modules/production/recall.service');
      const franchise = await prisma.franchise.create({
        data: { name: `P3A Recall Franchise ${suffix}`, isHQ: false, location: 'Test', ownerName: 'Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}` }
      });
      createdFranchiseIds.push(franchise.id);
      const { invItem, product } = await makeItemAndProduct('DcRecallReturn', franchise.id);
      const { batch } = await receiveBatch(invItem.id, 10, 16, `P3A-RECALL-${suffix}`);
      const productBatch = await prisma.productBatch.create({ data: { productId: product.id, franchiseId: franchise.id, quantity: 10, batchCode: `P3A-PB-${suffix}`, qcStatus: 'APPROVED', approvedQty: 10 } });
      createdProductBatchIds.push(productBatch.id);
      await prisma.inventoryBatch.update({ where: { id: batch!.id }, data: { productBatchId: productBatch.id } });

      const customer = await makeCustomer('DcRecallCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 5, franchise.id);
      const dcItem = challan.items[0];

      const recall = await RecallService.initiateRecall(productBatch.id, { reason: 'Contamination' });
      createdRecallIds.push(recall.id);

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Recall-affected return', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      check('Return line still has a real cost allocation computed regardless of the (not-yet-applied) recall', ret.items[0].costProvenance === 'EXACT', `got ${ret.items[0].costProvenance}`);

      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);

      const riFromDb = await prisma.deliveryChallanReturnItem.findUniqueOrThrow({ where: { id: ret.items[0].id } });
      check('Return item IS recall-flagged despite condition GOOD', !!riFromDb.recallId, `recallId=${riFromDb.recallId}`);
      check('Return item condition overridden to QUARANTINE', riFromDb.condition === 'QUARANTINE', `got ${riFromDb.condition}`);

      const restockMv = await prisma.stockMovement.findFirst({ where: { referenceType: 'DELIVERY_CHALLAN_RETURN', referenceId: ret.id, movementType: 'SALES_RETURN_IN' } });
      check('NO SALES_RETURN_IN movement was written for the quarantined line (recall takes priority)', !restockMv, `found=${!!restockMv}`);
      const recallMv = await prisma.stockMovement.findFirst({ where: { itemId: invItem.id, note: { contains: 'traced to a recalled batch' } } });
      check('The actual movement recorded reflects the recall-quarantine path (existing, untouched recall architecture)', !!recallMv);
    }

    // ── Test 15: inventory valuation report reflects corrected cost ────────
    console.log('\n--- 15. Inventory valuation (getInventoryLedger, report-derived from StockMovement.unitCost) reflects the corrected historical cost ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcValuation', hq.id);
      const { batch } = await receiveBatch(invItem.id, 10, 33, `P3A-VAL-${suffix}`);
      const customer = await makeCustomer('DcValCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, hq.id);
      const dcItem = challan.items[0];
      // Change current costPrice AFTER dispatch to prove the ledger doesn't
      // fall back to it for the restock row.
      await prisma.inventoryItem.update({ where: { id: invItem.id }, data: { costPrice: 777 } });

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Valuation test', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);

      const ledger = await InventoryService.getInventoryLedger(undefined, invItem.id);
      const restockRow = ledger.find((r: any) => r.referenceType === 'DELIVERY_CHALLAN_RETURN' && r.referenceId === ret.id);
      check('Ledger row exists for the restock movement', !!restockRow);
      check('Ledger unitCost/totalValue reflect the historical ₹33/unit, not the current ₹777', !!restockRow && closeEnough(restockRow.unitCost, 33) && closeEnough(restockRow.totalValue, 66), `unitCost=${restockRow?.unitCost}, totalValue=${restockRow?.totalValue}`);
    }

    // ── Test 16: no GST/refund/ledger side effects ─────────────────────────
    console.log('\n--- 16. No Order/Invoice/Payment/CustomerLedger/FranchiseLedger row is created or modified by either DC-return function ---');
    {
      const { invItem, product } = await makeItemAndProduct('DcNoSideEffects', hq.id);
      await receiveBatch(invItem.id, 10, 19, `P3A-NOSIDE-${suffix}`);
      const customer = await makeCustomer('DcNoSideCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, hq.id);
      const dcItem = challan.items[0];

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'No side effects test', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ret.items[0].id, condition: 'GOOD' }]);

      const orderCount = await prisma.order.count({ where: { customerId: customer.id } });
      check('No Order row was created for this customer by the DC-return flow', orderCount === 0, `got ${orderCount}`);
      const paymentCount = await prisma.payment.count({ where: { linkedDocId: { in: [ret.id, challan.id] } } });
      check('No Payment row references the return/challan id', paymentCount === 0, `got ${paymentCount}`);
      const custLedgerCount = await prisma.customerLedger.count({ where: { referenceId: { in: [ret.id, challan.id] } } });
      check('No CustomerLedger row references the return/challan id', custLedgerCount === 0, `got ${custLedgerCount}`);
      const franLedgerCount = await prisma.franchiseLedger.count({ where: { referenceId: { in: [ret.id, challan.id] } } });
      check('No FranchiseLedger row references the return/challan id', franLedgerCount === 0, `got ${franLedgerCount}`);
      console.log('   (Code-inspection confirms neither createDeliveryChallanReturn nor receiveDeliveryChallanReturn ever call FinanceService/Payment/Invoice/Ledger APIs — this was already true before Phase 3A and remains true after; DeliveryChallanReturn has no money/GST fields at all.)');
    }

    // ── Test 17: PROVENANCE_UNAVAILABLE fallback ───────────────────────────
    console.log('\n--- 17. PROVENANCE_UNAVAILABLE fallback: no matching outbound StockMovement for the dispatch ---');
    {
      // Case A: a DC dispatch whose outbound StockMovement row exists but has
      // been stripped of batchId/consumptionBreakdown/unitCost — the exact
      // "malformed legacy data" shape _computeReturnFifoAllocation is built
      // to recognize and refuse to fabricate a cost for.
      const { invItem, product } = await makeItemAndProduct('DcProvUnavailable', hq.id);
      await receiveBatch(invItem.id, 10, 25, `P3A-PROVUNAV-${suffix}`);
      const customer = await makeCustomer('DcProvUnavailCust');
      const challan = await dispatchDc(customer.id, product.id, product.name, 4, hq.id);
      const dcItem = challan.items[0];

      // Strip the original dispatch movement's provenance fields to simulate
      // a pre-existing/legacy row with no traceable cost.
      await prisma.stockMovement.updateMany({
        where: { referenceType: 'DELIVERY_CHALLAN', referenceId: challan.id, itemId: invItem.id },
        data: { batchId: null, consumptionBreakdown: Prisma.JsonNull, unitCost: null } as any
      });

      const ret = await SalesService.createDeliveryChallanReturn({ challanId: challan.id, reason: 'Provenance unavailable test', items: [{ challanItemId: dcItem.id, quantity: 2 }] });
      createdDcReturnIds.push(ret.id);
      const ri = ret.items[0];
      check('costProvenance is PROVENANCE_UNAVAILABLE', ri.costProvenance === 'PROVENANCE_UNAVAILABLE', `got ${ri.costProvenance}`);
      check('costAllocation/costReversal are null — no fabricated cost', ri.costAllocation === null && ri.costReversal === null, `costAllocation=${JSON.stringify(ri.costAllocation)}, costReversal=${ri.costReversal}`);

      const itemBefore = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
      await SalesService.receiveDeliveryChallanReturn(ret.id, [{ returnItemId: ri.id, condition: 'GOOD' }]);
      const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: invItem.id } });
      check('Quantity still physically restores (currentStock +2) despite unavailable provenance', itemAfter.currentStock === itemBefore.currentStock + 2, `before=${itemBefore.currentStock}, after=${itemAfter.currentStock}`);
      const restockMv = await prisma.stockMovement.findFirstOrThrow({ where: { referenceType: 'DELIVERY_CHALLAN_RETURN', referenceId: ret.id } });
      check('Restock movement is still labeled SALES_RETURN_IN (never PURCHASE_IN) even in the fallback', restockMv.movementType === 'SALES_RETURN_IN', `got ${restockMv.movementType}`);

      // Case B: no product on the challan line at all (productId null) — the
      // other pre-existing route to PROVENANCE_UNAVAILABLE.
      const challan2 = await SalesService.createDeliveryChallan({
        customerId: customer.id, sourceFranchiseId: hq.id, status: 'IN_TRANSIT',
        items: [{ productId: undefined, productName: 'Free-text item (no product link)', quantity: 3, rate: 10, taxPercent: 0 }]
      } as any, 'tester');
      createdChallanIds.push(challan2.id);
      const dcItem2 = challan2.items[0];
      const ret2 = await SalesService.createDeliveryChallanReturn({ challanId: challan2.id, reason: 'No product link', items: [{ challanItemId: dcItem2.id, quantity: 1 }] });
      createdDcReturnIds.push(ret2.id);
      check('Case B (no productId on the DC line): also classified PROVENANCE_UNAVAILABLE', ret2.items[0].costProvenance === 'PROVENANCE_UNAVAILABLE', `got ${ret2.items[0].costProvenance}`);
      console.log('   Found/constructed 2 distinct PROVENANCE_UNAVAILABLE cases: (A) dispatch movement stripped of batchId/consumptionBreakdown/unitCost, (B) DC line with no linked Product at all.');
    }

    console.log('\n====================================================');
    if (failures === 0) {
      console.log('🎉 ALL DC-RETURNS FIFO-COSTING (PHASE 3A) CHECKS PASSED');
    } else {
      console.error(`💥 ${failures} CHECK(S) FAILED`);
    }
    console.log('====================================================');
  } catch (e) {
    console.error('❌ Exception during Phase 3A DC-returns FIFO costing suite:', e);
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
