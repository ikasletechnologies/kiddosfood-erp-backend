import prisma from '../../lib/prisma';
import { SalesService } from '../../modules/sales/sales.service';

async function main() {
  console.log('================================================================');
  console.log('=== TEST 1: Convert Existing QT-2026-00003 Estimate to Sale ===');
  console.log('================================================================');

  const qt3 = await prisma.quotation.findUnique({
    where: { quotationNumber: 'QT-2026-00003' },
    include: { items: true }
  });

  if (!qt3) throw new Error('QT-2026-00003 not found in DB');

  // Reset conversion markers for a clean test run
  await prisma.quotation.update({
    where: { id: qt3.id },
    data: { status: 'SENT', convertedInvoiceId: null, convertedOrderId: null }
  });

  console.log('Original Estimate QT-2026-00003:', {
    subTotal: qt3.subTotal,
    taxAmount: qt3.taxAmount,
    discountAmount: qt3.discountAmount,
    totalAmount: qt3.totalAmount,
    status: qt3.status
  });

  const saleResult: any = await SalesService.convertQuotationToSale(qt3.id, 'test-admin-id');

  console.log('\nResult of Convert to Sale:', {
    success: saleResult.success,
    estimateStatus: saleResult.estimate?.status,
    invoiceNum: saleResult.sale?.invoiceNum,
    saleSubTotal: saleResult.sale?.subTotal,
    saleTaxAmount: saleResult.sale?.taxAmount,
    saleDiscountAmount: saleResult.sale?.discountAmount,
    saleTotalAmount: saleResult.sale?.totalAmount,
    inventoryDeducted: saleResult.sale?.inventory_deducted,
    sourceQuotationId: saleResult.sale?.sourceQuotationId
  });

  // Verify numbers
  if (saleResult.sale?.subTotal !== 45) throw new Error(`Expected Sale SubTotal 45, got ${saleResult.sale?.subTotal}`);
  if (saleResult.sale?.taxAmount !== 2.25) throw new Error(`Expected Sale TaxAmount 2.25, got ${saleResult.sale?.taxAmount}`);
  if (saleResult.sale?.discountAmount !== 15) throw new Error(`Expected Sale Discount 15, got ${saleResult.sale?.discountAmount}`);
  if (saleResult.sale?.totalAmount !== 47) throw new Error(`Expected Sale Total 47, got ${saleResult.sale?.totalAmount}`);
  if (!saleResult.sale?.inventory_deducted) throw new Error('Expected inventory_deducted = true for Sale');

  console.log('✅ TEST 1 PASSED: Convert to Sale preserved exact ₹47.00 totals and inventory rules!');

  console.log('\n================================================================');
  console.log('=== TEST 2: Convert Fresh Estimate to Sales Order ===');
  console.log('================================================================');

  const customer = await prisma.customer.findFirst();
  const product = await prisma.product.findFirst();

  if (!customer || !product) throw new Error('Customer or product missing for test');

  const freshEst = await SalesService.createQuotation({
    partyType: 'CUSTOMER',
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone || '9999999999',
    validUntil: new Date().toISOString().split('T')[0],
    discountAmount: 15,
    items: [
      {
        productId: product.id,
        productName: product.name,
        quantity: 1,
        unit: 'PCS',
        rate: 60,
        taxPercent: 5,
        discountPercent: 25,
        discountAmount: 15
      }
    ],
    roundOffAmount: -0.25,
    status: 'SENT'
  });

  console.log('Created Fresh Estimate:', {
    quotationNumber: freshEst.quotationNumber,
    subTotal: freshEst.subTotal,
    taxAmount: freshEst.taxAmount,
    discountAmount: freshEst.discountAmount,
    totalAmount: freshEst.totalAmount
  });

  const soResult: any = await SalesService.convertQuotationToSalesOrder(freshEst.id, 'test-admin-id');

  console.log('\nResult of Convert to Sales Order:', {
    success: soResult.success,
    estimateStatus: soResult.estimate?.status,
    orderNumber: soResult.salesOrder?.orderNumber,
    soSubTotal: soResult.salesOrder?.subTotal,
    soTaxAmount: soResult.salesOrder?.taxAmount,
    soDiscountAmount: soResult.salesOrder?.discountAmount,
    soTotalAmount: soResult.salesOrder?.totalAmount,
    quotationId: soResult.salesOrder?.quotationId
  });

  if (soResult.salesOrder?.subTotal !== 45) throw new Error(`Expected SO SubTotal 45, got ${soResult.salesOrder?.subTotal}`);
  if (soResult.salesOrder?.taxAmount !== 2.25) throw new Error(`Expected SO TaxAmount 2.25, got ${soResult.salesOrder?.taxAmount}`);
  if (soResult.salesOrder?.totalAmount !== 47) throw new Error(`Expected SO Total 47, got ${soResult.salesOrder?.totalAmount}`);

  console.log('✅ TEST 2 PASSED: Convert to Sales Order preserved exact ₹47.00 totals!');

  console.log('\n================================================================');
  console.log('=== TEST 3: Duplicate Conversion Protection ===');
  console.log('================================================================');

  let dupCaught = false;
  try {
    await SalesService.convertQuotationToSale(qt3.id, 'test-admin-id');
  } catch (err: any) {
    dupCaught = true;
    console.log('Caught duplicate conversion error correctly:', err.message);
  }

  if (!dupCaught) throw new Error('Duplicate conversion was NOT blocked for Sale!');

  dupCaught = false;
  try {
    await SalesService.convertQuotationToSalesOrder(freshEst.id, 'test-admin-id');
  } catch (err: any) {
    dupCaught = true;
    console.log('Caught duplicate conversion error correctly:', err.message);
  }

  if (!dupCaught) throw new Error('Duplicate conversion was NOT blocked for Sales Order!');

  console.log('✅ TEST 3 PASSED: Duplicate conversion rejected cleanly!');

  console.log('\n================================================================');
  console.log('=== TEST 4: Cleanup & Traceability Check ===');
  console.log('================================================================');

  const listQuotations = await SalesService.getQuotations({});
  const q3InList = listQuotations.find((q: any) => q.id === qt3.id);
  const freshInList = listQuotations.find((q: any) => q.id === freshEst.id);

  console.log('List view resolution check:', {
    QT3_convertedInvoiceNumber: q3InList?.convertedInvoiceNumber,
    Fresh_convertedOrderNumber: freshInList?.convertedOrderNumber
  });

  if (!q3InList?.convertedInvoiceNumber) throw new Error('q3InList convertedInvoiceNumber missing');
  if (!freshInList?.convertedOrderNumber) throw new Error('freshInList convertedOrderNumber missing');

  console.log('✅ TEST 4 PASSED: Traceability and list view resolution confirmed!');

  // Cleanup throwaway fresh estimate & sales order
  if (soResult.salesOrder?.id) {
    await prisma.salesOrderItem.deleteMany({ where: { salesOrderId: soResult.salesOrder.id } });
    await prisma.salesOrder.delete({ where: { id: soResult.salesOrder.id } });
  }
  await SalesService.deleteQuotation(freshEst.id);

  console.log('\n🎉 ALL CONVERSION WORKFLOW TESTS PASSED 100%!');
}

main().catch(err => {
  console.error('Verification failure:', err);
  process.exit(1);
});
