import prisma from '../../lib/prisma';
import { AnalyticsService } from '../../modules/analytics/analytics.service';
import { POSService } from '../../modules/pos/pos.service';

/**
 * Verification Script for Phase 7: Advanced Reporting & Analytics
 * RUN: npx ts-node src/tests/sales/order-verification.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 7 Verification...');

  try {
    const franchiseId = 'root-franchise';
    
    // 1. Setup Test Data
    console.log('📦 Setting up Test Data...');
    const product1 = await prisma.product.findFirst({ where: { name: 'Burger' } }) || 
                     await prisma.product.create({ data: { name: 'Burger', basePrice: 100, is_menu_item: true } });
    
    const product2 = await prisma.product.findFirst({ where: { name: 'Fries' } }) || 
                     await prisma.product.create({ data: { name: 'Fries', basePrice: 50, is_menu_item: true } });

    const invItem = await prisma.inventoryItem.findFirst() || await prisma.inventoryItem.create({
        data: {
            name: 'Raw Potato',
            sku: 'POTATO-001',
            category: 'RAW_MATERIAL',
            currentStock: 100,
            unit: 'kg',
            franchiseId
        }
    });

    // 2. CREATE SALES (CASH vs UPI)
    console.log('💰 Creating Sales...');
    
    // Sale 1: Burger (Cash)
    const order1 = await POSService.createOrder({ franchiseId });
    await POSService.addItemsToOrder(order1.id, [{ productId: product1.id, quantity: 2 }]);
    await POSService.addPayment(order1.id, { paymentMode: 'CASH', paidAmount: 210 });
    await POSService.updateOrderStatus(order1.id, 'COMPLETED');

    // Sale 2: Fries (UPI)
    const order2 = await POSService.createOrder({ franchiseId });
    await POSService.addItemsToOrder(order2.id, [{ productId: product2.id, quantity: 4 }]);
    await POSService.addPayment(order2.id, { paymentMode: 'UPI', paidAmount: 210 });
    await POSService.updateOrderStatus(order2.id, 'COMPLETED');

    // 3. CREATE WASTAGE (REMOVED)
    console.log('🗑️ Skipping Wastage (Model deleted)...');

    // 4. FETCH ANALYTICS
    console.log('📊 Fetching Analytics...');
    
    const productPerformance = await AnalyticsService.getProductPerformance({});
    console.log('Product Performance:', productPerformance);

    const payments = await AnalyticsService.getPaymentDistribution({});
    console.log('Payment Distribution:', payments);

    const wastage = await AnalyticsService.getWastageSummary({});
    console.log('Wastage Summary:', wastage);

    const daily = await AnalyticsService.getDailySalesSummary({});
    console.log('Daily Summary:', daily);

    // 5. VALIDATE
    const burgerStat = productPerformance.find(p => p.name === 'Burger');
    const cashStat = payments.find(p => p.mode === 'CASH');

    if (!burgerStat || burgerStat.quantity < 2) throw new Error('Burger quantity mismatch');
    if (!cashStat || cashStat.total < 210) throw new Error('Cash total mismatch');

    console.log('🌟 PHASE 7 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
