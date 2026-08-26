import prisma from '../lib/prisma';
import { PurchaseService } from '../modules/purchase/purchase.service';
import { InventoryService } from '../modules/inventory/inventory.service';

async function verifyPurchaseReturns() {
  console.log("=== Running Purchase Return Verification ===");
  
  // 1. Setup Test Data
  const vendor = await prisma.vendor.create({
    data: { name: "PR Test Vendor", email: "prtest@vendor.com", contact: "1234567890", address: "123 Test St" }
  });
  
  // Create an item with 'g' as canonical unit to test KG -> G conversion
  const testItem = await prisma.inventoryItem.create({
    data: { name: "PR Test Rice", sku: "PRRICE01", category: "RAW_MATERIAL", unit: "g", currentStock: 10000, costPrice: 0.01, isActive: true, minimumStock: 5000 }
  });

  try {
    // === Case 1: GRN Rejection Return ===
    console.log("\n--- Testing Case 1: GRN Rejection Return ---");
    
    // Initial Stock
    const initialStock1 = await InventoryService.computeStock(testItem.id);
    console.log(`Initial Stock before GRN Rejection Return: ${initialStock1} g`);
    
    // Simulate auto-generated PR from GRN (frontend passes returnSource: GRN_REJECTION)
    const grnPr = await PurchaseService.createPurchaseReturn({
      vendorId: vendor.id,
      reason: "AUTO-GENERATED FROM GRN REJECTION",
      returnSource: "GRN_REJECTION",
      items: [
        { itemName: testItem.name, quantity: 2, unit: "kg", rate: 10 }
      ]
    });
    
    // Complete the PR
    await PurchaseService.updatePurchaseReturn(grnPr.id, { status: "COMPLETED" });
    
    const postGrnPrStock = await InventoryService.computeStock(testItem.id);
    console.log(`Stock after GRN Rejection Return Completed: ${postGrnPrStock} g`);
    
    if (postGrnPrStock !== initialStock1) {
       console.error("❌ FAILED: GRN Rejection return modified inventory stock!");
    } else {
       console.log("✅ SUCCESS: GRN Rejection return correctly ignored inventory.");
    }
    
    // Check Vendor Ledger
    const grnLedger = await prisma.vendorLedger.findFirst({ where: { referenceId: grnPr.id, type: 'DEBIT' } });
    if (grnLedger?.amount === 20) {
      console.log("✅ SUCCESS: Vendor Ledger correctly debited ₹20.");
    } else {
      console.error("❌ FAILED: Vendor Ledger debit incorrect or missing.");
    }

    // === Case 2: Manual Return (KG converted to G) ===
    console.log("\n--- Testing Case 2: Manual Return (Unit Conversion) ---");
    
    const initialStock2 = await InventoryService.computeStock(testItem.id);
    console.log(`Initial Stock before Manual Return: ${initialStock2} g`);
    
    const manualPr = await PurchaseService.createPurchaseReturn({
      vendorId: vendor.id,
      reason: "Damaged Goods",
      returnSource: "MANUAL",
      items: [
        { itemName: testItem.name, quantity: 3, unit: "kg", rate: 10 } // Returning 3 KG
      ]
    });
    
    await PurchaseService.updatePurchaseReturn(manualPr.id, { status: "COMPLETED" });
    
    const postManualPrStock = await InventoryService.computeStock(testItem.id);
    console.log(`Stock after Manual Return (3 KG) Completed: ${postManualPrStock} g`);
    
    // Should have deducted 3000 g
    if (postManualPrStock === initialStock2 - 3000) {
      console.log("✅ SUCCESS: Manual Return correctly deducted 3000 g (converted from 3 kg).");
    } else {
      console.error(`❌ FAILED: Manual Return deducted incorrect amount. Expected ${initialStock2 - 3000}, got ${postManualPrStock}`);
    }

  } catch (error) {
    console.error("Error during verification:", error);
  } finally {
    console.log("\nCleaning up test data...");
    await prisma.stockMovement.deleteMany({ where: { itemId: testItem.id } });
    await prisma.purchaseReturnItem.deleteMany({ where: { itemName: testItem.name } });
    await prisma.purchaseReturn.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.vendorLedger.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.inventoryItem.delete({ where: { id: testItem.id } });
    await prisma.vendor.delete({ where: { id: vendor.id } });
    await prisma.$disconnect();
  }
}

verifyPurchaseReturns();
