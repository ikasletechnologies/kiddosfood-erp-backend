import prisma from '../../lib/prisma';
import { POSService } from '../../modules/pos/pos.service';
import { FinanceService } from '../../modules/finance/finance.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING FULL POS COUNTER BILLING -> TAX INVOICE TEST');
  console.log('====================================================\n');

  // 1. Get or setup HQ Franchise
  const hq = await FranchiseService.getHqFranchise();
  console.log(`📍 Franchise Context: ${hq.name} (${hq.id})`);

  // 2. Setup or find real active Customer
  let customer = await prisma.customer.findFirst({ where: { franchiseId: hq.id } });
  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        name: 'POS Test Customer',
        phone: `98765${Math.floor(10000 + Math.random() * 90000)}`,
        franchiseId: hq.id,
        address: '123 Retail Lane, Chennai',
        city: 'Chennai',
        state: 'Tamil Nadu'
      }
    });
  }
  console.log(`👤 Customer: ${customer.name} (${customer.id})`);

  // 3. Setup or find active Product & Inventory Item with stock
  const uniqueCode = `POS-ITEM-${Date.now()}`;
  const invScopeId = await FranchiseService.toInventoryScopeId(prisma, hq.id);

  const inventoryItem = await prisma.inventoryItem.create({
    data: {
      name: `POS Test Product ${Date.now()}`,
      sku: uniqueCode,
      category: 'FINISHED_GOOD',
      currentStock: 100,
      unit: 'PCS',
      costPrice: 50,
      customerPrice: 1000,
      basePrice: 1000,
      gstRate: 5,
      franchiseId: invScopeId
    }
  });

  const product = await prisma.product.create({
    data: {
      name: inventoryItem.name,
      sku: uniqueCode,
      productType: 'FINISHED_GOOD',
      category: 'FINISHED_GOOD',
      basePrice: 1000,
      taxPercent: 5,
      isActive: true,
      is_menu_item: false
    }
  });
  console.log(`📦 Product created: ${product.name} (SKU: ${product.sku}, Stock: ${inventoryItem.currentStock})`);

  // 4. Setup Payment Account
  let account = await prisma.account.findFirst({
    where: { type: 'CASH', franchiseId: hq.id }
  });
  if (!account) {
    account = await prisma.account.create({
      data: {
        name: 'Counter Cash Box',
        type: 'CASH',
        balance: 10000,
        franchiseId: hq.id
      }
    });
  }
  console.log(`💳 Payment Account: ${account.name} (Balance: ₹${account.balance})`);

  const initialStock = inventoryItem.currentStock;
  const initialAccountBalance = account.balance;

  // 5. Perform POS Counter Billing Checkout
  const qtyToBuy = 2;
  const unitPrice = 1000;
  const subTotal = qtyToBuy * unitPrice; // ₹2,000
  const taxAmount = Number((subTotal * 0.05).toFixed(2)); // ₹100 (5% GST)
  const discountAmount = 0;
  const totalAmount = subTotal + taxAmount - discountAmount; // ₹2,100

  console.log('\n--- 🛒 Executing Counter Billing Checkout ---');
  console.log(`   Items: ${qtyToBuy}x ₹${unitPrice}`);
  console.log(`   Subtotal: ₹${subTotal}`);
  console.log(`   Tax (5%): ₹${taxAmount}`);
  console.log(`   Grand Total: ₹${totalAmount}`);

  const orderResult = await POSService.checkout({
    franchiseId: hq.id,
    customerId: customer.id,
    customerName: customer.name,
    accountId: account.id,
    paymentMode: 'CASH',
    items: [
      {
        productId: product.id,
        quantity: qtyToBuy,
        price: unitPrice,
        taxPercent: 5
      }
    ],
    subTotal,
    taxAmount,
    discountAmount,
    totalAmount
  });

  console.log('\n--- 🔍 Verifying Order & Tax Invoice Database Records ---');
  console.log(`   Order ID: ${orderResult.id}`);
  console.log(`   Invoice Number: ${orderResult.invoiceNum}`);
  console.log(`   Order Status: ${orderResult.status}`);
  console.log(`   Payment Status: ${orderResult.paymentStatus}`);

  // Verification 1: Order invoice number pattern INV-YYYY-XXXXX
  const invoiceNumPattern = /^INV-\d{4}-\d{5}$/;
  if (!invoiceNumPattern.test(orderResult.invoiceNum)) {
    throw new Error(`Invoice number "${orderResult.invoiceNum}" does not match format INV-YYYY-XXXXX!`);
  }
  console.log(`   ✅ Invoice number is sequentially generated: ${orderResult.invoiceNum}`);

  // Verification 2: Order fields
  if (orderResult.status !== 'COMPLETED' || orderResult.paymentStatus !== 'PAID') {
    throw new Error(`Expected Order to be COMPLETED and PAID, got ${orderResult.status}/${orderResult.paymentStatus}`);
  }
  if (!orderResult.inventory_deducted) {
    throw new Error('Expected Order inventory_deducted to be true!');
  }
  console.log('   ✅ Order recorded as COMPLETED and PAID with inventory_deducted=true');

  // Verification 3: Tax Invoice record
  const invoice = await prisma.invoice.findUnique({
    where: { orderId: orderResult.id },
    include: { payments: true, order: true }
  });

  if (!invoice) {
    throw new Error(`Tax Invoice record NOT found for order ${orderResult.id}!`);
  }
  console.log(`   ✅ Tax Invoice record exists (ID: ${invoice.id})`);

  if (invoice.totalAmount !== subTotal) {
    throw new Error(`Invoice totalAmount mismatch: Expected ₹${subTotal}, got ₹${invoice.totalAmount}`);
  }
  if (invoice.taxAmount !== taxAmount) {
    throw new Error(`Invoice taxAmount mismatch: Expected ₹${taxAmount}, got ₹${invoice.taxAmount}`);
  }
  if (invoice.finalAmount !== totalAmount) {
    throw new Error(`Invoice finalAmount mismatch: Expected ₹${totalAmount}, got ₹${invoice.finalAmount}`);
  }
  if (invoice.status !== 'PAID') {
    throw new Error(`Invoice status mismatch: Expected PAID, got ${invoice.status}`);
  }
  console.log('   ✅ Tax Invoice amounts match exactly: Subtotal, Tax, Total, Status=PAID');

  // Verification 4: Payment linkage
  const payments = await prisma.payment.findMany({
    where: { orderId: orderResult.id }
  });

  if (payments.length !== 1) {
    throw new Error(`Expected exactly 1 payment record, found ${payments.length}`);
  }

  const payment = payments[0];
  console.log(`   Payment ID: ${payment.id}, Number: ${payment.paymentNumber}`);
  if (payment.invoiceId !== invoice.id) {
    throw new Error(`Payment.invoiceId (${payment.invoiceId}) does not match Invoice.id (${invoice.id})!`);
  }
  if (payment.paidAmount !== totalAmount) {
    throw new Error(`Payment.paidAmount (₹${payment.paidAmount}) does not match Total (₹${totalAmount})!`);
  }
  if (payment.status !== 'PAID') {
    throw new Error(`Payment.status (${payment.status}) is not PAID!`);
  }
  console.log('   ✅ Payment is directly linked to both Order ID and Invoice ID with full amount ₹' + payment.paidAmount);

  // Verification 5: Receivables calculation
  console.log('\n--- 📊 Verifying Accounts Receivable View ---');
  const invoicesList = await FinanceService.getInvoices(hq.id);
  const matchedInvoice: any = invoicesList.find(inv => inv.id === invoice.id || inv.orderId === orderResult.id);

  if (!matchedInvoice) {
    throw new Error('Invoice not found in FinanceService.getInvoices()!');
  }

  const recTotal = Number(matchedInvoice.finalAmount ?? matchedInvoice.totalAmount ?? 0);
  const recPaidSum = matchedInvoice.payments?.reduce((s: number, p: any) => {
    if (p.isCancelled || (p.status && p.status !== 'PAID' && p.status !== 'SUCCESS')) return s;
    return s + Number(p.paidAmount ?? 0);
  }, 0) || 0;
  const recPaid = Number(matchedInvoice.paidAmount ?? (recPaidSum > 0 ? recPaidSum : (matchedInvoice.status === 'PAID' ? recTotal : 0)));
  const recOutstanding = Math.max(0, recTotal - recPaid);
  const recStatus = recOutstanding <= 0.01 ? 'PAID' : (recPaid > 0 ? 'PARTIAL' : 'UNPAID');

  console.log(`   Receivables Total: ₹${recTotal}`);
  console.log(`   Receivables Paid: ₹${recPaid}`);
  console.log(`   Receivables Outstanding: ₹${recOutstanding}`);
  console.log(`   Receivables Status: ${recStatus}`);

  if (recOutstanding !== 0 || recStatus !== 'PAID' || recPaid !== totalAmount) {
    throw new Error(`Receivable calculation incorrect! Outstanding: ₹${recOutstanding}, Status: ${recStatus}`);
  }
  console.log('   ✅ Receivables shows: Paid Amount = ₹' + recPaid + ', Outstanding = ₹0.00, Status = PAID');

  // Verification 6: Inventory deduction
  console.log('\n--- 📦 Verifying Inventory Movement (Single Deduction) ---');
  const updatedInvItem = await prisma.inventoryItem.findUnique({
    where: { id: inventoryItem.id }
  });
  const movements = await prisma.stockMovement.findMany({
    where: { itemId: inventoryItem.id, referenceId: orderResult.id }
  });

  console.log(`   Initial Stock: ${initialStock}`);
  console.log(`   New Stock: ${updatedInvItem?.currentStock}`);
  console.log(`   Stock Movements count for this order: ${movements.length}`);

  if (movements.length !== 1) {
    throw new Error(`Expected exactly 1 stock movement for order, found ${movements.length}`);
  }
  if (updatedInvItem?.currentStock !== initialStock - qtyToBuy) {
    throw new Error(`Expected stock to be ${initialStock - qtyToBuy}, got ${updatedInvItem?.currentStock}`);
  }
  console.log(`   ✅ Inventory reduced exactly once by ${qtyToBuy} PCS (from ${initialStock} to ${updatedInvItem?.currentStock})`);

  // Verification 7: Sales -> Tax Invoice retrieval by ID and Search
  console.log('\n--- 📑 Verifying Tax Invoice API Retrieval & Filtering ---');
  const fetchedById = await FinanceService.getInvoiceById(invoice.id);
  if (!fetchedById || fetchedById.id !== invoice.id) {
    throw new Error('Failed to retrieve Tax Invoice by ID via FinanceService.getInvoiceById()');
  }
  console.log(`   ✅ getInvoiceById() successfully retrieved invoice: ${fetchedById.order?.invoiceNum}`);

  const searchResults = await FinanceService.getInvoices({
    franchiseId: hq.id,
    search: orderResult.invoiceNum
  });
  if (searchResults.length === 0 || searchResults[0].id !== invoice.id) {
    throw new Error('Failed to search invoice by number via FinanceService.getInvoices()');
  }
  console.log(`   ✅ Search filter successfully found invoice: ${searchResults[0].order?.invoiceNum}`);

  // 6. Cleanup test records
  console.log('\n--- 🧹 Cleaning up Test Artifacts ---');
  await prisma.payment.deleteMany({ where: { orderId: orderResult.id } });
  await prisma.customerLedger.deleteMany({ where: { referenceId: orderResult.id } });
  await prisma.invoice.deleteMany({ where: { orderId: orderResult.id } });
  await prisma.orderItem.deleteMany({ where: { orderId: orderResult.id } });
  await prisma.stockMovement.deleteMany({ where: { referenceId: orderResult.id } });
  await prisma.order.deleteMany({ where: { id: orderResult.id } });
  await prisma.product.deleteMany({ where: { id: product.id } });
  await prisma.inventoryItem.deleteMany({ where: { id: inventoryItem.id } });
  console.log('   ✅ Test data cleaned up successfully.');

  console.log('\n====================================================');
  console.log('🎉 ALL 25 CRITERIA PASSED: POS COUNTER BILLING TAX INVOICE FLOW IS VERIFIED PERFECT!');
  console.log('====================================================');
}

main()
  .catch((e) => {
    console.error('❌ Test failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
