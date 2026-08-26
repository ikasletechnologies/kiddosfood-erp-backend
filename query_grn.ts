import prisma from './src/lib/prisma';

async function main() {
  const grns = await prisma.goodsReceipt.findMany({
    where: {
      id: "0739fee4-a1a8-422a-b03c-cd3b2667905b"
    },
    include: {
      items: {
        include: {
          inventoryItem: true
        }
      },
      procurementOrder: true
    }
  });

  const grn = grns[0];
  console.log("GRN ID:", grn.id);
  const riceItem = grn.items.find(i => i.inventoryItem?.name === 'Rice');
  if (riceItem) {
    console.log(`Rice Item ID: ${riceItem.id}`);
    console.log(`rejectedQty: ${riceItem.rejectedQty}`);

    // Let's check stock movements for this material linked to this GRN
    const movements = await prisma.stockMovement.findMany({
      where: {
        itemId: riceItem.materialId!,
        referenceId: grn.id
      }
    });
    console.log("Stock Movements for Rice associated with this GRN:");
    console.log(JSON.stringify(movements, null, 2));

    const batches = await prisma.inventoryBatch.findMany({
      where: {
        inventoryItemId: riceItem.materialId!
      }
    });
    // filter batches created around the same time or via stock movements
    const batchIdsFromMovements = movements.map(m => m.batchId).filter(Boolean);
    const relatedBatches = batches.filter(b => batchIdsFromMovements.includes(b.id));
    console.log("Inventory Batches for Rice associated with these movements:");
    console.log(JSON.stringify(relatedBatches, null, 2));

    // Check Purchase Return
    const prs = await prisma.purchaseReturn.findMany({
      where: {
        vendorId: grn.procurementOrder.vendorId
      },
      include: {
        items: true
      }
    });
    console.log("Purchase Returns for this vendor:");
    console.log(JSON.stringify(prs, null, 2));
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
