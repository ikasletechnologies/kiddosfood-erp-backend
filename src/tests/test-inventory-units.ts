import { InventoryService } from "../modules/inventory/inventory.service";
import prisma from "../lib/prisma";
import { StockMovementType } from "@prisma/client";

async function runTests() {
  console.log("Setting up Inventory test data...");

  const mWeight = await prisma.inventoryItem.create({
    data: { name: "Inv Test Wheat", sku: "INVWHT", category: "RAW_MATERIAL", unit: "g", currentStock: 0, costPrice: 0.012, isActive: true, minimumStock: 5000 }
  });

  const mVolume = await prisma.inventoryItem.create({
    data: { name: "Inv Test Milk", sku: "INVMLK", category: "RAW_MATERIAL", unit: "ml", currentStock: 0, costPrice: 0.05, isActive: true, minimumStock: 5000 }
  });

  console.log("=== Running Inventory Normalization Tests ===");

  try {
    // 1. Receive 10 KG -> 10,000 G
    console.log("Test 1: Receive 10 KG -> 10,000 G");
    await InventoryService.stockIn({
      itemId: mWeight.id,
      quantity: 10,
      unit: "KG",
      type: StockMovementType.PURCHASE_IN,
      note: "Test Receipt"
    });
    
    let updatedMWeight = await prisma.inventoryItem.findUnique({ where: { id: mWeight.id } });
    console.log(`Expected Stock: 10000 | Actual: ${updatedMWeight?.currentStock}`);
    if (updatedMWeight?.currentStock !== 10000) throw new Error("Test 1 Failed");
    console.log("Test 1 Passed");

    // 2. Consume 0.5 KG -> 9,500 G
    console.log("Test 2: Consume 0.5 KG -> 9,500 G");
    await InventoryService.stockOut({
      itemId: mWeight.id,
      quantity: 0.5,
      unit: "KG",
      type: StockMovementType.PRODUCTION_OUT,
      note: "Test Consumption"
    });

    updatedMWeight = await prisma.inventoryItem.findUnique({ where: { id: mWeight.id } });
    console.log(`Expected Stock: 9500 | Actual: ${updatedMWeight?.currentStock}`);
    if (updatedMWeight?.currentStock !== 9500) throw new Error("Test 2 Failed");
    console.log("Test 2 Passed");

    // 3. Consume 500 G -> 9,000 G
    console.log("Test 3: Consume 500 G -> 9,000 G");
    await InventoryService.stockOut({
      itemId: mWeight.id,
      quantity: 500,
      unit: "G", // Explicit base unit
      type: StockMovementType.PRODUCTION_OUT,
      note: "Test Consumption 2"
    });

    updatedMWeight = await prisma.inventoryItem.findUnique({ where: { id: mWeight.id } });
    console.log(`Expected Stock: 9000 | Actual: ${updatedMWeight?.currentStock}`);
    if (updatedMWeight?.currentStock !== 9000) throw new Error("Test 3 Failed");
    console.log("Test 3 Passed");

    // 4. Consume 100 (No unit) -> 8,900 G (Implicit base unit)
    console.log("Test 4: Consume 100 (Implicit) -> 8,900 G");
    await InventoryService.stockOut({
      itemId: mWeight.id,
      quantity: 100,
      type: StockMovementType.PRODUCTION_OUT,
      note: "Test Consumption 3"
    });

    updatedMWeight = await prisma.inventoryItem.findUnique({ where: { id: mWeight.id } });
    console.log(`Expected Stock: 8900 | Actual: ${updatedMWeight?.currentStock}`);
    if (updatedMWeight?.currentStock !== 8900) throw new Error("Test 4 Failed");
    console.log("Test 4 Passed");

    // 5. Incompatible Unit Rejection
    console.log("Test 5: Receive ML into G item -> Error");
    let failed = false;
    try {
      await InventoryService.stockIn({
        itemId: mWeight.id,
        quantity: 10,
        unit: "ML",
        type: StockMovementType.PURCHASE_IN,
      });
    } catch (e: any) {
      if (e.message.includes("Unit conversion failed")) failed = true;
    }
    if (!failed) throw new Error("Test 5 Failed");
    console.log("Test 5 Passed");

    // 6. Threshold testing
    console.log("Test 6: Verify minimumStock logic using canonical units");
    const stockReport = await InventoryService.getInventory(undefined, false, undefined, undefined, undefined);
    const mWeightReport = stockReport.find(i => i.id === mWeight.id);
    console.log(`Current Stock: ${mWeightReport?.currentStock}, Minimum: 5000, Status: ${mWeightReport?.status}`);
    // 8900 >= 5000, should be SAFE
    if (mWeightReport?.status !== 'SAFE') throw new Error("Test 6.1 Failed");

    await InventoryService.stockOut({
      itemId: mWeight.id,
      quantity: 5000,
      type: StockMovementType.PRODUCTION_OUT,
    }); // 8900 - 5000 = 3900

    const stockReport2 = await InventoryService.getInventory(undefined, false, undefined, undefined, undefined);
    const mWeightReport2 = stockReport2.find(i => i.id === mWeight.id);
    console.log(`Current Stock: ${mWeightReport2?.currentStock}, Minimum: 5000, Status: ${mWeightReport2?.status}`);
    // 3900 <= 5000, should be LOW
    if (mWeightReport2?.status !== 'LOW') throw new Error("Test 6.2 Failed");
    console.log("Test 6 Passed");

    console.log("=== All Tests Passed ===");

  } catch (error) {
    console.error("Test execution failed:", error);
  } finally {
    console.log("Cleaning up...");
    await prisma.stockMovement.deleteMany({ where: { item: { sku: { startsWith: "INV" } } } });
    await prisma.inventoryItem.deleteMany({ where: { sku: { startsWith: "INV" } } });
    await prisma.$disconnect();
  }
}

runTests();
