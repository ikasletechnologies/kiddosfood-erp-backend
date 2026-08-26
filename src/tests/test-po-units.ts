import { ProcurementService } from "../modules/procurement/procurement.service";
import prisma from "../lib/prisma";

async function runTests() {
  console.log("Setting up test data...");
  const vendor = await prisma.vendor.findFirst() || await prisma.vendor.create({
    data: { name: "Test Vendor", email: "vendor@test.com", contact: "1234567890", address: "123 Test St" }
  });

  const materialWeight = await prisma.inventoryItem.create({
    data: { name: "Test Wheat", sku: "WHT01", category: "RAW_MATERIAL", unit: "kg", currentStock: 0, costPrice: 10, isActive: true, minimumStock: 5 }
  });

  const materialVolume = await prisma.inventoryItem.create({
    data: { name: "Test Milk", sku: "MLK01", category: "RAW_MATERIAL", unit: "L", currentStock: 0, costPrice: 50, isActive: true, minimumStock: 5 }
  });

  console.log("=== Running PO Regression Tests ===");
  
  try {
    console.log("Test 1: 10 KG x 12/KG -> 120");
    const po1 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: materialWeight.id, quantity: 10, price: 12, unit: "KG", gstRate: 0 }]
    });
    console.log(`Expected Total: 120 | Actual Total: ${po1.totalAmount}`);
    if (po1.totalAmount !== 120) throw new Error("Test 1 Failed");
    console.log("Test 1 Passed");

    console.log("Test 2: 500 G x 12/G -> 6000");
    const po2 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: materialWeight.id, quantity: 500, price: 12, unit: "G", gstRate: 0 }]
    });
    console.log(`Expected Total: 6000 | Actual Total: ${po2.totalAmount}`);
    if (po2.totalAmount !== 6000) throw new Error("Test 2 Failed");
    console.log("Test 2 Passed");

    console.log("Test 3: 1.5 KG x 100/KG -> 150");
    const po3 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: materialWeight.id, quantity: 1.5, price: 100, unit: "KG", gstRate: 0 }]
    });
    console.log(`Expected Total: 150 | Actual Total: ${po3.totalAmount}`);
    if (po3.totalAmount !== 150) throw new Error("Test 3 Failed");
    console.log("Test 3 Passed");

    console.log("Test 4: Incompatible Unit (KG -> ML)");
    let failed = false;
    try {
      await ProcurementService.createPurchaseOrder({
        vendorId: vendor.id,
        items: [{ inventoryItemId: materialVolume.id, quantity: 10, price: 10, unit: "KG", gstRate: 0 }]
      });
    } catch (e: any) {
      console.log(`Caught expected error: ${e.message}`);
      failed = true;
    }
    if (!failed) throw new Error("Test 4 Failed - did not reject incompatible units");
    console.log("Test 4 Passed");

    console.log("=== All Tests Passed ===");
  } catch (error) {
    console.error("Test execution failed:", error);
  } finally {
    console.log("Cleaning up...");
    await prisma.procurementOrderItem.deleteMany({});
    await prisma.procurementOrder.deleteMany({});
    await prisma.inventoryItem.deleteMany({ where: { id: { in: [materialWeight.id, materialVolume.id] } } });
    await prisma.$disconnect();
  }
}

runTests();
