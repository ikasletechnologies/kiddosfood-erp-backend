import prisma from '../../lib/prisma';
import { POSService } from '../../modules/pos/pos.service';
import { FinanceService } from '../../modules/finance/finance.service';

async function runTest() {
  console.log('?? Starting Counter Billing -> Payment -> Receivables Flow Test');

  // 1. Find or create a test product
  let product = await prisma.product.findFirst({ where: { isActive: true } });
  if (!product) {
    throw new Error('No active products found to test checkout');
  }

  // 2. Perform POS Checkout
  const testSubTotal = 1000;
  const testTax = 50;
  const testTotal = 1050;

  const orderResult = await POSService.checkout({
    customerName: 'Test Flow Customer',
    items: [{ productId: product.id, quantity: 1, price: testSubTotal, taxPercent: 5 }],
    subTotal: testSubTotal,
    taxAmount: testTax,
    discountAmount: 0,
    totalAmount: testTotal,
    paymentMode: 'UPI'
  });

  console.log('? Order created:', orderResult.id, orderResult.invoiceNum, 'total:', orderResult.totalAmount, 'paymentStatus:', orderResult.paymentStatus);

  if (orderResult.paymentStatus !== 'PAID') {
    throw new Error(`Expected order paymentStatus to be PAID, got ${orderResult.paymentStatus}`);
  }

  // 3. Query Invoices from Finance API service
  const invoices = await FinanceService.getInvoices();
  const matchedInvoice = invoices.find(inv => inv.orderId === orderResult.id);

  if (!matchedInvoice) {
    throw new Error(`Invoice for order ${orderResult.id} not found in FinanceService.getInvoices()`);
  }

  console.log('? Matched Invoice:', {
    id: matchedInvoice.id,
    orderId: matchedInvoice.orderId,
    totalAmount: matchedInvoice.totalAmount,
    taxAmount: matchedInvoice.taxAmount,
    finalAmount: matchedInvoice.finalAmount,
    status: matchedInvoice.status,
    paymentsCount: matchedInvoice.payments?.length
  });

  // 4. Simulate Receivables processing logic
  const inv: any = matchedInvoice;
  const total = Number(inv.finalAmount ?? inv.grandTotal ?? inv.totalAmount ?? inv.amount ?? inv.total ?? 0);
  const directPaymentSum = inv.payments?.reduce((s: number, p: any) => {
    if (p.isCancelled || (p.status && p.status !== 'PAID' && p.status !== 'SUCCESS')) return s;
    return s + Number(p.paidAmount ?? p.amount ?? 0);
  }, 0) || 0;
  const paid = Number(inv.paidAmount ?? inv.advanceAmount ?? (directPaymentSum > 0 ? directPaymentSum : (inv.status === 'PAID' || inv.order?.paymentStatus === 'PAID' ? total : 0)));
  const outstanding = Math.max(0, total - paid);

  let status: "PAID" | "PARTIAL" | "UNPAID" | "OVERDUE" = "UNPAID";
  if (outstanding <= 0.01) {
    status = "PAID";
  } else if (paid > 0) {
    status = "PARTIAL";
  } else {
    status = "UNPAID";
  }

  console.log('?? Receivables Result:', {
    total,
    paid,
    outstanding,
    status
  });

  if (total !== testTotal) {
    throw new Error(`Expected total ${testTotal}, got ${total}`);
  }
  if (paid !== testTotal) {
    throw new Error(`Expected paid ${testTotal}, got ${paid}`);
  }
  if (outstanding !== 0) {
    throw new Error(`Expected outstanding 0, got ${outstanding}`);
  }
  if (status !== 'PAID') {
    throw new Error(`Expected status PAID, got ${status}`);
  }

  console.log('?? COUNTER BILLING -> PAYMENT -> RECEIVABLES FLOW TEST PASSED PERFECTLY!');
}

runTest()
  .catch((err) => {
    console.error('? Test failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
