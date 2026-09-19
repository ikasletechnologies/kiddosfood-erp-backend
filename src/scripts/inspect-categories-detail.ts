import prisma from '../lib/prisma';
async function main() {
  const orders = await prisma.order.findMany({
    where: { status: { notIn: ['CANCELLED'] } },
    include: {
      orderItems: {
        include: { product: true }
      }
    }
  });

  console.log(`=== ORDERS ANALYSIS ===`);
  for (const o of orders) {
    for (const oi of o.orderItems) {
      console.log(`Order ${o.id.slice(0, 8)} (${o.invoiceNum}): productId=${oi.productId}, prodName=${oi.product?.name}, prodCat=${oi.product?.category}, qty=${oi.quantity}, price=${oi.price}`);
    }
  }

  const purchases = await prisma.procurementOrder.findMany({
    where: { status: { notIn: ['CANCELLED'] } },
    include: {
      poItems: { include: { inventoryItem: true } },
      goodsReceipts: {
        where: { status: 'COMPLETED' },
        include: { items: { include: { inventoryItem: true } } }
      }
    }
  });

  console.log(`\n=== PURCHASES ANALYSIS ===`);
  for (const p of purchases) {
    for (const grn of p.goodsReceipts) {
      for (const gi of grn.items) {
        const poItem = p.poItems.find(pi => pi.inventoryItemId === gi.materialId);
        console.log(`GRN item ${gi.id.slice(0, 8)}: materialId=${gi.materialId}, invItemName=${gi.inventoryItem?.name}, invItemSku=${gi.inventoryItem?.sku}, invItemCat=${gi.inventoryItem?.category}, acceptedQty=${gi.acceptedQty}, price=${gi.price}`);
      }
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
