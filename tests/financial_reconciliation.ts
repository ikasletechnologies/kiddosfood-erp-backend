/**
 * Financial Reconciliation Verification Test
 *
 * Tests:
 * 1. Partial GRN: PO discount/freight pro-rated by accepted value
 * 2. Multiple partial GRNs: Bills reconcile to PO commercial total
 * 3. GRN Rejection: No Vendor Ledger DEBIT on return confirmation
 * 4. Normal return: DOES create Vendor Ledger DEBIT
 *
 * Run: npx ts-node tests/financial_reconciliation.ts
 */

import prisma from '../src/lib/prisma';
import { Prisma } from '@prisma/client';
import { VendorInvoiceService } from '../src/modules/vendor-invoices/vendor-invoices.service';
import { PurchaseService } from '../src/modules/purchase/purchase.service';

const { Decimal } = Prisma;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✅ PASS: ${msg}`);
}

function approx(a: number, b: number, label: string) {
  const diff = Math.abs(a - b);
  if (diff > 0.02) throw new Error(`FAIL: ${label} — got ${a}, expected ${b} (diff ${diff})`);
  console.log(`  ✅ PASS: ${label} — ${a} ≈ ${b}`);
}

async function cleanup(vendorId: string, itemId: string, poId: string) {
  await prisma.vendorLedger.deleteMany({ where: { vendorId } });
  await prisma.vendorInvoice.deleteMany({ where: { vendorId } });
  // items FK constraint: delete by itemName since purchaseReturnId relation isn't in Prisma types
  await prisma.purchaseReturn.deleteMany({ where: { vendorId } }).catch(async () => {
    // Fallback: delete items by raw matching if cascade didn't work
    const returns = await prisma.purchaseReturn.findMany({ where: { vendorId } });
    for (const r of returns) {
      await prisma.$executeRawUnsafe(`DELETE FROM "PurchaseReturnItem" WHERE "returnId" = $1`, r.id);
    }
    await prisma.purchaseReturn.deleteMany({ where: { vendorId } });
  });
  await prisma.goodsReceiptItem.deleteMany({ where: { grn: { poId } } });
  await prisma.goodsReceipt.deleteMany({ where: { poId } });
  await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: itemId } });
  await prisma.procurementOrderItem.deleteMany({ where: { poId } });
  await prisma.procurementOrder.deleteMany({ where: { id: poId } });
  await prisma.inventoryItem.deleteMany({ where: { id: itemId } });
  await prisma.vendor.deleteMany({ where: { id: vendorId } });
}

async function runTests() {
  console.log('\n=== Financial Reconciliation Verification ===\n');

  // --- Setup ---
  const vendor = await prisma.vendor.create({
    data: { name: `Test Vendor ${Date.now()}`, contact: '9999999999', status: 'ACTIVE' }
  });
  const item = await prisma.inventoryItem.create({
    data: {
      name: `Test Material ${Date.now()}`,
      sku: `TM-${Date.now()}`,
      category: 'RAW_MATERIAL',
      unit: 'KG',
      currentStock: 0
    }
  });

  // PO: 10 KG × ₹12 = ₹120 subtotal, Discount ₹20, Freight ₹10 → Total ₹110
  const po = await prisma.procurementOrder.create({
    data: {
      vendorId: vendor.id,
      poNumber: `TEST-PO-${Date.now()}`,
      status: 'APPROVED',
      purchaseType: 'RAW_MATERIAL',
      subtotal: 120,
      discountAmount: 20,
      freightCost: 10,
      cgst: 0, sgst: 0, igst: 0,
      totalAmount: 110,
      poItems: {
        create: [{ inventoryItemId: item.id, quantity: 10, price: 12, unit: 'KG', gstRate: 0 }]
      }
    },
    include: { poItems: true }
  });

  try {
    // ─── TEST 1: Value-based Pro-rata Discount/Freight ─────────────────────────
    console.log('TEST 1: Value-based pro-rata discount and freight on partial GRN');

    // GRN accepts 8 KG: acceptedValue = 8×12 = ₹96
    // fulfillmentRatio = 96/120 = 0.8
    // proRataDiscount = 20 × 0.8 = ₹16
    // proRataFreight  = 10 × 0.8 = ₹8
    // billAmount = 96 + 0(tax) - 16 + 8 = ₹88
    const grnItems8 = [{ materialId: item.id, acceptedQty: 8, price: 12, warehouseId: null }];
    const bill1 = VendorInvoiceService.computeCommercialsFromPO(po, grnItems8);

    console.log(`  Computed: ${JSON.stringify(bill1)}`);
    approx(bill1.subtotal, 96, 'Accepted subtotal (8 KG × ₹12)');
    approx(bill1.amount, 88, 'Bill1 amount (96 – 16 discount + 8 freight)');

    // ─── TEST 2: Two partial GRNs reconcile to PO total ───────────────────────
    console.log('\nTEST 2: Two partial GRNs should sum to PO total ₹110');

    // GRN2 accepts remaining 2 KG: acceptedValue = 2×12 = ₹24
    // fulfillmentRatio = 24/120 = 0.2
    // proRataDiscount = 20 × 0.2 = ₹4
    // proRataFreight  = 10 × 0.2 = ₹2
    // billAmount = 24 - 4 + 2 = ₹22
    const grnItems2 = [{ materialId: item.id, acceptedQty: 2, price: 12, warehouseId: null }];
    const bill2 = VendorInvoiceService.computeCommercialsFromPO(po, grnItems2);

    console.log(`  Computed: ${JSON.stringify(bill2)}`);
    approx(bill2.subtotal, 24, 'Accepted subtotal (2 KG × ₹12)');
    approx(bill2.amount, 22, 'Bill2 amount (24 – 4 discount + 2 freight)');

    const totalBilled = new Decimal(bill1.amount).plus(bill2.amount).toNumber();
    approx(totalBilled, 110, 'Sum of both bills equals PO total ₹110');

    // ─── TEST 3: GRN Rejection return — No Vendor Ledger DEBIT ────────────────
    console.log('\nTEST 3: GRN rejection return does NOT create Vendor Ledger DEBIT');

    const grnReturn = await PurchaseService.createPurchaseReturn({
      vendorId: vendor.id,
      reason: 'Quality failure — items rejected at GRN',
      returnSource: 'GRN_REJECTION',
      items: [{ itemName: item.name, quantity: 2, unit: 'KG', rate: 12 }]
    });

    const ledgerBefore = await prisma.vendorLedger.count({ where: { vendorId: vendor.id } });
    await PurchaseService.updatePurchaseReturn(grnReturn.id, { status: 'COMPLETED' });
    const ledgerAfter = await prisma.vendorLedger.count({ where: { vendorId: vendor.id } });

    assert(
      ledgerAfter === ledgerBefore,
      `GRN rejection return skipped Vendor Ledger (before=${ledgerBefore}, after=${ledgerAfter})`
    );

    // ─── TEST 4: Normal return DOES create Vendor Ledger DEBIT ────────────────
    console.log('\nTEST 4: Normal return DOES create a Vendor Ledger DEBIT');

    // Seed a balance so the normal return has something to reduce
    await prisma.vendorLedger.create({
      data: {
        vendorId: vendor.id,
        type: 'CREDIT',
        amount: 88,
        balanceAfterTransaction: 88,
        referenceType: 'PURCHASE',
        referenceId: po.id,
        paymentMode: 'CASH',
        note: 'Seeded Purchase Bill'
      }
    });

    const normalReturn = await PurchaseService.createPurchaseReturn({
      vendorId: vendor.id,
      reason: 'Damaged packaging on accepted stock',
      returnSource: 'MANUAL',
      items: [{ itemName: item.name, quantity: 2, unit: 'KG', rate: 11 }]
    });

    const countBefore = await prisma.vendorLedger.count({ where: { vendorId: vendor.id } });
    await PurchaseService.updatePurchaseReturn(normalReturn.id, { status: 'APPROVED' });
    const countAfter = await prisma.vendorLedger.count({ where: { vendorId: vendor.id } });

    assert(countAfter === countBefore + 1, `Normal return posted Vendor Ledger DEBIT (${countBefore} → ${countAfter})`);

    const debitEntry = await prisma.vendorLedger.findFirst({
      where: { vendorId: vendor.id, referenceType: 'RETURN' },
      orderBy: { createdAt: 'desc' }
    });
    assert(debitEntry?.type === 'DEBIT', 'Ledger entry type is DEBIT');
    console.log(`  Return ledger amount: ₹${debitEntry?.amount}`);

    console.log('\n✅✅✅ All tests PASSED ✅✅✅\n');

  } finally {
    await cleanup(vendor.id, item.id, po.id);
  }
}

runTests().catch(e => {
  console.error('\n❌ Test failed:', e.message);
  process.exit(1);
});
