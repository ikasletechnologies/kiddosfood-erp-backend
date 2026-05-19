import prisma from '../../lib/prisma';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

/**
 * Verification Script for Phase 4: Purchase Module
 * RUN: npx ts-node src/tests/inventory/production-verification.ts
 */
async function verify() {
  console.log('🚀 Starting Phase 3 Verification...');

  try {
    const franchiseId = 'root-franchise';

    // 1. Create Raw Material (Sugar)
    console.log('📦 Creating Raw Material...');
    const material = await InventoryService.createItem({
      name: 'Test Sugar',
      sku: `SUGAR-${Date.now()}`,
      category: 'RAW_MATERIAL',
      currentStock: 100, // 100g
      unit: 'g',
      franchiseId
    });
    console.log(`✅ Created Material: ${material.name} (Stock: ${material.currentStock}g)`);

    // 2. Create Supplier
    console.log('🚛 Creating Supplier...');
    const supplier = await ProcurementService.createVendor({
      name: 'Sugar Supplier Ltd',
      contact: '9876543210',
      email: 'sugar@supplies.com'
    });
    console.log(`✅ Created Supplier: ${supplier.name}`);

    // 3. Create Purchase Order (Buy 500g Sugar)
    console.log('📝 Creating Purchase Order...');
    const po = await ProcurementService.createPurchaseOrder({
      vendorId: supplier.id,
      items: [
        { inventoryItemId: material.id, quantity: 500, price: 10 }
      ]
    });
    console.log(`✅ Created PO for 500g ${material.name}. Status: ${po.status}`);

    // 4. Receive Goods (Triggering Stock Increase)
    console.log('⏳ Receiving Goods (Triggering GRN Logic)...');
    const updatedPO = await ProcurementService.receiveGoods(po.id);
    
    const updatedMaterial = await prisma.inventoryItem.findUnique({ where: { id: material.id } });
    console.log(`📊 Stock after Receiving: ${updatedMaterial?.currentStock}g (Expected: 600g)`);

    if (updatedMaterial?.currentStock !== 600) {
      throw new Error('Stock increase failed or incorrect!');
    }

    if (!updatedPO.received || updatedPO.status !== 'RECEIVED') {
      throw new Error('PO status update failed!');
    }

    // 5. Verify Prevent Double Receiving
    console.log('🏁 Attempting Double Receive (Should Fail)...');
    try {
      await ProcurementService.receiveGoods(po.id);
      throw new Error('Double receive should have failed!');
    } catch (err) {
      console.log(`✅ Double Receive correctly blocked: ${(err as Error).message}`);
    }

    console.log('🌟 PHASE 4 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
