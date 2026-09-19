import prisma from '../lib/prisma';

async function main() {
  // Check orders with FINISHED_GOOD or null category
  const orders = await prisma.order.findMany({
    include: { orderItems: { include: { product: true } } }
  });

  console.log('--- Orders Items with Technical or Uncategorized ---');
  for (const o of orders) {
    for (const item of o.orderItems) {
      const cat = item.product?.category;
      if (!cat || cat === 'FINISHED_GOOD' || cat === 'RAW_MATERIAL') {
        console.log('Order Item:', {
          orderId: o.id,
          productName: item.product?.name,
          productSku: item.product?.sku,
          category: cat,
          qty: item.quantity,
          amount: item.totalAmount
        });
      }
    }
  }

  // Check purchases
  const purchases = await prisma.procurementOrder.findMany({
    where: { status: { notIn: ['CANCELLED'] as any } },
    include: {
      poItems: { include: { inventoryItem: true } },
      goodsReceipts: {
        where: { status: 'COMPLETED' },
        include: { items: { include: { inventoryItem: true } } }
      }
    }
  });

  console.log('--- Purchases Items ---');
  for (const p of purchases) {
    for (const grn of p.goodsReceipts) {
      for (const item of grn.items) {
        if (!item.acceptedQty) continue;
        const invItem = item.inventoryItem;
        console.log('Purchased GRN item:', {
          inventoryItemId: item.materialId,
          name: invItem?.name,
          sku: invItem?.sku,
          invCategory: invItem?.category,
          qty: item.acceptedQty,
          price: item.price
        });
      }
    }
  }

  // Also check if any inventory items have matching products or other category fields
  const invItems = await prisma.inventoryItem.findMany({
    take: 5
  });
  if (invItems.length > 0) {
    console.log('Inventory item sample:', invItems[0]);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
