import prisma from '../../lib/prisma';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { InspectionService } from '../../modules/grn/inspection.service';

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
      name: `Test Sugar ${Date.now()}`,
      sku: `SUGAR-${Date.now()}`,
      category: 'RAW_MATERIAL',
      initialStock: 100, // 100g
      unit: 'g',
      franchiseId
    });
    console.log(`✅ Created Material: ${material.name} (Stock: ${material.currentStock}g)`);

    // 2. Create Supplier
    console.log('🚛 Creating Supplier...');
    const supplier = await ProcurementService.createVendor({
      name: 'Sugar Supplier Ltd',
      contact: '9876543210',
      email: 'sugar@supplies.com',
      address: '123 Sugar Street, Candy Land'
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

    // 4. Receive Goods (Triggering GRN / QC Pending)
    console.log('⏳ Receiving Goods (Triggering GRN Logic)...');
    const updatedPO = await ProcurementService.receiveGoods(po.id);

    if (!updatedPO || !updatedPO.received || updatedPO.status !== 'RECEIVED') {
      throw new Error('PO status update failed!');
    }
    
    const updatedMaterialHold = await prisma.inventoryItem.findUnique({ where: { id: material.id } });
    console.log(`📊 Stock after Receiving (QC Pending): ${updatedMaterialHold?.currentStock}g (Expected: 100g)`);

    if (updatedMaterialHold?.currentStock !== 100) {
      throw new Error('Stock immediately increased without QC passing!');
    }

    // Load the created GRN and grn item
    const grn = await prisma.goodsReceipt.findFirst({
      where: { poId: po.id },
      include: { items: true }
    });
    if (!grn || grn.items.length === 0) {
      throw new Error('GRN or GRN items not found!');
    }

    const grnItem = grn.items[0];
    console.log(`🔍 GRN Item qcStatus: ${grnItem.qcStatus} (Expected: PENDING)`);
    if (grnItem.qcStatus !== 'PENDING') {
      throw new Error('GRN Item is not PENDING QC!');
    }

    // 5. Perform QC Pass
    console.log('🧪 Performing QC Pass (Approving 500g)...');
    await InspectionService.recordInspection({
      grnItemId: grnItem.id,
      approvedQty: 500,
      rejectedQty: 0,
      actionTaken: 'APPROVE',
      remarks: 'Passed all quality parameters.'
    });

    const updatedMaterialPassed = await prisma.inventoryItem.findUnique({ where: { id: material.id } });
    console.log(`📊 Stock after QC Pass: ${updatedMaterialPassed?.currentStock}g (Expected: 600g)`);

    if (updatedMaterialPassed?.currentStock !== 600) {
      throw new Error('Stock increase failed after QC pass!');
    }

    // 6. Verify Prevent Double QC Inspection
    console.log('🏁 Attempting Double QC Inspection (Should Fail)...');
    try {
      await InspectionService.recordInspection({
        grnItemId: grnItem.id,
        approvedQty: 500,
        rejectedQty: 0,
        actionTaken: 'APPROVE',
        remarks: 'Attempting duplicate inspection.'
      });
      throw new Error('Double QC Inspection should have failed!');
    } catch (err) {
      console.log(`✅ Double QC Inspection correctly blocked: ${(err as Error).message}`);
    }

    console.log('🌟 PHASE 4 VERIFIED SUCCESSFULLY! 🌟');

  } catch (error) {
    console.error('❌ Verification Failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

verify();
