import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Regression + acceptance coverage for the Sales/POS Return financial-
// integrity fix (Phase 1). Before this fix, SalesService.createReturnOrder
// computed refundAmount from the CLIENT-SUBMITTED rate
// (quantity * item.rate) with no discount reversal and no GST, and the GST
// breakdown was only backfilled later on PENDING -> APPROVED using the
// already-wrong gross number and TODAY's Product Master tax rate — both the
// refund total AND the GSTR-1 credit-note figures were wrong. See:
//   - sales.service.ts createReturnOrder (per-line reversal formula)
//   - sales.service.ts updateReturnOrder (GST backfill removed)
//   - pos.service.ts checkout() (OrderItem.discountPct now populated)
//   - prisma/schema.prisma ReturnItem.discountAmount/taxableValue/gstRate/taxAmount
const closeEnough = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING SALES RETURNS FINANCIAL-INTEGRITY SUITE');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();

  // APPAM 450g — the exact mandatory worked example configuration.
  const skuA = `APPAM-450-RET-TEST-${Date.now()}`;
  const invA = await prisma.inventoryItem.create({
    data: {
      name: 'APPAM 450g (Returns Test)', sku: skuA, category: 'FINISHED_GOOD',
      currentStock: 100, unit: 'PC', costPrice: 20,
      franchisePrice: 35, dealerPrice: 40, customerPrice: 45, basePrice: 45,
      discountType: 'PERCENT', discountValue: 50, gstRate: 5, franchiseId: null
    }
  });
  const productA = await prisma.product.create({
    data: {
      name: invA.name, sku: skuA, productType: 'FINISHED_GOOD', category: 'FINISHED_GOOD',
      basePrice: 45, discountType: 'PERCENT', discountValue: 50, taxPercent: 5,
      isActive: true, is_menu_item: false
    }
  });

  // Snack Pack — no discount, used for no-discount / dealer / franchise /
  // franchise-order / multi-line scenarios.
  const skuB = `SNACKPACK-RET-TEST-${Date.now()}`;
  const invB = await prisma.inventoryItem.create({
    data: {
      name: 'Snack Pack (Returns Test)', sku: skuB, category: 'FINISHED_GOOD',
      currentStock: 100, unit: 'PC', costPrice: 10,
      franchisePrice: 16, dealerPrice: 18, customerPrice: 20, basePrice: 20,
      discountType: 'PERCENT', discountValue: 0, gstRate: 5, franchiseId: null
    }
  });
  const productB = await prisma.product.create({
    data: {
      name: invB.name, sku: skuB, productType: 'FINISHED_GOOD', category: 'FINISHED_GOOD',
      basePrice: 20, taxPercent: 5, isActive: true, is_menu_item: false
    }
  });

  const customer = await prisma.customer.create({ data: { name: `Returns Fin Test Customer ${Date.now()}`, franchiseId: hq.id } });
  const dealer = await prisma.dealer.create({ data: { name: `Returns Fin Test Dealer ${Date.now()}`, franchiseId: hq.id, status: 'ACTIVE' } });
  const secondFranchise = await prisma.franchise.create({
    data: {
      name: `Returns Fin Test Franchise Party ${Date.now()}`, isHQ: false, location: 'Test Location',
      ownerName: 'Test Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`
    }
  });

  const createdOrderIds: string[] = [];
  const createdSalesOrderIds: string[] = [];
  const createdFranchiseOrderIds: string[] = [];
  const createdReturnIds: string[] = [];

  const step = async (label: string, fn: () => Promise<any>) => {
    try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
  };

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    await step('stockMovement (by return)', () => prisma.stockMovement.deleteMany({ where: { referenceId: { in: createdReturnIds }, referenceType: 'SALES_RETURN' } }));
    await step('stockMovement (by items)', () => prisma.stockMovement.deleteMany({ where: { itemId: { in: [invA.id, invB.id] } } }));
    await step('returnItem', () => prisma.returnItem.deleteMany({ where: { returnId: { in: createdReturnIds } } }));
    await step('returnOrder', () => prisma.returnOrder.deleteMany({ where: { id: { in: createdReturnIds } } }));
    await step('invoice', () => prisma.invoice.deleteMany({ where: { orderId: { in: createdOrderIds } } }));
    await step('orderItem', () => prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } }));
    await step('order', () => prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } }));
    await step('franchiseOrderItem', () => prisma.franchiseOrderItem.deleteMany({ where: { orderId: { in: createdFranchiseOrderIds } } }));
    await step('franchiseOrder', () => prisma.franchiseOrder.deleteMany({ where: { id: { in: createdFranchiseOrderIds } } }));
    await step('salesOrderItem', () => prisma.salesOrderItem.deleteMany({ where: { salesOrderId: { in: createdSalesOrderIds } } }));
    await step('salesOrder', () => prisma.salesOrder.deleteMany({ where: { id: { in: createdSalesOrderIds } } }));
    await step('customer', () => prisma.customer.delete({ where: { id: customer.id } }));
    await step('dealer', () => prisma.dealer.delete({ where: { id: dealer.id } }));
    await step('secondFranchise', () => prisma.franchise.delete({ where: { id: secondFranchise.id } }));
    await step('orphaned orderItems', () => prisma.orderItem.deleteMany({ where: { productId: { in: [productA.id, productB.id] } } }));
    await step('product', () => prisma.product.deleteMany({ where: { id: { in: [productA.id, productB.id] } } }));
    await step('inventoryItem', () => prisma.inventoryItem.deleteMany({ where: { id: { in: [invA.id, invB.id] } } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  };

  try {
    // ── 1. Customer return, NO discount + forged rate ignored ────────────
    console.log('--- 1. Customer return, no discount; forged client rate must be ignored ---');
    const orderNoDiscount = await prisma.order.create({
      data: {
        invoiceNum: `RET-FIN-NODISC-${Date.now()}`, franchiseId: hq.id, customerId: customer.id, partyType: 'CUSTOMER',
        subTotal: 20, taxAmount: 1, discountAmount: 0, totalAmount: 21, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productB.id, quantity: 1, price: 20, discountPct: 0, taxAmount: 1, totalAmount: 20 }] }
      },
      include: { orderItems: true }
    });
    createdOrderIds.push(orderNoDiscount.id);
    const return1 = await SalesService.createReturnOrder({
      posOrderId: orderNoDiscount.id, reason: 'No-discount return test',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 999 }] // forged rate — must be ignored
    } as any);
    createdReturnIds.push(return1.id);
    const r1item = return1.items[0];
    if (r1item.rate !== 20) throw new Error(`Expected resolved rate 20 (forged 999 ignored), got ${r1item.rate}`);
    if (!closeEnough(r1item.discountAmount || 0, 0)) throw new Error(`Expected item discountAmount 0, got ${r1item.discountAmount}`);
    if (!closeEnough(r1item.taxableValue || 0, 20)) throw new Error(`Expected item taxableValue 20, got ${r1item.taxableValue}`);
    if (!closeEnough(r1item.taxAmount || 0, 1)) throw new Error(`Expected item taxAmount 1, got ${r1item.taxAmount}`);
    if (!closeEnough(r1item.totalAmount, 21)) throw new Error(`Expected item totalAmount 21, got ${r1item.totalAmount}`);
    if (!closeEnough(return1.refundAmount, 21)) throw new Error(`Expected refundAmount 21, got ${return1.refundAmount}`);
    if (!closeEnough(return1.taxableValue || 0, 20)) throw new Error(`Expected ReturnOrder.taxableValue 20, got ${return1.taxableValue}`);
    if (!closeEnough(return1.taxAmount || 0, 1)) throw new Error(`Expected ReturnOrder.taxAmount 1, got ${return1.taxAmount}`);
    console.log(`   ✅ No-discount return: rate=${r1item.rate} (forged 999 ignored), refundAmount=₹${return1.refundAmount}\n`);

    // ── 2. Customer return, 50% discount — MANDATORY WORKED EXAMPLE (via salesOrderId) ─
    console.log('--- 2. Customer return, 50% discount — mandatory APPAM worked example (SalesOrder-sourced), forged huge rate ignored ---');
    const so = await SalesService.createSalesOrder({
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }]
    } as any);
    createdSalesOrderIds.push(so.id);
    const return2 = await SalesService.createReturnOrder({
      salesOrderId: so.id, reason: 'APPAM worked example',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 999999 }] // forged large rate
    } as any);
    createdReturnIds.push(return2.id);
    const r2item = return2.items[0];
    console.log(`   Computed: discountAmount=${r2item.discountAmount}, taxableValue=${r2item.taxableValue}, taxAmount=${r2item.taxAmount}, totalAmount=${r2item.totalAmount}, refundAmount=${return2.refundAmount}`);
    if (!closeEnough(r2item.discountAmount || 0, 22.5)) throw new Error(`WORKED EXAMPLE FAILED: expected discountAmount 22.50, got ${r2item.discountAmount}`);
    if (!closeEnough(r2item.taxableValue || 0, 22.5)) throw new Error(`WORKED EXAMPLE FAILED: expected taxableValue 22.50, got ${r2item.taxableValue}`);
    if (!closeEnough(r2item.taxAmount || 0, 1.13)) throw new Error(`WORKED EXAMPLE FAILED: expected taxAmount 1.13, got ${r2item.taxAmount}`);
    if (!closeEnough(r2item.totalAmount, 23.63)) throw new Error(`WORKED EXAMPLE FAILED: expected totalAmount 23.63, got ${r2item.totalAmount}`);
    if (!closeEnough(return2.refundAmount, 23.63)) throw new Error(`WORKED EXAMPLE FAILED: expected refundAmount 23.63 (NOT ₹45), got ${return2.refundAmount}`);
    if (return2.refundAmount === 45) throw new Error('WORKED EXAMPLE FAILED: refundAmount is the old buggy gross ₹45');
    console.log(`   ✅ APPAM worked example reproduced exactly: ₹45 gross → ₹22.50 discount → ₹22.50 taxable → ₹1.13 GST → ₹23.63 total (forged rate 999999 ignored)\n`);

    // ── 3. Dealer return ───────────────────────────────────────────────
    console.log('--- 3. Dealer return (dealer channel price, no Customer Retail Discount) ---');
    const orderDealer = await prisma.order.create({
      data: {
        invoiceNum: `RET-FIN-DEALER-${Date.now()}`, franchiseId: hq.id, partyType: 'DEALER', partyId: dealer.id,
        subTotal: 36, taxAmount: 1.8, discountAmount: 0, totalAmount: 37.8, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productB.id, quantity: 2, price: 18, discountPct: 0, taxAmount: 1.8, totalAmount: 36 }] }
      }
    });
    createdOrderIds.push(orderDealer.id);
    const return3 = await SalesService.createReturnOrder({
      posOrderId: orderDealer.id, reason: 'Dealer return test',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 2, rate: 1 }]
    } as any);
    createdReturnIds.push(return3.id);
    if (return3.dealerId !== dealer.id) throw new Error(`Expected dealerId ${dealer.id}, got ${return3.dealerId}`);
    if (!closeEnough(return3.refundAmount, 37.8)) throw new Error(`Expected refundAmount 37.80, got ${return3.refundAmount}`);
    console.log(`   ✅ Dealer return: dealerId resolved, refundAmount=₹${return3.refundAmount}\n`);

    // ── 4. Franchise-party return ─────────────────────────────────────
    console.log('--- 4. Franchise-party return (franchise channel price) ---');
    const orderFranchise = await prisma.order.create({
      data: {
        invoiceNum: `RET-FIN-FRAN-${Date.now()}`, franchiseId: hq.id, partyType: 'FRANCHISE', partyId: secondFranchise.id,
        subTotal: 16, taxAmount: 0.8, discountAmount: 0, totalAmount: 16.8, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productB.id, quantity: 1, price: 16, discountPct: 0, taxAmount: 0.8, totalAmount: 16 }] }
      }
    });
    createdOrderIds.push(orderFranchise.id);
    const return4 = await SalesService.createReturnOrder({
      posOrderId: orderFranchise.id, reason: 'Franchise-party return test',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(return4.id);
    if (return4.franchiseId !== secondFranchise.id) throw new Error(`Expected franchiseId ${secondFranchise.id}, got ${return4.franchiseId}`);
    if (!closeEnough(return4.refundAmount, 16.8)) throw new Error(`Expected refundAmount 16.80, got ${return4.refundAmount}`);
    console.log(`   ✅ Franchise-party return: franchiseId resolved, refundAmount=₹${return4.refundAmount}\n`);

    // ── 5. POS-sourced return: manual-discount apportionment, partial, ───
    //      sequential partials, multi-line non-interference ──────────────
    console.log('--- 5. POS-sourced return: leftover manual-discount apportionment across 2 lines ---');
    // Item A (APPAM): qty 2 @ 45, 50% channel discount (POS computes tax on
    // GROSS, pre-discount, per POS's own architecture — preserved here).
    //   lineTotal(gross)=90, lineTax=90*5%=4.5, lineDiscount=45 -> discountPct=50
    // Item B (Snack Pack): qty 3 @ 20, no channel discount.
    //   lineTotal(gross)=60, lineTax=3, lineDiscount=0 -> discountPct=0
    // Order-level discountAmount=60 = 45 (channel) + 15 (cashier ad-hoc
    // manualDiscount, with no per-line home) -> leftoverDiscount=15,
    // apportioned by gross weight: Item A gets 15*(90/150)=9, Item B gets
    // 15*(60/150)=6.
    const orderPos = await prisma.order.create({
      data: {
        invoiceNum: `RET-FIN-POS-${Date.now()}`, franchiseId: hq.id, customerId: customer.id, partyType: 'CUSTOMER',
        subTotal: 150, taxAmount: 7.5, discountAmount: 60, totalAmount: 97.5, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: {
          create: [
            { productId: productA.id, quantity: 2, price: 45, discountPct: 50, taxAmount: 4.5, totalAmount: 90 },
            { productId: productB.id, quantity: 3, price: 20, discountPct: 0, taxAmount: 3, totalAmount: 60 }
          ]
        }
      }
    });
    createdOrderIds.push(orderPos.id);

    // Combined return #1: 1 unit of Item A + 1 unit of Item B in ONE call —
    // proves one line's reversal doesn't leak into the other (multi-line
    // non-interference).
    const returnPos1 = await SalesService.createReturnOrder({
      posOrderId: orderPos.id, reason: 'POS partial multi-line return #1',
      items: [
        { productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 },
        { productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 1 }
      ]
    } as any);
    createdReturnIds.push(returnPos1.id);
    const posItemA1 = returnPos1.items.find((i: any) => i.productId === productA.id)!;
    const posItemB1 = returnPos1.items.find((i: any) => i.productId === productB.id)!;
    // Item A: grossReversal=45, discountReversal=45*0.5 + 9*(1/2)=22.5+4.5=27, taxableReversal=18, taxReversal=4.5*(1/2)=2.25, total=20.25
    if (!closeEnough(posItemA1.discountAmount || 0, 27)) throw new Error(`POS Item A: expected discountAmount 27, got ${posItemA1.discountAmount}`);
    if (!closeEnough(posItemA1.taxableValue || 0, 18)) throw new Error(`POS Item A: expected taxableValue 18, got ${posItemA1.taxableValue}`);
    if (!closeEnough(posItemA1.taxAmount || 0, 2.25)) throw new Error(`POS Item A: expected taxAmount 2.25, got ${posItemA1.taxAmount}`);
    if (!closeEnough(posItemA1.totalAmount, 20.25)) throw new Error(`POS Item A: expected totalAmount 20.25, got ${posItemA1.totalAmount}`);
    // Item B: grossReversal=20, discountReversal=6*(1/3)=2, taxableReversal=18, taxReversal=3*(1/3)=1, total=19
    if (!closeEnough(posItemB1.discountAmount || 0, 2)) throw new Error(`POS Item B: expected discountAmount 2, got ${posItemB1.discountAmount}`);
    if (!closeEnough(posItemB1.taxableValue || 0, 18)) throw new Error(`POS Item B: expected taxableValue 18, got ${posItemB1.taxableValue}`);
    if (!closeEnough(posItemB1.taxAmount || 0, 1)) throw new Error(`POS Item B: expected taxAmount 1, got ${posItemB1.taxAmount}`);
    if (!closeEnough(posItemB1.totalAmount, 19)) throw new Error(`POS Item B: expected totalAmount 19, got ${posItemB1.totalAmount}`);
    if (!closeEnough(returnPos1.refundAmount, 39.25)) throw new Error(`Expected combined refundAmount 39.25, got ${returnPos1.refundAmount}`);
    console.log(`   ✅ Multi-line return: Item A (₹${posItemA1.totalAmount}) and Item B (₹${posItemB1.totalAmount}) reversed independently, leftover manual discount apportioned correctly\n`);

    // Sequential partial #2: the remaining 1 unit of Item A — must reproduce
    // the SAME per-unit numbers as return #1 (proportional, not cumulative).
    console.log('--- 5b. Sequential partial return: remaining unit of Item A ---');
    const returnPos2 = await SalesService.createReturnOrder({
      posOrderId: orderPos.id, reason: 'POS sequential partial #2',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(returnPos2.id);
    const posItemA2 = returnPos2.items[0];
    if (!closeEnough(posItemA2.totalAmount, 20.25)) throw new Error(`Sequential partial #2: expected totalAmount 20.25, got ${posItemA2.totalAmount}`);
    const sumItemA = posItemA1.totalAmount + posItemA2.totalAmount;
    if (!closeEnough(sumItemA, 40.5)) throw new Error(`Sum of sequential partial returns for Item A: expected 40.50, got ${sumItemA}`);
    console.log(`   ✅ Two sequential partial returns of Item A sum to ₹${sumItemA} (= its full-line share of the order)`);

    // Over-return guard: Item A is now fully returned (2/2) — a further
    // return of even 1 more unit must fail.
    let overReturnBlocked = false;
    try {
      await SalesService.createReturnOrder({
        posOrderId: orderPos.id, reason: 'Should be rejected — over-return',
        items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
      } as any);
    } catch (e: any) {
      overReturnBlocked = /Cannot return/.test(e.message);
    }
    if (!overReturnBlocked) throw new Error('Expected a 3rd return of Item A (already fully returned) to be rejected, but it was not');
    console.log('   ✅ Over-return guard still blocks a further return once original quantity is exhausted\n');

    // Remaining 2 units of Item B in one shot — full remaining quantity —
    // combined with return #1's 1 unit, must sum to Item B's full-line share.
    console.log('--- 5c. Remaining quantity of Item B returned in one call ---');
    const returnPos3 = await SalesService.createReturnOrder({
      posOrderId: orderPos.id, reason: 'POS remaining Item B',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 2, rate: 1 }]
    } as any);
    createdReturnIds.push(returnPos3.id);
    const posItemB3 = returnPos3.items[0];
    // grossReversal=40, discountReversal=6*(2/3)=4, taxableReversal=36, taxReversal=3*(2/3)=2, total=38
    if (!closeEnough(posItemB3.totalAmount, 38)) throw new Error(`Item B remaining: expected totalAmount 38, got ${posItemB3.totalAmount}`);
    const sumItemB = posItemB1.totalAmount + posItemB3.totalAmount;
    if (!closeEnough(sumItemB, 57)) throw new Error(`Sum of Item B returns: expected 57, got ${sumItemB}`);
    console.log(`   ✅ Item B fully returned across two calls, sums to ₹${sumItemB} (= its full-line share of the order)`);

    // Rounding check: total refunded across ALL returns against orderPos
    // must equal the order's own totalAmount within a cent.
    const totalRefundedPos = returnPos1.refundAmount + returnPos2.refundAmount + returnPos3.refundAmount;
    if (!closeEnough(totalRefundedPos, orderPos.totalAmount, 0.02)) {
      throw new Error(`Rounding drift: total refunded ₹${totalRefundedPos} vs order totalAmount ₹${orderPos.totalAmount}`);
    }
    console.log(`   ✅ Rounding check: total refunded across all partial/multi-line returns (₹${totalRefundedPos.toFixed(2)}) matches order.totalAmount (₹${orderPos.totalAmount}) within a cent\n`);

    // ── 6. SalesOrder-sourced return via the CONVERTED Order/posOrderId ──
    //      path — must reproduce the exact same worked-example numbers as
    //      test 2 (proves the unified formula needs no origin detection). ─
    console.log('--- 6. SalesOrder-sourced return via converted Order/posOrderId path ---');
    const so2 = await SalesService.createSalesOrder({
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }]
    } as any);
    createdSalesOrderIds.push(so2.id);
    const converted = await SalesService.convertSalesOrderToSale(so2.id, 'test-user');
    const convertedOrder = (converted as any).sale;
    createdOrderIds.push(convertedOrder.id);

    // ── 14. Historical immutability: mutate Product Master AFTER the sale ─
    console.log('--- 14. Historical immutability: Product Master change after the sale must not affect the return ---');
    await prisma.inventoryItem.update({ where: { id: invA.id }, data: { customerPrice: 999, discountValue: 5 } });
    await prisma.product.update({ where: { id: productA.id }, data: { taxPercent: 18 } });
    const return6 = await SalesService.createReturnOrder({
      posOrderId: convertedOrder.id, reason: 'SalesOrder-sourced via converted Order',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(return6.id);
    const r6item = return6.items[0];
    if (!closeEnough(r6item.discountAmount || 0, 22.5)) throw new Error(`Converted-Order return: expected discountAmount 22.50 (ORIGINAL sale), got ${r6item.discountAmount}`);
    if (!closeEnough(r6item.taxableValue || 0, 22.5)) throw new Error(`Converted-Order return: expected taxableValue 22.50, got ${r6item.taxableValue}`);
    if (!closeEnough(r6item.taxAmount || 0, 1.13)) throw new Error(`Converted-Order return: expected taxAmount 1.13 (5% GST, NOT today's 18%), got ${r6item.taxAmount}`);
    if (!closeEnough(r6item.totalAmount, 23.63)) throw new Error(`Converted-Order return: expected totalAmount 23.63, got ${r6item.totalAmount}`);
    if (!closeEnough(return6.refundAmount, 23.63)) throw new Error(`Converted-Order return: expected refundAmount 23.63, got ${return6.refundAmount}`);
    console.log(`   ✅ Converted Order (posOrderId) reproduces the EXACT same ₹23.63 worked-example result as direct salesOrderId — no origin detection needed`);
    console.log(`   ✅ Historical immutability: Product Master now says ₹999/5%-discount/18%GST, but the return still used the ORIGINAL ₹45/50%/5% — restoring fixture...\n`);
    await prisma.inventoryItem.update({ where: { id: invA.id }, data: { customerPrice: 45, discountValue: 50 } });
    await prisma.product.update({ where: { id: productA.id }, data: { taxPercent: 5 } });

    // ── 7. FranchiseOrder-sourced return ──────────────────────────────
    console.log('--- 7. FranchiseOrder-sourced return: no discount concept, apportioned order-level tax ---');
    const fo = await prisma.franchiseOrder.create({
      data: {
        orderNumber: `FRO-RET-TEST-${Date.now()}`, franchiseId: secondFranchise.id, status: 'DELIVERED' as any,
        totalAmount: 42, subtotal: 40, taxAmount: 2,
        items: { create: [{ productId: productB.id, quantity: 2, unitPrice: 20, totalAmount: 40, productType: 'FINISHED_GOOD' as any }] }
      }
    });
    createdFranchiseOrderIds.push(fo.id);
    const return7 = await SalesService.createReturnOrder({
      franchiseOrderId: fo.id, reason: 'FranchiseOrder-sourced partial return',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(return7.id);
    const r7item = return7.items[0];
    // grossReversal=20, discountReversal=0 (no discount concept),
    // apportionedTax(full line)=2*(40/40)=2, taxReversal=2*(1/2)=1, taxableReversal=20, total=21
    if (!closeEnough(r7item.discountAmount || 0, 0)) throw new Error(`FranchiseOrder return: expected discountAmount 0, got ${r7item.discountAmount}`);
    if (!closeEnough(r7item.taxableValue || 0, 20)) throw new Error(`FranchiseOrder return: expected taxableValue 20, got ${r7item.taxableValue}`);
    if (!closeEnough(r7item.taxAmount || 0, 1)) throw new Error(`FranchiseOrder return: expected taxAmount 1, got ${r7item.taxAmount}`);
    if (!closeEnough(r7item.totalAmount, 21)) throw new Error(`FranchiseOrder return: expected totalAmount 21, got ${r7item.totalAmount}`);
    if (return7.franchiseId !== secondFranchise.id) throw new Error(`FranchiseOrder return: expected franchiseId ${secondFranchise.id}, got ${return7.franchiseId}`);
    console.log(`   ✅ FranchiseOrder return: discountAmount=0, apportioned tax reversed correctly, refundAmount=₹${return7.refundAmount}\n`);

    // ── 8. Full-quantity return (single line, single call) ────────────
    console.log('--- 8. Full-quantity return (entire original quantity in one call) ---');
    const orderFull = await prisma.order.create({
      data: {
        invoiceNum: `RET-FIN-FULL-${Date.now()}`, franchiseId: hq.id, customerId: customer.id, partyType: 'CUSTOMER',
        subTotal: 80, taxAmount: 4, discountAmount: 0, totalAmount: 84, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productB.id, quantity: 4, price: 20, discountPct: 0, taxAmount: 4, totalAmount: 80 }] }
      }
    });
    createdOrderIds.push(orderFull.id);
    const return8 = await SalesService.createReturnOrder({
      posOrderId: orderFull.id, reason: 'Full-quantity return test',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 4, rate: 1 }]
    } as any);
    createdReturnIds.push(return8.id);
    if (!closeEnough(return8.refundAmount, 84)) throw new Error(`Full-quantity return: expected refundAmount 84, got ${return8.refundAmount}`);
    if (!closeEnough(return8.refundAmount, orderFull.totalAmount, 0.01)) throw new Error(`Full-quantity return does not match original invoice total within a cent`);
    console.log(`   ✅ Full-quantity return: refundAmount=₹${return8.refundAmount} exactly matches original invoice total ₹${orderFull.totalAmount}\n`);

    // ── 3 (cont). updateReturnOrder must NOT recalculate the financial basis ─
    // Uses return1 (posOrderId-sourced) and return6 (posOrderId-sourced via
    // conversion) rather than return2 (pure salesOrderId, no linked Order at
    // all) — restoreStockForReturnOrder's scope resolution needs a
    // posOrder/franchiseId to resolve an inventory scope from, which a
    // salesOrderId-only return legitimately has neither of. That gap is in
    // restoreStockForReturnOrder (stock restoration), explicitly out of
    // scope for this pass; both return1 and return6 already exercise a
    // posOrderId-sourced approval end-to-end.
    console.log('--- 3. updateReturnOrder (PENDING -> APPROVED) must not change the already-established financial basis ---');
    const snapshot1 = { taxableValue: return1.taxableValue, taxAmount: return1.taxAmount, cgst: return1.cgst, sgst: return1.sgst, igst: return1.igst, refundAmount: return1.refundAmount };
    const snapshot6 = { taxableValue: return6.taxableValue, taxAmount: return6.taxAmount, cgst: return6.cgst, sgst: return6.sgst, igst: return6.igst, refundAmount: return6.refundAmount };
    const approved1 = await SalesService.updateReturnOrder(return1.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    const approved6 = await SalesService.updateReturnOrder(return6.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    for (const key of Object.keys(snapshot1) as (keyof typeof snapshot1)[]) {
      if (!closeEnough((approved1 as any)[key] || 0, snapshot1[key] || 0)) {
        throw new Error(`updateReturnOrder changed return1.${key}: was ${snapshot1[key]}, now ${(approved1 as any)[key]} — financial basis was recalculated on approval!`);
      }
    }
    for (const key of Object.keys(snapshot6) as (keyof typeof snapshot6)[]) {
      if (!closeEnough((approved6 as any)[key] || 0, snapshot6[key] || 0)) {
        throw new Error(`updateReturnOrder changed return6.${key}: was ${snapshot6[key]}, now ${(approved6 as any)[key]} — financial basis was recalculated on approval!`);
      }
    }
    console.log('   ✅ PENDING -> APPROVED left refundAmount/taxableValue/taxAmount/cgst/sgst/igst completely unchanged from creation-time values\n');

    // ── 15. GSTR-1 / GSTR-3B credit-note aggregation reflects corrected values ─
    console.log('--- 15. GSTR credit-note aggregation (prisma.returnOrder.aggregate, same shape finance.service.ts uses) reflects corrected values ---');
    const agg = await prisma.returnOrder.aggregate({
      where: { id: { in: [return1.id, return6.id] }, status: { in: ['APPROVED', 'COMPLETED'] }, taxAmount: { not: null } },
      _sum: { taxableValue: true, taxAmount: true, cgst: true, sgst: true, igst: true }
    });
    const expectedTaxable = 20 + 22.5;
    const expectedTax = 1 + 1.13;
    if (!closeEnough(agg._sum.taxableValue || 0, expectedTaxable)) throw new Error(`GSTR aggregate: expected taxableValue sum ${expectedTaxable}, got ${agg._sum.taxableValue}`);
    if (!closeEnough(agg._sum.taxAmount || 0, expectedTax)) throw new Error(`GSTR aggregate: expected taxAmount sum ${expectedTax}, got ${agg._sum.taxAmount}`);
    const cgstPlusSgst = (agg._sum.cgst || 0) + (agg._sum.igst || 0) + (agg._sum.sgst || 0);
    if (!closeEnough(cgstPlusSgst, expectedTax)) throw new Error(`GSTR aggregate: cgst+sgst+igst should equal taxAmount total, got ${cgstPlusSgst} vs ${expectedTax}`);
    console.log(`   ✅ Aggregate (APPROVED returns only) reflects corrected taxableValue=₹${agg._sum.taxableValue}, taxAmount=₹${agg._sum.taxAmount} (the old bug would have reported taxableValue=₹66/taxAmount≈₹3.44 from gross refundAmount with a flat guessed rate)\n`);

    // ── 17. Idempotency unchanged ──────────────────────────────────────
    console.log('--- 17. Idempotency: repeated createReturnOrder with the same idempotencyKey returns the same row ---');
    const idKey = `RET-FIN-IDEMPOTENCY-${Date.now()}`;
    const idemp1 = await SalesService.createReturnOrder({
      customerId: customer.id, reason: 'Idempotency test', idempotencyKey: idKey,
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 20 }]
    } as any);
    createdReturnIds.push(idemp1.id);
    const idemp2 = await SalesService.createReturnOrder({
      customerId: customer.id, reason: 'Idempotency test - retry', idempotencyKey: idKey,
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 20 }]
    } as any);
    if (idemp1.id !== idemp2.id) throw new Error(`Idempotency broken: expected same return id, got ${idemp1.id} vs ${idemp2.id}`);
    const idempCount = await prisma.returnOrder.count({ where: { idempotencyKey: idKey } });
    if (idempCount !== 1) throw new Error(`Idempotency broken: expected exactly 1 ReturnOrder with key ${idKey}, found ${idempCount}`);
    console.log(`   ✅ Same idempotencyKey returns the identical ReturnOrder (${idemp1.id}), no duplicate created\n`);

    console.log('====================================================');
    console.log('🎉 ALL SALES RETURNS FINANCIAL-INTEGRITY CHECKS PASSED');
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
