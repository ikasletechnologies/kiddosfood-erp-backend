import prisma from "./src/lib/prisma";
async function main() {
  const po = await prisma.procurementOrder.findUnique({
    where: { poNumber: "PO-2026-0002" }
  });
  console.log("PO Discount:", po?.discountAmount);
}
main();
