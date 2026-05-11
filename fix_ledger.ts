import prisma from './src/lib/prisma';

async function fixLedger() {
  const po = await prisma.procurementOrder.findFirst({
    where: { poNumber: 'PO-0001' },
    include: { goodsReceipts: { include: { items: true } } }
  });

  if (!po) {
    console.log('PO-0001 not found');
    return;
  }

  console.log(`Found PO-0001 with status ${po.status}. Total: ₹${po.totalAmount}`);

  const existingLedger = await prisma.vendorLedger.findFirst({
    where: { referenceId: { in: po.goodsReceipts.map(g => g.id) }, referenceType: 'PURCHASE' }
  });

  if (existingLedger) {
    console.log('Ledger entry already exists for this PO.');
    return;
  }

  if (po.status === 'RECEIVED' || po.status === 'PARTIALLY_RECEIVED') {
    // Create ledger entry for the whole PO amount since it's already received
    await prisma.vendorLedger.create({
      data: {
        vendorId: po.vendorId,
        type: 'DEBIT',
        amount: po.totalAmount,
        paymentMode: 'CASH',
        sourceModule: 'PROCUREMENT',
        referenceType: 'PURCHASE',
        referenceId: po.goodsReceipts[0]?.id || po.id,
        note: `Manual fix: Recording liability for RECEIVED PO-0001`
      }
    });
    console.log('Created missing ledger entry for ₹' + po.totalAmount);
  } else {
    console.log('PO is not in RECEIVED status. No action taken.');
  }
}

fixLedger().catch(console.error).finally(() => prisma.$disconnect());
