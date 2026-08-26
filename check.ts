import prisma from "./src/lib/prisma";
async function main() {
  const po = await prisma.procurementOrder.findUnique({
    where: { poNumber: "PO-2026-0003" }
  });
  console.log("PO-2026-0003 Discount:", po?.discountAmount);
  console.log("PO-2026-0003 Total:", po?.totalAmount);
}
main();
