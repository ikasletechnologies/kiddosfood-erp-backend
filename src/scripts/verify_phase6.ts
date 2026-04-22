import prisma from '../lib/prisma';
import { CRMService } from '../modules/crm/crm.service';
import { POSService } from '../modules/pos/pos.service';

/**
 * Verification Script for Phase 6: CRM (Customers & Leads)
 * RUN: npx ts-node src/scripts/verify_phase6.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 6 Verification...');

  try {
    const franchiseId = 'root-franchise';

    // 1. Setup Pipeline
    console.log('🏗️ Setting up Pipeline...');
    const pipeline = await CRMService.createPipeline({
      name: 'Retail Pipeline',
      stages: ['New', 'Contacted', 'Won', 'Lost']
    });

    // 2. CREATE LEAD
    console.log('📝 Creating Lead...');
    const lead = await CRMService.createLead({
      pipelineId: pipeline.id,
      contactName: 'Lead Customer',
      phone: `999${Math.floor(Math.random() * 1000000)}`, // Unique every time
      leadSource: 'Walk-in',
      status: 'NEW'
    });
    console.log('Lead created:', lead.id);

    // 3. CONVERT TO WON
    console.log('🏆 Converting Lead to WON...');
    // We use WON status which was added to enum
    await CRMService.updateLead(lead.id, { status: 'WON' as any });

    const customer = await prisma.customer.findUnique({
        where: { phone: lead.phone as string }
    });

    if (!customer) {
        throw new Error('Customer was NOT automatically created upon WON status!');
    }
    console.log('✅ Automated Customer conversion successful:', customer.id);

    // 4. GENERATE SALES DATA
    console.log('🍔 Generating Sales for Customer...');
    const product = await prisma.product.findFirst();
    if (!product) throw new Error('No products found to create order');

    const order = await POSService.createOrder({ franchiseId, customerId: customer.id });
    await POSService.addItemsToOrder(order.id, [{ productId: product.id, quantity: 2 }]);
    await POSService.updateOrderStatus(order.id, 'COMPLETED');

    // 5. CHECK HISTORY
    console.log('📊 Fetching Customer History...');
    const history = await CRMService.getCustomerSummary(customer.id);
    console.log('History Summary:', {
        name: history.customer.name,
        orderCount: history.orderCount,
        totalSpent: history.totalSpent
    });

    if (history.orderCount !== 1 || history.totalSpent === 0) {
        throw new Error('Customer history stats are incorrect!');
    }

    console.log('🌟 PHASE 6 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
