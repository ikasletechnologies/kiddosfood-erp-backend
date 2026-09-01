import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';

// Creates one throwaway Estimate through the real service (not a manual DB
// patch), verifies the round-off fix end-to-end (save -> reload -> list),
// then deletes it through the real deleteQuotation() — same as the app's
// own delete flow — leaving the database exactly as it was found.

async function main() {
  const customer = await prisma.customer.findFirst();
  const product = await prisma.product.findFirst();
  if (!customer || !product) throw new Error('Reference customer/product not found for test setup');

  console.log('=== Reproducing the reported bug scenario: Price ₹95, GST 5%, round-off enabled ===');
  console.log('Pre-round total should be 95 + 4.75 = 99.75; UI computes roundOff = +0.25; finalTotal = 100.00');

  let created: any;
  try {
    created = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      customerId: customer.id,
      customerName: customer.name,
      items: [{ productId: product.id, productName: product.name, quantity: 1, unit: 'PCS', rate: 95, taxPercent: 5 }],
      discountAmount: 0,
      roundOffAmount: 0.25, // exactly what EstimationsPageClient now sends
      status: 'SENT',
      createdBy: 'bug4-verification-script',
    });

    console.log('\n=== Immediately after create() ===');
    console.log({ subTotal: created.subTotal, taxAmount: created.taxAmount, discountAmount: created.discountAmount, totalAmount: created.totalAmount });

    const reloaded = await SalesService.getQuotationById(created.id);
    console.log('\n=== Reload via getQuotationById (what the edit form would fetch) ===');
    console.log({ subTotal: reloaded!.subTotal, taxAmount: reloaded!.taxAmount, totalAmount: reloaded!.totalAmount });

    const list = await SalesService.getQuotations({ search: created.quotationNumber });
    const listRow = list.find(q => q.id === created.id);
    console.log('\n=== Same record via getQuotations (what the Estimate list API returns) ===');
    console.log({ totalAmount: listRow?.totalAmount });

    const expected = 100;
    const pass = created.totalAmount === expected && reloaded!.totalAmount === expected && listRow?.totalAmount === expected;
    console.log(`\nsubTotal (95) and taxAmount (4.75) remain separately correct: ${created.subTotal === 95 && created.taxAmount === 4.75 ? '✅ YES' : '❌ NO'}`);
    console.log(`Derived round-off (totalAmount - subTotal - taxAmount): ₹${(created.totalAmount - created.subTotal - created.taxAmount).toFixed(2)}`);
    console.log(`\ncreate() / reload / list all show totalAmount = ₹100.00: ${pass ? '✅ PASS' : '❌ FAIL'}`);

    // Regression: round-off disabled (roundOffAmount omitted/0) must not
    // introduce a phantom adjustment on an already-whole-rupee total.
    const noRoundOff = await SalesService.createQuotation({
      partyType: 'CUSTOMER',
      customerId: customer.id,
      customerName: customer.name,
      items: [{ productId: product.id, productName: product.name, quantity: 1, unit: 'PCS', rate: 100, taxPercent: 0 }],
      discountAmount: 0,
      status: 'SENT',
      createdBy: 'bug4-verification-script',
    });
    console.log(`\nRegression — no roundOffAmount sent, whole-rupee total unaffected: totalAmount=${noRoundOff.totalAmount} ${noRoundOff.totalAmount === 100 ? '✅ PASS' : '❌ FAIL'}`);
    await SalesService.deleteQuotation(noRoundOff.id);
  } finally {
    if (created?.id) {
      await SalesService.deleteQuotation(created.id);
      const stillThere = await prisma.quotation.findUnique({ where: { id: created.id } });
      console.log(`\nCleanup — throwaway Estimate removed via deleteQuotation(): ${stillThere === null ? '✅ confirmed gone' : '❌ STILL PRESENT'}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error('Verification error:', err); process.exit(1); });
