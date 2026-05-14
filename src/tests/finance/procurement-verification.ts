import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { POSService } from '../../modules/pos/pos.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

/**
 * Verification Script for Phase 5: Accounts Module
 * RUN: npx ts-node src/tests/finance/procurement-verification.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 5 Verification...');

  try {
    const franchiseId = 'root-franchise';

    // 1. Setup Data
    console.log('📦 Setting up Material and Supplier...');
    const material = await InventoryService.createItem({
      name: 'Account Test Item',
      sku: `ACC-${Date.now()}`,
      category: 'RAW_MATERIAL',
      currentStock: 10,
      unit: 'kg',
      franchiseId
    });

    const supplier = await ProcurementService.createVendor({
      name: 'Account Supplier',
      contact: '123'
    });

    // 2. PURCHASE FLOW -> EXPENSE
    console.log('📝 Creating Purchase Order (Expense Test)...');
    const po = await ProcurementService.createPurchaseOrder({
      vendorId: supplier.id,
      items: [{ inventoryItemId: material.id, quantity: 10, price: 100 }] // Total 1000
    });

    console.log('⏳ Receiving Goods...');
    await ProcurementService.receiveGoods(po.id);
    
    const expenses = await prisma.expense.findFirst({
        where: { purchaseOrderId: po.id }
    });
    console.log(`✅ Automated Expense recorded: ₹${expenses?.amount} (Expected: 1000)`);

    // 3. SALES FLOW -> INVOICE
    console.log('🍔 Creating Product and Order (Sales Test)...');
    const product = await prisma.product.create({
        data: { name: 'Account Burger', basePrice: 200, is_menu_item: true }
    });

    const order = await POSService.createOrder({ franchiseId });
    await POSService.addItemsToOrder(order.id, [{ productId: product.id, quantity: 1 }]); // Subtotal 200

    console.log('🏁 Completing Order (Triggering Invoice)...');
    await POSService.updateOrderStatus(order.id, 'COMPLETED');

    const invoice = await prisma.invoice.findUnique({
        where: { orderId: order.id }
    });
    console.log(`✅ Automated Invoice created: ₹${invoice?.finalAmount} (Expected: 210, which is 200 + 5% GST)`);

    if (invoice?.taxAmount !== 10) {
        throw new Error(`Tax calculation wrong! Got ${invoice?.taxAmount}, expected 10`);
    }

    // 4. REPORT TEST
    console.log('📊 Fetching Profit/Loss Report...');
    const report = await FinanceService.getFinancialReport({});
    console.log('Report Summary:', report);

    if (report.revenue < 210 || report.expenses < 1000) {
        throw new Error('Report numbers are missing values from this test!');
    }

    console.log('🌟 PHASE 5 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
