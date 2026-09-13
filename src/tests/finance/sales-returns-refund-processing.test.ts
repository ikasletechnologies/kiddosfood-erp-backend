import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';
import { POSService } from '../../modules/pos/pos.service';
import { authorizeRole } from '../../middleware/rbac.middleware';

// Phase 2 of the Sales/POS Return financial-integrity work: makes the
// refund actually move real money/ledger/day-closing state, reading ONLY
// from the already-correct ReturnOrder established by Phase 1
// (createReturnOrder's refundAmount/taxableValue/gstRate/cgst/sgst/igst/
// taxAmount). See:
//   - sales.service.ts restoreStockForReturnOrder (SalesOrder-only scope fix)
//   - sales.service.ts recordRefund + _apply*CreditLedgerRefund helpers
//   - sales.controller.ts refundReturnOrder
//   - app.ts POST /api/sales/returns/:id/refund
const closeEnough = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING SALES RETURNS REFUND-PROCESSING SUITE (Phase 2)');
  console.log('====================================================\n');

  const hq = await FranchiseService.getHqFranchise();

  // ── Fixtures ──────────────────────────────────────────────────────────
  const skuA = `APPAM-450-REFUND-TEST-${Date.now()}`;
  const invA = await prisma.inventoryItem.create({
    data: {
      name: 'APPAM 450g (Refund Test)', sku: skuA, category: 'FINISHED_GOOD',
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

  const skuB = `SNACKPACK-REFUND-TEST-${Date.now()}`;
  const invB = await prisma.inventoryItem.create({
    data: {
      name: 'Snack Pack (Refund Test)', sku: skuB, category: 'FINISHED_GOOD',
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

  const customer = await prisma.customer.create({ data: { name: `Refund Test Customer ${Date.now()}`, franchiseId: hq.id } });
  const dealer = await prisma.dealer.create({ data: { name: `Refund Test Dealer ${Date.now()}`, franchiseId: hq.id, status: 'ACTIVE' } });
  const secondFranchise = await prisma.franchise.create({
    data: {
      name: `Refund Test Franchise Party ${Date.now()}`, isHQ: false, location: 'Test Location',
      ownerName: 'Test Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      outstandingAmount: 500
    }
  });
  // Isolated franchise for the Day Closing test, so it never collides with
  // real production settlements or other test suites hitting HQ's numbers.
  const dayCloseFranchise = await prisma.franchise.create({
    data: {
      name: `Refund Test DayClose Franchise ${Date.now()}`, isHQ: false, location: 'Test Location',
      ownerName: 'Test Owner', contactNum: `9${Math.floor(100000000 + Math.random() * 899999999)}`
    }
  });

  const cashAccount = await prisma.account.create({
    data: { name: `Refund Test Cash ${Date.now()}`, type: 'CASH', balance: 100000, franchiseId: hq.id }
  });
  const bankAccount = await prisma.account.create({
    data: { name: `Refund Test Bank ${Date.now()}`, type: 'BANK', balance: 100000, franchiseId: hq.id }
  });
  const lowBalanceAccount = await prisma.account.create({
    data: { name: `Refund Test LowBalance ${Date.now()}`, type: 'CASH', balance: 5, franchiseId: hq.id }
  });
  const dayCloseCashAccount = await prisma.account.create({
    data: { name: `Refund Test DayClose Cash ${Date.now()}`, type: 'CASH', balance: 100000, franchiseId: dayCloseFranchise.id }
  });

  const createdOrderIds: string[] = [];
  const createdReturnIds: string[] = [];
  const createdPaymentIds: string[] = [];
  const createdCustomerLedgerIds: string[] = [];
  const createdFranchiseLedgerIds: string[] = [];
  const createdInvoiceOrderIds: string[] = [];

  const step = async (label: string, fn: () => Promise<any>) => {
    try { await fn(); } catch (e: any) { console.error(`   ⚠️  Cleanup step failed (${label}): ${e.message}`); }
  };

  const cleanup = async () => {
    console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
    await step('paymentAllocation', () => prisma.paymentAllocation.deleteMany({ where: { payment: { id: { in: createdPaymentIds } } } }));
    await step('payment (by id)', () => prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } }));
    await step('payment (by orderId)', () => prisma.payment.deleteMany({ where: { orderId: { in: [...createdOrderIds, ...createdInvoiceOrderIds] } } }));
    await step('payment (by linkedDocId=return)', () => prisma.payment.deleteMany({ where: { linkedDocId: { in: createdReturnIds } } }));
    await step('customerLedger (by id)', () => prisma.customerLedger.deleteMany({ where: { id: { in: createdCustomerLedgerIds } } }));
    await step('customerLedger (by customer)', () => prisma.customerLedger.deleteMany({ where: { customerId: customer.id } }));
    await step('franchiseLedger (by id)', () => prisma.franchiseLedger.deleteMany({ where: { id: { in: createdFranchiseLedgerIds } } }));
    await step('franchiseLedger (by franchise)', () => prisma.franchiseLedger.deleteMany({ where: { franchiseId: { in: [secondFranchise.id, dayCloseFranchise.id] } } }));
    await step('stockMovement (by return)', () => prisma.stockMovement.deleteMany({ where: { referenceId: { in: createdReturnIds }, referenceType: 'SALES_RETURN' } }));
    await step('stockMovement (by items)', () => prisma.stockMovement.deleteMany({ where: { itemId: { in: [invA.id, invB.id] } } }));
    await step('returnItem', () => prisma.returnItem.deleteMany({ where: { returnId: { in: createdReturnIds } } }));
    await step('returnOrder', () => prisma.returnOrder.deleteMany({ where: { id: { in: createdReturnIds } } }));
    await step('invoice', () => prisma.invoice.deleteMany({ where: { orderId: { in: [...createdOrderIds, ...createdInvoiceOrderIds] } } }));
    await step('orderItem', () => prisma.orderItem.deleteMany({ where: { orderId: { in: [...createdOrderIds, ...createdInvoiceOrderIds] } } }));
    await step('order', () => prisma.order.deleteMany({ where: { id: { in: [...createdOrderIds, ...createdInvoiceOrderIds] } } }));
    await step('dailySettlement (dayCloseFranchise)', () => prisma.dailySettlement.deleteMany({ where: { franchiseId: dayCloseFranchise.id } }));
    await step('account', () => prisma.account.deleteMany({ where: { id: { in: [cashAccount.id, bankAccount.id, lowBalanceAccount.id, dayCloseCashAccount.id] } } }));
    await step('customer', () => prisma.customer.delete({ where: { id: customer.id } }));
    await step('dealer', () => prisma.dealer.delete({ where: { id: dealer.id } }));
    await step('secondFranchise', () => prisma.franchise.delete({ where: { id: secondFranchise.id } }));
    await step('dayCloseFranchise', () => prisma.franchise.delete({ where: { id: dayCloseFranchise.id } }));
    await step('orphaned orderItems', () => prisma.orderItem.deleteMany({ where: { productId: { in: [productA.id, productB.id] } } }));
    await step('product', () => prisma.product.deleteMany({ where: { id: { in: [productA.id, productB.id] } } }));
    await step('inventoryItem', () => prisma.inventoryItem.deleteMany({ where: { id: { in: [invA.id, invB.id] } } }));
    console.log('   ✅ Test data cleanup finished (see any ⚠️ warnings above).');
  };

  // Helper A: reproduces the mandatory ₹23.63 APPAM worked example exactly
  // (₹45 gross -> 50% discount -> ₹22.50 taxable -> 5% GST -> ₹1.13 ->
  // ₹23.63 total), via SalesOrder -> convertSalesOrderToSale, the SAME path
  // Phase-1's own worked-example test (sales-returns-financial-integrity.
  // test.ts, tests 2 & 6) uses to get this exact figure — a raw POS Order
  // fixture computes tax on GROSS (pre-discount) instead, which is a
  // different, equally-valid, but numerically different convention. Only
  // usable for a single (qty=1) CUSTOMER-party return; accountId supplied
  // explicitly to recordRefund makes party identity irrelevant for the cash/
  // bank scenarios that use this helper.
  const createAppamWorkedExampleReturn = async () => {
    const so = await SalesService.createSalesOrder({
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1, taxPercent: 0 }]
    } as any);
    const converted = await SalesService.convertSalesOrderToSale(so.id, 'test-user');
    const order = (converted as any).sale;
    createdOrderIds.push(order.id);
    const ret = await SalesService.createReturnOrder({
      posOrderId: order.id, reason: 'Refund processing test (APPAM worked example)',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(ret.id);
    const approved = await SalesService.updateReturnOrder(ret.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    return { order, ret: approved };
  };

  // Helper B: a simpler raw POS Order fixture (no discount, tax on gross —
  // the same convention Phase-1's own orderDealer/orderFranchise fixtures
  // use) for scenarios that don't need the exact worked-example number,
  // just an internally-consistent refundAmount. Every unit returned is
  // worth 45 * 1.05 = ₹47.25.
  const createApprovedOrderReturn = async (qty: number, opts: { partyType?: 'CUSTOMER' | 'DEALER' | 'FRANCHISE'; partyId?: string; customerId?: string } = {}) => {
    const gross = 45 * qty;
    const tax = Math.round(gross * 0.05 * 100) / 100;
    const order = await prisma.order.create({
      data: {
        invoiceNum: `RET-REFUND-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        franchiseId: hq.id,
        customerId: opts.customerId || (opts.partyType ? undefined : customer.id),
        partyType: opts.partyType || 'CUSTOMER',
        partyId: opts.partyType ? opts.partyId : undefined,
        subTotal: gross, taxAmount: tax, discountAmount: 0, totalAmount: gross + tax,
        status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productA.id, quantity: qty, price: 45, discountPct: 0, taxAmount: tax, totalAmount: gross }] }
      }
    });
    createdOrderIds.push(order.id);
    const ret = await SalesService.createReturnOrder({
      posOrderId: order.id, reason: 'Refund processing test',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: qty, rate: 1 }]
    } as any);
    createdReturnIds.push(ret.id);
    const approved = await SalesService.updateReturnOrder(ret.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    return { order, ret: approved };
  };

  try {
    // ── 16. Pre-condition fix: SalesOrder/no-posOrder/no-franchiseId scope resolution ─
    console.log('--- 16. Pre-condition fix: customerId/dealerId-only return (no posOrder, no franchiseId) must not throw on approval ---');
    const manualReturnCustomer = await SalesService.createReturnOrder({
      customerId: customer.id, reason: 'Pre-condition fix test (customer-only, no linked order)',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 20 }]
    } as any);
    createdReturnIds.push(manualReturnCustomer.id);
    if (manualReturnCustomer.franchiseId) throw new Error(`Expected no franchiseId party on a manual customer return, got ${manualReturnCustomer.franchiseId}`);
    if (manualReturnCustomer.posOrderId) throw new Error('Expected no posOrderId on a manual return');
    const stockBeforeB = (await prisma.inventoryItem.findUnique({ where: { id: invB.id } }))!.currentStock;
    const approvedManualCustomer = await SalesService.updateReturnOrder(manualReturnCustomer.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    if (approvedManualCustomer.status !== 'APPROVED') throw new Error('Expected manual customer return to reach APPROVED without throwing');
    const stockAfterB = (await prisma.inventoryItem.findUnique({ where: { id: invB.id } }))!.currentStock;
    if (!closeEnough(stockAfterB, stockBeforeB + 1)) throw new Error(`Expected stock to increase by 1 (resolved via customer's home franchise), was ${stockBeforeB} now ${stockAfterB}`);
    console.log(`   ✅ Customer-only return (no posOrder/franchiseId) approved without throwing; stock restored via customer.franchiseId fallback (${stockBeforeB} -> ${stockAfterB})`);

    const manualReturnDealer = await SalesService.createReturnOrder({
      dealerId: dealer.id, reason: 'Pre-condition fix test (dealer-only, no linked order)',
      items: [{ productId: productB.id, productName: 'Snack Pack', quantity: 1, rate: 18 }]
    } as any);
    createdReturnIds.push(manualReturnDealer.id);
    const approvedManualDealer = await SalesService.updateReturnOrder(manualReturnDealer.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    if (approvedManualDealer.status !== 'APPROVED') throw new Error('Expected manual dealer return to reach APPROVED without throwing');
    console.log('   ✅ Dealer-only return (no posOrder/franchiseId) also approved without throwing, resolved via dealer.franchiseId fallback\n');

    // ── 1 & 13. Full cash refund end-to-end (APPAM ₹23.63) + forged amount ignored ─
    console.log('--- 1/13. Full cash refund end-to-end (APPAM ₹23.63 worked example); forged body amount ignored ---');
    const { order: order1, ret: ret1 } = await createAppamWorkedExampleReturn();
    if (!closeEnough(ret1.refundAmount, 23.63)) throw new Error(`Precondition failed: expected refundAmount 23.63, got ${ret1.refundAmount} (order totalAmount ${order1.totalAmount})`);
    const cashBalanceBefore = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    const refund1 = await SalesService.recordRefund(ret1.id, {
      refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester'
    });
    createdPaymentIds.push(refund1.payment.id);
    const cashBalanceAfter = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    console.log(`   Payment.paidAmount=${refund1.payment.paidAmount}, Account.balance before=${cashBalanceBefore} after=${cashBalanceAfter}, ReturnOrder.status=${refund1.returnOrder.status}`);
    if (!closeEnough(refund1.payment.paidAmount, 23.63)) throw new Error(`Expected Payment.paidAmount 23.63, got ${refund1.payment.paidAmount}`);
    if (!closeEnough(cashBalanceBefore - cashBalanceAfter, 23.63)) throw new Error(`Expected Account.balance to decrease by 23.63, decreased by ${cashBalanceBefore - cashBalanceAfter}`);
    if (refund1.returnOrder.status !== 'COMPLETED') throw new Error(`Expected ReturnOrder.status COMPLETED, got ${refund1.returnOrder.status}`);
    console.log('   ✅ APPAM ₹23.63 end-to-end: Payment created, Account.balance decreased exactly, ReturnOrder COMPLETED\n');

    // Forged amount attempt — explicitly try to pass amount/rate/discount/gst in the body-shaped object; recordRefund's signature doesn't even read them.
    const { order: orderForge, ret: retForge } = await createAppamWorkedExampleReturn();
    const forgedRefund = await SalesService.recordRefund(retForge.id, {
      refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester',
      amount: 999999, rate: 999999, discount: 999999, gst: 999999, total: 999999
    } as any);
    createdPaymentIds.push(forgedRefund.payment.id);
    if (!closeEnough(forgedRefund.payment.paidAmount, 23.63)) throw new Error(`SECURITY: forged amount was honored! Expected 23.63, got ${forgedRefund.payment.paidAmount}`);
    console.log(`   ✅ Forged amount/rate/discount/gst/total in request body ignored — Payment.paidAmount is still ret.refundAmount (₹${forgedRefund.payment.paidAmount})\n`);

    // ── 2. Bank/UPI refund ────────────────────────────────────────────
    console.log('--- 2. Bank/UPI refund ---');
    const { ret: ret2 } = await createApprovedOrderReturn(1);
    const bankBalanceBefore = (await prisma.account.findUnique({ where: { id: bankAccount.id } }))!.balance;
    const refund2 = await SalesService.recordRefund(ret2.id, { refundMethod: 'Cheque / UPI', accountId: bankAccount.id, method: 'UPI', createdBy: 'tester' });
    createdPaymentIds.push(refund2.payment.id);
    const bankBalanceAfter = (await prisma.account.findUnique({ where: { id: bankAccount.id } }))!.balance;
    if (!closeEnough(bankBalanceBefore - bankBalanceAfter, 47.25)) throw new Error(`Bank refund: expected balance decrease 47.25, got ${bankBalanceBefore - bankBalanceAfter}`);
    if (refund2.payment.paymentMode !== 'UPI') throw new Error(`Expected paymentMode UPI, got ${refund2.payment.paymentMode}`);
    console.log(`   ✅ Bank/UPI refund: Account.balance decreased by ${bankBalanceBefore - bankBalanceAfter}, paymentMode=${refund2.payment.paymentMode}\n`);

    // ── 3. Credit Ledger refund, Customer with a genuinely UNPAID original order ─
    console.log('--- 3. Credit Ledger refund — Customer, original order genuinely unpaid ---');
    const unpaidOrder = await prisma.order.create({
      data: {
        invoiceNum: `RET-REFUND-UNPAID-${Date.now()}`, franchiseId: hq.id, customerId: customer.id, partyType: 'CUSTOMER',
        subTotal: 90, taxAmount: 4.5, discountAmount: 0, totalAmount: 94.5, status: 'COMPLETED', paymentStatus: 'UNPAID',
        orderItems: { create: [{ productId: productA.id, quantity: 2, price: 45, discountPct: 0, taxAmount: 4.5, totalAmount: 90 }] }
      }
    });
    createdOrderIds.push(unpaidOrder.id);
    const retUnpaid = await SalesService.createReturnOrder({
      posOrderId: unpaidOrder.id, reason: 'Credit ledger on unpaid order',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(retUnpaid.id);
    const retUnpaidApproved = await SalesService.updateReturnOrder(retUnpaid.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    const dueBefore = unpaidOrder.totalAmount; // no payments at all yet
    const refund3 = await SalesService.recordRefund(retUnpaidApproved.id, { refundMethod: 'Credit Ledger', createdBy: 'tester' });
    createdCustomerLedgerIds.push(refund3.ledger.ledgerEntry.id);
    if (refund3.ledger.appliedPayment) createdPaymentIds.push(refund3.ledger.appliedPayment.id);
    if (refund3.ledger.ledgerEntry.type !== 'CREDIT') throw new Error(`Expected CustomerLedger type CREDIT, got ${refund3.ledger.ledgerEntry.type}`);
    if (!closeEnough(refund3.ledger.ledgerEntry.amount, retUnpaidApproved.refundAmount)) throw new Error(`CustomerLedger amount mismatch`);
    if (!refund3.ledger.appliedPayment) throw new Error('Expected an applied Payment against the unpaid order');
    // Recompute due the same way getPartyReceivables does.
    const orderAfterCredit = await prisma.order.findUnique({ where: { id: unpaidOrder.id }, include: { payments: { where: { isCancelled: false, status: { not: 'CANCELLED' } } } } });
    const paidAfterCredit = orderAfterCredit!.payments.reduce((s, p) => s + p.paidAmount, 0);
    const dueAfter = orderAfterCredit!.totalAmount - paidAfterCredit;
    console.log(`   Due before: ₹${dueBefore.toFixed(2)}, applied: ₹${refund3.ledger.appliedToOutstanding.toFixed(2)}, due after: ₹${dueAfter.toFixed(2)}`);
    if (!closeEnough(dueAfter, dueBefore - retUnpaidApproved.refundAmount)) throw new Error(`Expected due to decrease by refundAmount (${retUnpaidApproved.refundAmount}), before=${dueBefore} after=${dueAfter}`);
    // The applied Payment must not have moved a real account balance (status SUCCESS, not PAID).
    const accountUntouched = await prisma.account.findMany({ where: { id: { in: [cashAccount.id, bankAccount.id] } } });
    console.log(`   ✅ CustomerLedger CREDIT row written + live due calculation actually decreased by ₹${retUnpaidApproved.refundAmount} (applied Payment status=${refund3.ledger.appliedPayment.status}, no real Account balance moved)\n`);

    // ── 4. Credit Ledger refund, Customer whose original order was already fully paid (typical POS case) ─
    console.log('--- 4. Credit Ledger refund — Customer, original order already fully PAID (typical POS case): ledger-only ---');
    const { order: order4, ret: ret4 } = await createApprovedOrderReturn(1); // order4 is fully PAID at creation (paymentStatus PAID, but no Payment row was created by prisma.order.create directly — simulate a real Payment so due=0)
    const payment4 = await FinanceService.createPayment({
      amount: order4.totalAmount, flow: 'IN', status: 'PAID', sourceAccount: cashAccount.id, method: 'CASH',
      sourceModule: 'POS', linkedDocType: 'INVOICE', linkedDocId: order4.invoiceNum, orderId: order4.id,
      entityType: 'CUSTOMER', entityId: customer.id, entity: 'Original Sale Payment', createdBy: 'tester'
    });
    createdPaymentIds.push(payment4.id);
    const refund4 = await SalesService.recordRefund(ret4.id, { refundMethod: 'Credit Ledger', createdBy: 'tester' });
    createdCustomerLedgerIds.push(refund4.ledger.ledgerEntry.id);
    if (refund4.ledger.appliedPayment) throw new Error('Expected NO applied Payment for an already-fully-paid order (ledger-only case), but one was created');
    if (!closeEnough(refund4.ledger.appliedToOutstanding, 0)) throw new Error(`Expected appliedToOutstanding 0, got ${refund4.ledger.appliedToOutstanding}`);
    if (!closeEnough(refund4.ledger.ledgerEntry.amount, ret4.refundAmount)) throw new Error('CustomerLedger amount should still be the full refundAmount even when ledger-only');
    console.log(`   ✅ Fully-paid original order: CustomerLedger CREDIT row written for the full ₹${refund4.ledger.ledgerEntry.amount} (documented as ledger-only — no real outstanding existed to reduce, no fabricated Payment created)\n`);

    // ── 5. Dealer refund via the cash path ─────────────────────────────
    console.log('--- 5. Dealer refund via cash path ---');
    const { ret: ret5 } = await createApprovedOrderReturn(1, { partyType: 'DEALER', partyId: dealer.id });
    if (ret5.dealerId !== dealer.id) throw new Error(`Expected dealerId ${dealer.id}, got ${ret5.dealerId}`);
    const cashBalanceBeforeDealer = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    const refund5 = await SalesService.recordRefund(ret5.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester' });
    createdPaymentIds.push(refund5.payment.id);
    const cashBalanceAfterDealer = (await prisma.account.findUnique({ where: { id: cashAccount.id } }))!.balance;
    if (!closeEnough(cashBalanceBeforeDealer - cashBalanceAfterDealer, 47.25)) throw new Error(`Dealer cash refund: expected decrease 47.25, got ${cashBalanceBeforeDealer - cashBalanceAfterDealer}`);
    console.log(`   ✅ Dealer cash refund: Account.balance decreased by ${cashBalanceBeforeDealer - cashBalanceAfterDealer}\n`);

    // ── 6. Franchise refund via Credit Ledger ──────────────────────────
    console.log('--- 6. Franchise refund via Credit Ledger ---');
    const { ret: ret6 } = await createApprovedOrderReturn(1, { partyType: 'FRANCHISE', partyId: secondFranchise.id });
    if (ret6.franchiseId !== secondFranchise.id) throw new Error(`Expected franchiseId ${secondFranchise.id}, got ${ret6.franchiseId}`);
    const outstandingBefore = (await prisma.franchise.findUnique({ where: { id: secondFranchise.id } }))!.outstandingAmount;
    const refund6 = await SalesService.recordRefund(ret6.id, { refundMethod: 'Credit Ledger', createdBy: 'tester' });
    createdFranchiseLedgerIds.push(refund6.ledger.ledgerEntry.id);
    const outstandingAfter = (await prisma.franchise.findUnique({ where: { id: secondFranchise.id } }))!.outstandingAmount;
    if (refund6.ledger.ledgerEntry.type !== 'CREDIT') throw new Error(`Expected FranchiseLedger type CREDIT, got ${refund6.ledger.ledgerEntry.type}`);
    if (!closeEnough(outstandingBefore - outstandingAfter, ret6.refundAmount)) throw new Error(`Expected outstandingAmount to decrease by ${ret6.refundAmount}, decreased by ${outstandingBefore - outstandingAfter}`);
    if (!closeEnough(refund6.ledger.ledgerEntry.balanceAfter, outstandingAfter)) throw new Error(`FranchiseLedger.balanceAfter should match new outstandingAmount`);
    console.log(`   ✅ Franchise Credit Ledger: FranchiseLedger CREDIT row written, outstandingAmount ${outstandingBefore} -> ${outstandingAfter}\n`);

    // ── 7 & 8. Partial-return refund amount + two sequential partials settle independently ─
    console.log('--- 7/8. Partial-return refund amount matches ReturnOrder.refundAmount; two sequential partials settle independently ---');
    const orderPartial = await prisma.order.create({
      data: {
        invoiceNum: `RET-REFUND-PARTIAL-${Date.now()}`, franchiseId: hq.id, customerId: customer.id, partyType: 'CUSTOMER',
        subTotal: 180, taxAmount: 9, discountAmount: 0, totalAmount: 189, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productA.id, quantity: 4, price: 45, discountPct: 0, taxAmount: 9, totalAmount: 180 }] }
      }
    });
    createdOrderIds.push(orderPartial.id);
    const retPartial1 = await SalesService.createReturnOrder({
      posOrderId: orderPartial.id, reason: 'Sequential partial #1',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(retPartial1.id);
    const retPartial1Approved = await SalesService.updateReturnOrder(retPartial1.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    const refundPartial1 = await SalesService.recordRefund(retPartial1Approved.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester' });
    createdPaymentIds.push(refundPartial1.payment.id);
    if (!closeEnough(refundPartial1.payment.paidAmount, retPartial1Approved.refundAmount)) throw new Error('Partial #1 refund amount mismatch');
    if (refundPartial1.payment.paidAmount === orderPartial.totalAmount) throw new Error('Partial #1 refunded the FULL order total, not just this partial return');

    const retPartial2 = await SalesService.createReturnOrder({
      posOrderId: orderPartial.id, reason: 'Sequential partial #2',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(retPartial2.id);
    const retPartial2Approved = await SalesService.updateReturnOrder(retPartial2.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    const refundPartial2 = await SalesService.recordRefund(retPartial2Approved.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester' });
    createdPaymentIds.push(refundPartial2.payment.id);
    if (!closeEnough(refundPartial1.payment.paidAmount, refundPartial2.payment.paidAmount)) throw new Error('Two equal-quantity sequential partial returns should refund equal amounts');
    if (refundPartial1.payment.id === refundPartial2.payment.id) throw new Error('Two sequential partial refunds must create two DISTINCT Payment rows');
    console.log(`   ✅ Partial #1 refunded ₹${refundPartial1.payment.paidAmount} (not the full ₹${orderPartial.totalAmount}); partial #2 independently refunded ₹${refundPartial2.payment.paidAmount} via a distinct Payment\n`);

    // ── 9. Duplicate refund request (sequential) ───────────────────────
    console.log('--- 9. Duplicate refund request (sequential) — second call must not create a second Payment/ledger row ---');
    const { ret: ret9 } = await createApprovedOrderReturn(1);
    const refund9a = await SalesService.recordRefund(ret9.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester' });
    createdPaymentIds.push(refund9a.payment.id);
    let duplicateBlocked = false;
    let duplicateMessage = '';
    try {
      await SalesService.recordRefund(ret9.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester' });
    } catch (e: any) {
      duplicateBlocked = true;
      duplicateMessage = e.message;
    }
    if (!duplicateBlocked) throw new Error('Expected the second (duplicate) refund request to be rejected, but it succeeded');
    const paymentCountForRet9 = await prisma.payment.count({ where: { linkedDocId: ret9.id, status: 'PAID' } });
    if (paymentCountForRet9 !== 1) throw new Error(`Expected exactly 1 Payment for return ${ret9.id}, found ${paymentCountForRet9}`);
    console.log(`   ✅ Duplicate refund rejected ("${duplicateMessage}"); exactly 1 Payment exists for this return\n`);

    // ── 10. Concurrent refund requests ──────────────────────────────────
    console.log('--- 10. Concurrent refund requests (Promise.allSettled) — exactly one Payment must exist afterward ---');
    const { ret: ret10 } = await createApprovedOrderReturn(1);
    const concurrentResults = await Promise.allSettled([
      SalesService.recordRefund(ret10.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester-A' }),
      SalesService.recordRefund(ret10.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester-B' })
    ]);
    const fulfilled = concurrentResults.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = concurrentResults.filter((r) => r.status === 'rejected');
    for (const f of fulfilled) createdPaymentIds.push(f.value.payment.id);
    const paymentCountForRet10 = await prisma.payment.count({ where: { linkedDocId: ret10.id, status: 'PAID' } });
    console.log(`   Concurrent outcome: ${fulfilled.length} fulfilled, ${rejected.length} rejected, Payment rows in DB: ${paymentCountForRet10}`);
    if (paymentCountForRet10 !== 1) throw new Error(`Expected exactly 1 Payment after concurrent refund requests, found ${paymentCountForRet10}`);
    const finalRet10 = await prisma.returnOrder.findUnique({ where: { id: ret10.id } });
    if (finalRet10!.status !== 'COMPLETED') throw new Error(`Expected ReturnOrder to end up COMPLETED, got ${finalRet10!.status}`);
    console.log(`   ✅ Exactly 1 Payment exists after firing 2 concurrent refund requests for the same return; ReturnOrder.status=${finalRet10!.status}\n`);

    // ── 11. Insufficient-funds rollback ─────────────────────────────────
    console.log('--- 11. Insufficient-funds rollback: ReturnOrder must stay APPROVED, no Payment/ledger created ---');
    const { ret: ret11 } = await createApprovedOrderReturn(1); // refundAmount 47.25 > lowBalanceAccount's ₹5
    let insufficientFundsCaught = false;
    try {
      await SalesService.recordRefund(ret11.id, { refundMethod: 'Cash Voucher', accountId: lowBalanceAccount.id, method: 'CASH', createdBy: 'tester' });
    } catch (e: any) {
      insufficientFundsCaught = /Insufficient|INSUFFICIENT_FUNDS/i.test(e.message);
      if (!insufficientFundsCaught) throw e;
    }
    if (!insufficientFundsCaught) throw new Error('Expected an INSUFFICIENT_FUNDS error, none was thrown');
    const ret11AfterFailure = await prisma.returnOrder.findUnique({ where: { id: ret11.id } });
    if (ret11AfterFailure!.status !== 'APPROVED') throw new Error(`Expected ReturnOrder to remain APPROVED after a failed refund, got ${ret11AfterFailure!.status}`);
    const paymentCountForRet11 = await prisma.payment.count({ where: { linkedDocId: ret11.id } });
    if (paymentCountForRet11 !== 0) throw new Error(`Expected 0 Payment rows after a rolled-back refund, found ${paymentCountForRet11}`);
    const lowBalanceAfterFailure = (await prisma.account.findUnique({ where: { id: lowBalanceAccount.id } }))!.balance;
    if (!closeEnough(lowBalanceAfterFailure, 5)) throw new Error(`LowBalance account should be untouched (still ₹5), got ₹${lowBalanceAfterFailure}`);
    console.log(`   ✅ Insufficient funds: transaction rolled back cleanly — ReturnOrder stayed APPROVED, 0 Payment rows created, account balance untouched\n`);

    // ── 15. Historical immutability: mutate Product Master AFTER approval, before refund ─
    console.log('--- 15. Historical immutability: Product Master price/discount/GST change after approval must not affect the refund ---');
    const { ret: ret15 } = await createApprovedOrderReturn(1);
    await prisma.inventoryItem.update({ where: { id: invA.id }, data: { customerPrice: 999, discountValue: 5 } });
    await prisma.product.update({ where: { id: productA.id }, data: { taxPercent: 18 } });
    const refund15 = await SalesService.recordRefund(ret15.id, { refundMethod: 'Cash Voucher', accountId: cashAccount.id, method: 'CASH', createdBy: 'tester' });
    createdPaymentIds.push(refund15.payment.id);
    await prisma.inventoryItem.update({ where: { id: invA.id }, data: { customerPrice: 45, discountValue: 50 } });
    await prisma.product.update({ where: { id: productA.id }, data: { taxPercent: 5 } });
    if (!closeEnough(refund15.payment.paidAmount, 47.25)) throw new Error(`Historical immutability broken: expected refunded 47.25, got ${refund15.payment.paidAmount}`);
    console.log(`   ✅ Product Master mutated AFTER approval (₹999/5%-discount/18%GST) — refund still used the ORIGINAL ret.refundAmount (₹${refund15.payment.paidAmount}); fixture restored\n`);

    // ── 12. Day Closing reflects the refund ──────────────────────────────
    console.log('--- 12. Day Closing (getDailySummary) reflects the refund via existing refundTotal query, zero changes needed ---');
    const dayCloseOrder = await prisma.order.create({
      data: {
        invoiceNum: `RET-REFUND-DAYCLOSE-${Date.now()}`, franchiseId: dayCloseFranchise.id, customerId: customer.id, partyType: 'CUSTOMER',
        subTotal: 45, taxAmount: 2.25, discountAmount: 0, totalAmount: 47.25, status: 'COMPLETED', paymentStatus: 'PAID',
        orderItems: { create: [{ productId: productA.id, quantity: 1, price: 45, discountPct: 0, taxAmount: 2.25, totalAmount: 45 }] }
      }
    });
    createdInvoiceOrderIds.push(dayCloseOrder.id);
    const dayCloseInvoicePayment = await FinanceService.createPayment({
      amount: dayCloseOrder.totalAmount, flow: 'IN', status: 'PAID', sourceAccount: dayCloseCashAccount.id, method: 'CASH',
      sourceModule: 'POS', linkedDocType: 'INVOICE', linkedDocId: dayCloseOrder.invoiceNum, orderId: dayCloseOrder.id,
      entityType: 'CUSTOMER', entityId: customer.id, entity: 'Day Close Sale Payment', createdBy: 'tester'
    });
    createdPaymentIds.push(dayCloseInvoicePayment.id);

    const summaryBeforeRefund = await POSService.getDailySummary(dayCloseFranchise.id);
    if (!closeEnough(summaryBeforeRefund.refundTotal, 0)) throw new Error(`Expected refundTotal 0 before any refund, got ${summaryBeforeRefund.refundTotal}`);

    const dayCloseReturn = await SalesService.createReturnOrder({
      posOrderId: dayCloseOrder.id, reason: 'Day closing test',
      items: [{ productId: productA.id, productName: 'APPAM 450g', quantity: 1, rate: 1 }]
    } as any);
    createdReturnIds.push(dayCloseReturn.id);
    const dayCloseReturnApproved = await SalesService.updateReturnOrder(dayCloseReturn.id, { status: 'APPROVED', approvedBy: 'tester' } as any);
    const dayCloseRefund = await SalesService.recordRefund(dayCloseReturnApproved.id, { refundMethod: 'Cash Voucher', accountId: dayCloseCashAccount.id, method: 'CASH', createdBy: 'tester' });
    createdPaymentIds.push(dayCloseRefund.payment.id);

    const summaryAfterRefund = await POSService.getDailySummary(dayCloseFranchise.id);
    console.log(`   grandTotal=${summaryAfterRefund.grandTotal}, collectionTotal=${summaryAfterRefund.collectionTotal}, refundTotal=${summaryAfterRefund.refundTotal}, netTotal=${summaryAfterRefund.netTotal}, reconciled=${summaryAfterRefund.reconciled}`);
    if (!closeEnough(summaryAfterRefund.refundTotal, dayCloseReturnApproved.refundAmount)) throw new Error(`Expected refundTotal to include the refund (₹${dayCloseReturnApproved.refundAmount}), got ₹${summaryAfterRefund.refundTotal}`);
    if (!summaryAfterRefund.reconciled) throw new Error('Expected this isolated franchise day to be reconciled (single order, fully paid via a real Payment)');
    if (!closeEnough(summaryAfterRefund.netTotal, summaryAfterRefund.collectionTotal - summaryAfterRefund.refundTotal)) throw new Error('netTotal must equal collectionTotal - refundTotal');
    console.log('   ✅ getDailySummary().refundTotal picked up the new refund automatically — zero changes needed to getDailySummary/closeDay\n');

    // Also exercise the full closeDay() path for this isolated franchise.
    const settlement = await POSService.closeDay(dayCloseFranchise.id, 'tester');
    if (!closeEnough(settlement.refundTotal, dayCloseReturnApproved.refundAmount)) throw new Error(`closeDay(): expected persisted refundTotal ${dayCloseReturnApproved.refundAmount}, got ${settlement.refundTotal}`);
    console.log(`   ✅ closeDay() persisted DailySettlement.refundTotal=₹${settlement.refundTotal} matching the refund\n`);

    // ── 14. Unauthorized/wrong-role rejected at the route level ─────────
    console.log('--- 14. Unauthorized/wrong-role attempt is rejected at the route level (authorizeRole middleware, as wired in app.ts) ---');
    const middleware = authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']);
    let forbiddenCaught = false;
    let forbiddenStatus: number | undefined;
    await new Promise<void>((resolve) => {
      const fakeReq: any = { user: { userId: 'cashier-1', role: 'CASHIER' } };
      const fakeRes: any = {};
      middleware(fakeReq, fakeRes, (err: any) => {
        if (err) { forbiddenCaught = true; forbiddenStatus = err.statusCode; }
        resolve();
      });
    });
    if (!forbiddenCaught || forbiddenStatus !== 403) throw new Error(`Expected a 403 Forbidden for role CASHIER, got caught=${forbiddenCaught} status=${forbiddenStatus}`);
    let allowedPassed = false;
    await new Promise<void>((resolve) => {
      const fakeReq: any = { user: { userId: 'admin-1', role: 'FRANCHISE_ADMIN' } };
      const fakeRes: any = {};
      middleware(fakeReq, fakeRes, (err: any) => { allowedPassed = !err; resolve(); });
    });
    if (!allowedPassed) throw new Error('Expected FRANCHISE_ADMIN to pass the same authorizeRole gate registered for POST /api/sales/returns/:id/refund');
    console.log('   ✅ CASHIER role rejected with 403 at the exact authorizeRole(["SUPER_ADMIN","FRANCHISE_ADMIN"]) gate app.ts registers for this route; FRANCHISE_ADMIN passes\n');

    console.log('====================================================');
    console.log('🎉 ALL SALES RETURNS REFUND-PROCESSING CHECKS PASSED');
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
