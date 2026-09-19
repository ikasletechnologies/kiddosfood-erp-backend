import prisma from '../lib/prisma';

async function main() {
  const poItems = await prisma.procurementOrderItem.findMany({
    include: {
      inventoryItem: true,
      procurementOrder: true
    }
  });
  console.log(`Total PO items in DB: ${poItems.length}`);
  for (const pi of poItems) {
    console.log(`PO item: itemId=${pi.inventoryItemId}, name=${pi.inventoryItem?.name}, sku=${pi.inventoryItem?.sku}, itemCat=${pi.inventoryItem?.category}, poStatus=${pi.procurementOrder?.status}`);
  }

  const grnItems = await prisma.goodsReceiptItem.findMany({
    include: {
      inventoryItem: true,
      grn: true
    }
  });
  console.log(`\nTotal GRN items in DB: ${grnItems.length}`);
  for (const gi of grnItems) {
    console.log(`GRN item: id=${gi.id}, materialId=${gi.materialId}, name=${gi.inventoryItem?.name}, sku=${gi.inventoryItem?.sku}, itemCat=${gi.inventoryItem?.category}, acceptedQty=${gi.acceptedQty}, price=${gi.price}, grnStatus=${gi.grn?.status}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
