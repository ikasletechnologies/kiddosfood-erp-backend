import { ProcurementService } from "../modules/procurement/procurement.service";
import { GRNService } from "../modules/grn/grn.service";
import prisma from "../lib/prisma";

async function runTests() {
  console.log("Setting up GRN test data...");
  const vendor = await prisma.vendor.findFirst() || await prisma.vendor.create({
    data: { name: "Test Vendor GRN", email: "grn@test.com", phone: "1234567890", address: "123 Test St", balance: 0 }
  });

  const mWeight = await prisma.inventoryItem.create({
    data: { name: "GRN Wheat", sku: "GRNWHT", category: "RAW_MATERIAL", unit: "g", currentStock: 0, costPrice: 0.012, isActive: true, minimumStock: 5 }
  });

  const mVolume = await prisma.inventoryItem.create({
    data: { name: "GRN Milk", sku: "GRNMLK", category: "RAW_MATERIAL", unit: "ml", currentStock: 0, costPrice: 0.05, isActive: true, minimumStock: 5 }
  });

  console.log("=== Running GRN Normalization Tests ===");

  try {
    // 10 KG -> 10,000 G
    console.log("Test 1: 10 KG -> 10,000 G");
    const po1 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: mWeight.id, quantity: 10, price: 12, unit: "KG", gstRate: 0 }]
    });
    const grn1 = await GRNService.createFromPO(po1.id, {
      items: [{ materialId: mWeight.id, orderedQty: 10, receivedQty: 10, acceptedQty: 10, rejectedQty: 0, price: 12 }]
    });
    await GRNService.approve(grn1.id);
    const updatedMWeight1 = await prisma.inventoryItem.findUnique({ where: { id: mWeight.id } });
    console.log(`Expected Stock: 10000 | Actual: ${updatedMWeight1?.currentStock}`);
    if (updatedMWeight1?.currentStock !== 10000) throw new Error("Test 1 Failed");
    console.log("Test 1 Passed");

    // 500 G -> 500 G
    console.log("Test 2: 500 G -> 500 G");
    const po2 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: mWeight.id, quantity: 500, price: 12, unit: "G", gstRate: 0 }]
    });
    const grn2 = await GRNService.createFromPO(po2.id, {
      items: [{ materialId: mWeight.id, orderedQty: 500, receivedQty: 500, acceptedQty: 500, rejectedQty: 0, price: 12 }]
    });
    await GRNService.approve(grn2.id);
    const updatedMWeight2 = await prisma.inventoryItem.findUnique({ where: { id: mWeight.id } });
    console.log(`Expected Stock: 10500 | Actual: ${updatedMWeight2?.currentStock}`);
    if (updatedMWeight2?.currentStock !== 10500) throw new Error("Test 2 Failed");
    console.log("Test 2 Passed");

    // 10 L -> 10,000 ML
    console.log("Test 3: 10 L -> 10,000 ML");
    const po3 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: mVolume.id, quantity: 10, price: 50, unit: "L", gstRate: 0 }]
    });
    const grn3 = await GRNService.createFromPO(po3.id, {
      items: [{ materialId: mVolume.id, orderedQty: 10, receivedQty: 10, acceptedQty: 10, rejectedQty: 0, price: 50 }]
    });
    await GRNService.approve(grn3.id);
    const updatedMVolume = await prisma.inventoryItem.findUnique({ where: { id: mVolume.id } });
    console.log(`Expected Stock: 10000 | Actual: ${updatedMVolume?.currentStock}`);
    if (updatedMVolume?.currentStock !== 10000) throw new Error("Test 3 Failed");
    console.log("Test 3 Passed");

    // partial 6 KG + 4 KG -> 10,000 G
    console.log("Test 4: Partial 6 KG + 4 KG -> 10,000 G");
    const mWeight2 = await prisma.inventoryItem.create({
      data: { name: "GRN Wheat 2", sku: "GRNWHT2", category: "RAW_MATERIAL", unit: "g", currentStock: 0, costPrice: 0.012, isActive: true, minimumStock: 5 }
    });
    const po4 = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      items: [{ inventoryItemId: mWeight2.id, quantity: 10, price: 12, unit: "KG", gstRate: 0 }]
    });
    // Receive 6 KG
    const grn4_1 = await GRNService.createFromPO(po4.id, {
      items: [{ materialId: mWeight2.id, orderedQty: 10, receivedQty: 6, acceptedQty: 6, rejectedQty: 0, price: 12 }]
    });
    await GRNService.approve(grn4_1.id);
    let checkWeight = await prisma.inventoryItem.findUnique({ where: { id: mWeight2.id } });
    console.log(`After GRN1 Expected: 6000 | Actual: ${checkWeight?.currentStock}`);
    if (checkWeight?.currentStock !== 6000) throw new Error("Test 4.1 Failed");

    // Receive 4 KG
    const grn4_2 = await GRNService.createFromPO(po4.id, {
      items: [{ materialId: mWeight2.id, orderedQty: 4, receivedQty: 4, acceptedQty: 4, rejectedQty: 0, price: 12 }]
    });
    await GRNService.approve(grn4_2.id);
    checkWeight = await prisma.inventoryItem.findUnique({ where: { id: mWeight2.id } });
    console.log(`After GRN2 Expected: 10000 | Actual: ${checkWeight?.currentStock}`);
    if (checkWeight?.currentStock !== 10000) throw new Error("Test 4.2 Failed");
    console.log("Test 4 Passed");

    // Rejections are handled by the unit engine which throws errors at PO creation
    // However we'll ensure they are rejected.
    console.log("Test 5: KG -> ML rejected");
    let failed = false;
    try {
      await ProcurementService.createPurchaseOrder({
        vendorId: vendor.id,
        items: [{ inventoryItemId: mVolume.id, quantity: 10, price: 12, unit: "KG", gstRate: 0 }]
      });
    } catch (e: any) {
      if (e.message.includes("Unit mismatch")) failed = true;
    }
    if (!failed) throw new Error("Test 5 Failed");
    console.log("Test 5 Passed");

    console.log("Test 6: G -> ML rejected");
    failed = false;
    try {
      await ProcurementService.createPurchaseOrder({
        vendorId: vendor.id,
        items: [{ inventoryItemId: mVolume.id, quantity: 500, price: 12, unit: "G", gstRate: 0 }]
      });
    } catch (e: any) {
      if (e.message.includes("Unit mismatch")) failed = true;
    }
    if (!failed) throw new Error("Test 6 Failed");
    console.log("Test 6 Passed");

    console.log("Test 7: PCS -> KG rejected");
    failed = false;
    try {
      await ProcurementService.createPurchaseOrder({
        vendorId: vendor.id,
        items: [{ inventoryItemId: mWeight.id, quantity: 10, price: 12, unit: "PCS", gstRate: 0 }]
      });
    } catch (e: any) {
      if (e.message.includes("Unit mismatch")) failed = true;
    }
    if (!failed) throw new Error("Test 7 Failed");
    console.log("Test 7 Passed");

    console.log("=== All Tests Passed ===");

  } catch (error) {
    console.error("Test execution failed:", error);
  } finally {
    console.log("Cleaning up...");
    await prisma.inventoryBatch.deleteMany({});
    await prisma.stockMovement.deleteMany({});
    await prisma.vendorInvoice.deleteMany({});
    await prisma.goodsReceiptItem.deleteMany({});
    await prisma.goodsReceipt.deleteMany({});
    await prisma.procurementOrderItem.deleteMany({});
    await prisma.procurementOrder.deleteMany({});
    await prisma.vendorInvoice.deleteMany({});
    await prisma.vendorLedger.deleteMany({});
    await prisma.inventoryItem.deleteMany({ where: { sku: { startsWith: "GRN" } } });
    await prisma.$disconnect();
  }
}

runTests();
