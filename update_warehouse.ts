import prisma from './src/lib/prisma';
async function run() {
  try {
    const franchiseId = "b289238d-5493-4d0f-a72a-fd433fd2190f";
    const hariHomeId = "032de70d-5597-401a-a185-00ca7d5babe5"; // From my previous run

    const before = await prisma.franchise.findUnique({
      where: { id: franchiseId },
      include: { primaryWarehouse: true }
    });

    console.log("=== BEFORE ===");
    console.log("Primary Warehouse ID:", before?.primaryWarehouseId);
    console.log("Primary Warehouse Name:", before?.primaryWarehouse?.name);

    await prisma.franchise.update({
      where: { id: franchiseId },
      data: { primaryWarehouseId: hariHomeId }
    });

    const after = await prisma.franchise.findUnique({
      where: { id: franchiseId },
      include: { primaryWarehouse: true }
    });

    console.log("\n=== AFTER ===");
    console.log("Primary Warehouse ID:", after?.primaryWarehouseId);
    console.log("Primary Warehouse Name:", after?.primaryWarehouse?.name);

    // Verify stock
    const hariBatches = await prisma.inventoryBatch.count({ where: { warehouseId: hariHomeId } });
    const hariMovements = await prisma.stockMovement.count({ where: { warehouseId: hariHomeId } });

    console.log("\n=== HARI HOME STOCK VERIFICATION ===");
    console.log("Inventory Batches:", hariBatches);
    console.log("Stock Movements:", hariMovements);

  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
