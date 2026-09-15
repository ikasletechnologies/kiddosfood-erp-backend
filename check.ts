import prisma from "./src/lib/prisma";
async function main() {
  const order = await prisma.order.findFirst({
    where: { invoiceNum: "INV-2026-00093" },
    include: { orderItems: { include: { product: true } } }
  });
  console.log("Order items:", JSON.stringify(order?.orderItems, null, 2));
}
main();
