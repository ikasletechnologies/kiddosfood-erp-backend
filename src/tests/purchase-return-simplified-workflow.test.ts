import prisma from '../lib/prisma';
import { PurchaseService } from '../modules/purchase/purchase.service';

function check(title: string, condition: boolean, details?: string) {
  if (condition) {
    console.log(`[PASS] ${title}`);
  } else {
    console.error(`[FAIL] ${title} ${details ? `(${details})` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
}

async function runTests() {
  console.log('====================================================');
  console.log('PURCHASE RETURN SIMPLIFIED WORKFLOW TEST SUITE');
  console.log('====================================================\n');

  let testVendor: any;
  let testItem: any;

  try {
    // ── Setup Test Vendor & Inventory Item ──
    testVendor = await prisma.vendor.create({
      data: {
        name: `Test Return Vendor ${Date.now()}`,
        contact: '9999999999',
        email: `vendor_${Date.now()}@test.com`,
        state: 'Tamil Nadu'
      }
    });

    testItem = await prisma.inventoryItem.create({
      data: {
        name: `Return Test Item ${Date.now()}`,
        sku: `RTI-${Date.now()}`,
        unit: 'kg',
        category: 'RAW_MATERIAL',
        currentStock: 100,
        minimumStock: 5,
        costPrice: 51.50
      }
    });

    // ── 1. Migration Verification ──
    const approvedCount = await prisma.purchaseReturn.count({ where: { status: 'APPROVED' } });
    check('1. No APPROVED purchase returns remain in DB after migration', approvedCount === 0, `Count=${approvedCount}`);

    // ── 2. PENDING State Effects ──
    const pendingReturn = await prisma.purchaseReturn.create({
      data: {
        returnNumber: `PR-TEST-${Date.now()}-1`,
        vendorId: testVendor.id,
        reason: 'Defective batch',
        returnSource: 'MANUAL',
        status: 'PENDING',
        refundAmount: 500,
        items: {
          create: [{
            itemName: testItem.name,
            quantity: 10,
            unit: 'kg',
            rate: 50,
            totalAmount: 500
          }]
        }
      }
    });

    const initialMovements = await prisma.stockMovement.count({ where: { referenceId: pendingReturn.id } });
    const initialLedgers = await prisma.vendorLedger.count({ where: { referenceId: pendingReturn.returnNumber } });

    check('2a. PENDING return creates 0 inventory movements', initialMovements === 0, `Got ${initialMovements}`);
    check('2b. PENDING return creates 0 vendor ledgers', initialLedgers === 0, `Got ${initialLedgers}`);

    // ── 3. PENDING -> COMPLETED Transition ──
    const completedReturn = await PurchaseService.updatePurchaseReturn(pendingReturn.id, { status: 'COMPLETED' });
    check('3a. Status successfully updated to COMPLETED', completedReturn?.status === 'COMPLETED');

    const completedMovements = await prisma.stockMovement.findMany({ where: { referenceId: pendingReturn.id } });
    const completedLedgers = await prisma.vendorLedger.findMany({ where: { referenceId: pendingReturn.returnNumber } });

    check('3b. COMPLETED return records exactly 1 RETURN_OUT stock movement', completedMovements.length === 1 && completedMovements[0].quantity === -10, `Movements=${completedMovements.length}`);
    check('3c. COMPLETED return records exactly 1 Vendor Ledger DEBIT entry', completedLedgers.length === 1 && completedLedgers[0].type === 'DEBIT' && completedLedgers[0].amount === 500, `Ledgers=${completedLedgers.length}`);
    check('3d. GST fields recognized/backfilled', completedReturn?.taxableValue === 500 && completedReturn?.gstRate !== null, `Taxable=${completedReturn?.taxableValue}`);

    // ── 4. Double Completion Protection (Sequential) ──
    const reCompletedReturn = await PurchaseService.updatePurchaseReturn(pendingReturn.id, { status: 'COMPLETED' });
    const reCompletedMovements = await prisma.stockMovement.count({ where: { referenceId: pendingReturn.id } });
    const reCompletedLedgers = await prisma.vendorLedger.count({ where: { referenceId: pendingReturn.returnNumber } });

    check('4a. Sequential re-completion does not duplicate stock movements', reCompletedMovements === 1, `Got ${reCompletedMovements}`);
    check('4b. Sequential re-completion does not duplicate vendor ledgers', reCompletedLedgers === 1, `Got ${reCompletedLedgers}`);

    // ── 5. Concurrent Double Completion Protection ──
    const concurrentReturn = await prisma.purchaseReturn.create({
      data: {
        returnNumber: `PR-TEST-${Date.now()}-CONC`,
        vendorId: testVendor.id,
        reason: 'Concurrent test',
        returnSource: 'MANUAL',
        status: 'PENDING',
        refundAmount: 200,
        items: {
          create: [{
            itemName: testItem.name,
            quantity: 4,
            unit: 'kg',
            rate: 50,
            totalAmount: 200
          }]
        }
      }
    });

    const [res1, res2] = await Promise.allSettled([
      PurchaseService.updatePurchaseReturn(concurrentReturn.id, { status: 'COMPLETED' }),
      PurchaseService.updatePurchaseReturn(concurrentReturn.id, { status: 'COMPLETED' })
    ]);

    const concMovements = await prisma.stockMovement.count({ where: { referenceId: concurrentReturn.id } });
    const concLedgers = await prisma.vendorLedger.count({ where: { referenceId: concurrentReturn.returnNumber } });

    check('5a. Concurrent completion results in status COMPLETED', res1.status === 'fulfilled' || res2.status === 'fulfilled');
    check('5b. Concurrent completion creates exactly 1 stock movement', concMovements === 1, `Got ${concMovements}`);
    check('5c. Concurrent completion creates exactly 1 vendor ledger DEBIT', concLedgers === 1, `Got ${concLedgers}`);

    // ── 6. Cancellation (PENDING -> CANCELLED) ──
    const cancelReturn = await prisma.purchaseReturn.create({
      data: {
        returnNumber: `PR-TEST-${Date.now()}-CANCEL`,
        vendorId: testVendor.id,
        reason: 'Order cancelled',
        returnSource: 'MANUAL',
        status: 'PENDING',
        refundAmount: 150,
        items: {
          create: [{
            itemName: testItem.name,
            quantity: 3,
            unit: 'kg',
            rate: 50,
            totalAmount: 150
          }]
        }
      }
    });

    const cancelledRes = await PurchaseService.updatePurchaseReturn(cancelReturn.id, { status: 'CANCELLED' });
    const cancelMovements = await prisma.stockMovement.count({ where: { referenceId: cancelReturn.id } });
    const cancelLedgers = await prisma.vendorLedger.count({ where: { referenceId: cancelReturn.returnNumber } });

    check('6a. Status updated to CANCELLED', cancelledRes?.status === 'CANCELLED');
    check('6b. CANCELLED return creates 0 stock movements', cancelMovements === 0, `Got ${cancelMovements}`);
    check('6c. CANCELLED return creates 0 vendor ledgers', cancelLedgers === 0, `Got ${cancelLedgers}`);

    // ── 7. GRN Rejection Return Workflow ──
    const grnReturn = await prisma.purchaseReturn.create({
      data: {
        returnNumber: `PR-TEST-${Date.now()}-GRN`,
        vendorId: testVendor.id,
        reason: 'GRN Rejection test',
        returnSource: 'GRN_REJECTION',
        status: 'PENDING',
        refundAmount: 300,
        items: {
          create: [{
            itemName: testItem.name,
            quantity: 6,
            unit: 'kg',
            rate: 50,
            totalAmount: 300
          }]
        }
      }
    });

    const completedGRNReturn = await PurchaseService.updatePurchaseReturn(grnReturn.id, { status: 'COMPLETED' });
    const grnMovements = await prisma.stockMovement.count({ where: { referenceId: grnReturn.id } });
    const grnLedgers = await prisma.vendorLedger.findMany({ where: { referenceId: grnReturn.returnNumber } });

    check('7a. GRN Rejection return completed with status COMPLETED', completedGRNReturn?.status === 'COMPLETED');
    check('7b. GRN Rejection creates 0 RETURN_OUT stock movements (rejected stock never entered inventory)', grnMovements === 0, `Got ${grnMovements}`);
    check('7c. GRN Rejection creates exactly 1 Vendor Ledger DEBIT entry', grnLedgers.length === 1 && grnLedgers[0].type === 'DEBIT' && grnLedgers[0].amount === 300, `Got ${grnLedgers.length}`);

    // ── 8. Decimal Precision Verification (₹51.50) ──
    const decimalReturn = await prisma.purchaseReturn.create({
      data: {
        returnNumber: `PR-TEST-${Date.now()}-DEC`,
        vendorId: testVendor.id,
        reason: 'Decimal precision test',
        returnSource: 'MANUAL',
        status: 'PENDING',
        refundAmount: 51.50,
        items: {
          create: [{
            itemName: testItem.name,
            quantity: 1,
            unit: 'kg',
            rate: 51.50,
            totalAmount: 51.50
          }]
        }
      }
    });

    const completedDecimal = await PurchaseService.updatePurchaseReturn(decimalReturn.id, { status: 'COMPLETED' });
    const decimalLedger = await prisma.vendorLedger.findFirst({ where: { referenceId: decimalReturn.returnNumber } });

    check('8a. Purchase Return preserves exact decimal amount 51.50', completedDecimal?.refundAmount === 51.50, `Got ${completedDecimal?.refundAmount}`);
    check('8b. Vendor Ledger DEBIT preserves exact decimal amount 51.50 without rounding', decimalLedger?.amount === 51.50, `Got ${decimalLedger?.amount}`);

    console.log('\n====================================================');
    console.log('ALL REGRESSION TESTS PASSED SUCCESSFULLY! ✅');
    console.log('====================================================\n');
  } finally {
    // Cleanup test data
    if (testVendor) {
      await prisma.stockMovement.deleteMany({ where: { note: { contains: testVendor.name } } });
      await prisma.vendorLedger.deleteMany({ where: { vendorId: testVendor.id } });
      await prisma.purchaseReturnItem.deleteMany({ where: { return: { vendorId: testVendor.id } } });
      await prisma.purchaseReturn.deleteMany({ where: { vendorId: testVendor.id } });
      await prisma.vendor.delete({ where: { id: testVendor.id } });
    }
    if (testItem) {
      await prisma.inventoryItem.delete({ where: { id: testItem.id } });
    }
    await prisma.$disconnect();
  }
}

runTests().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
