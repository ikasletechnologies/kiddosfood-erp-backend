import prisma from '../../lib/prisma';
import { GRNService } from '../../modules/grn/grn.service';

/**
 * Regression script: a GRN approval with a lot number entered must still
 * persist the real Purchase Bill reference onto InventoryBatch.billNumber,
 * independent of batchNumber (which continues to prioritize the lot code
 * for internal traceability, unchanged).
 */
async function run() {
  console.log('================================================================');
  console.log('🔍 GRN PURCHASE-BILL REFERENCE REGRESSION');
  console.log('================================================================\n');

  const scriptId = `GRNBILL_${Date.now()}`;
  let failures = 0;
  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
    else { console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`); failures++; }
  };

  let vendorId: string | null = null;
  let poId: string | null = null;
  let grnId: string | null = null;
  let rawItemId: string | null = null;

  try {
    const vendor = await prisma.vendor.create({
      data: { name: `GRN Bill Test Vendor ${scriptId}`, contact: '9000000000' },
    });
    vendorId = vendor.id;

    const rawItem = await prisma.inventoryItem.create({
      data: { name: `GRN Bill Test Raw ${scriptId}`, sku: `GBR-${scriptId}`, category: 'RAW_MATERIAL', unit: 'KG', costPrice: 0, currentStock: 0 },
    });
    rawItemId = rawItem.id;

    const po = await prisma.procurementOrder.create({
      data: {
        vendorId,
        totalAmount: 500,
        poNumber: `PO-${scriptId}`,
        poItems: { create: [{ inventoryItemId: rawItem.id, quantity: 10, price: 50, unit: 'KG' }] },
      },
    });
    poId = po.id;

    const grn = await GRNService.createFromPO(po.id, {
      items: [{
        materialId: rawItem.id,
        orderedQty: 10,
        receivedQty: 10,
        acceptedQty: 10,
        rejectedQty: 0,
        price: 50,
        lotNumber: `LOT-${scriptId}`,
        mfgDate: new Date().toISOString(),
        expDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      }],
    });
    grnId = grn.id;

    await GRNService.approve(grn.id);

    const batch = await prisma.inventoryBatch.findFirst({ where: { inventoryItemId: rawItem.id } });
    console.log(`   - Created InventoryBatch: batchNumber="${batch?.batchNumber}", billNumber="${batch?.billNumber}", lotNumber="${batch?.lotNumber}"`);

    check('lotNumber persisted as entered', batch?.lotNumber === `LOT-${scriptId}`);
    check('batchNumber still prioritizes the lot code (unchanged behavior)', batch?.batchNumber === `LOT-${scriptId}`);
    check('billNumber is now populated with the real Purchase Bill reference', !!batch?.billNumber && batch.billNumber.startsWith('BILL-'), `got "${batch?.billNumber}"`);
    check('billNumber differs from the lot-code batchNumber', batch?.billNumber !== batch?.batchNumber);

  } catch (err: any) {
    console.error('❌ Exception during GRN bill number regression script:', err);
    failures++;
  } finally {
    console.log('\n🧹 Cleaning up...');
    try {
      if (rawItemId) {
        await prisma.stockMovement.deleteMany({ where: { itemId: rawItemId } });
        await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: rawItemId } });
      }
      if (vendorId) {
        await prisma.vendorLedger.deleteMany({ where: { vendorId } });
        await (prisma as any).vendorMaterial.deleteMany({ where: { vendorId } });
      }
      if (grnId) {
        await prisma.vendorInvoice.deleteMany({ where: { grnId } });
        await prisma.goodsReceiptItem.deleteMany({ where: { grnId } });
        await prisma.goodsReceipt.delete({ where: { id: grnId } });
      }
      // settleVendorOrders() (called at the end of GRNService.approve()) can
      // create/touch other ProcurementOrder rows for this vendor beyond the
      // one this script made — sweep ALL of this vendor's POs, not just poId.
      if (vendorId) {
        const pos = await prisma.procurementOrder.findMany({ where: { vendorId } });
        for (const po of pos) {
          await prisma.vendorInvoice.deleteMany({ where: { poId: po.id } });
          await prisma.goodsReceiptItem.deleteMany({ where: { grn: { poId: po.id } } });
          await prisma.goodsReceipt.deleteMany({ where: { poId: po.id } });
          await prisma.procurementOrderItem.deleteMany({ where: { poId: po.id } });
          await prisma.procurementOrder.delete({ where: { id: po.id } });
        }
      }
      if (rawItemId) await prisma.inventoryItem.delete({ where: { id: rawItemId } });
      if (vendorId) await prisma.vendor.delete({ where: { id: vendorId } });
      console.log('   ✅ Cleanup complete.');
    } catch (cleanErr: any) {
      console.warn('   ⚠️ Cleanup note:', cleanErr.message);
    }
  }

  console.log('\n================================================================');
  if (failures === 0) {
    console.log('🎉 GRN PURCHASE-BILL REFERENCE REGRESSION PASSED! 🎉');
  } else {
    console.error(`💥 ${failures} CHECK(S) FAILED.`);
    process.exit(1);
  }
}

run()
  .catch(err => { console.error('Fatal execution error:', err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
