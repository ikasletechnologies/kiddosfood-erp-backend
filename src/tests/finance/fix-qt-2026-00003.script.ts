import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';

async function main() {
  console.log('=== Step 1: Repairing existing record QT-2026-00003 in DB ===');
  const existing = await prisma.quotation.findFirst({
    where: { quotationNumber: 'QT-2026-00003' },
    include: { items: true }
  });

  if (existing) {
    console.log('Original stored record QT-2026-00003 before repair:');
    console.log({
      subTotal: existing.subTotal,
      taxAmount: existing.taxAmount,
      discountAmount: existing.discountAmount,
      totalAmount: existing.totalAmount,
      itemDiscountAmount: existing.items[0]?.discountAmount,
      itemDiscountPercent: existing.items[0]?.discountPercent,
      itemTaxAmount: existing.items[0]?.taxAmount,
      itemTotalAmount: existing.items[0]?.totalAmount,
    });

    await prisma.quotation.update({ where: { id: existing.id }, data: { status: 'SENT', convertedOrderId: null, convertedInvoiceId: null } });

    const updated = await SalesService.updateQuotation(existing.id, {
      items: existing.items.map(i => ({
        productId: i.productId || undefined,
        productName: i.productName,
        quantity: i.quantity,
        unit: i.unit || undefined,
        rate: i.rate,
        taxPercent: i.taxPercent,
      })),
      discountAmount: 15,
      roundOffAmount: -0.25,
      totalAmount: 47.00,
    });

    console.log('\nRepaired record QT-2026-00003 after updateQuotation():');
    console.log({
      subTotal: updated.subTotal,
      taxAmount: updated.taxAmount,
      discountAmount: updated.discountAmount,
      totalAmount: updated.totalAmount,
      itemDiscountAmount: updated.items[0]?.discountAmount,
      itemDiscountPercent: updated.items[0]?.discountPercent,
      itemTaxAmount: updated.items[0]?.taxAmount,
      itemTotalAmount: updated.items[0]?.totalAmount,
    });
  }

  console.log('\n=== Step 2: Testing fresh creation & reload via SalesService ===');
  const customer = await prisma.customer.findFirst();
  const product = await prisma.product.findFirst();

  if (!customer || !product) {
    throw new Error('Reference customer/product not found for test setup');
  }

  let created: any = null;
  try {
    created = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      customerId: customer.id,
      customerName: customer.name,
      items: [{ productId: product.id, productName: product.name, quantity: 1, unit: 'PCS', rate: 60, taxPercent: 5 }],
      discountAmount: 15,
      roundOffAmount: -0.25,
      totalAmount: 47.00,
      status: 'SENT',
      createdBy: 'test-agent',
    });

    console.log('\nFresh created estimate:');
    console.log({
      quotationNumber: created.quotationNumber,
      subTotal: created.subTotal,
      taxAmount: created.taxAmount,
      discountAmount: created.discountAmount,
      totalAmount: created.totalAmount,
      item: created.items[0],
    });

    const reloaded = await SalesService.getQuotationById(created.id);
    const list = await SalesService.getQuotations({ search: created.quotationNumber });
    const listRow = list.find(q => q.id === created.id);

    console.log('\nValidation results for fresh creation:');
    console.log(`- Stored SubTotal = ₹45.00: ${created.subTotal === 45 ? '✅ PASS' : '❌ FAIL (' + created.subTotal + ')'}`);
    console.log(`- Stored TaxAmount = ₹2.25: ${created.taxAmount === 2.25 ? '✅ PASS' : '❌ FAIL (' + created.taxAmount + ')'}`);
    console.log(`- Stored DiscountAmount = ₹15.00: ${created.discountAmount === 15 ? '✅ PASS' : '❌ FAIL (' + created.discountAmount + ')'}`);
    console.log(`- Stored TotalAmount = ₹47.00: ${created.totalAmount === 47 ? '✅ PASS' : '❌ FAIL (' + created.totalAmount + ')'}`);
    console.log(`- Item DiscountAmount = ₹15.00: ${created.items[0].discountAmount === 15 ? '✅ PASS' : '❌ FAIL (' + created.items[0].discountAmount + ')'}`);
    console.log(`- Item DiscountPercent = 25%: ${created.items[0].discountPercent === 25 ? '✅ PASS' : '❌ FAIL (' + created.items[0].discountPercent + ')'}`);
    console.log(`- Item TaxAmount = ₹2.25: ${created.items[0].taxAmount === 2.25 ? '✅ PASS' : '❌ FAIL (' + created.items[0].taxAmount + ')'}`);
    console.log(`- Listing totalAmount = ₹47.00: ${listRow?.totalAmount === 47 ? '✅ PASS' : '❌ FAIL (' + listRow?.totalAmount + ')'}`);

  } finally {
    if (created?.id) {
      await SalesService.deleteQuotation(created.id);
      console.log('\nCleanup of test record completed.');
    }
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Verification error:', err);
  process.exit(1);
});
