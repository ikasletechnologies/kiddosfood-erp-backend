import prisma from "./src/lib/prisma";
async function main() {
  // Health check
  const count = await prisma.returnOrder.count();
  console.log("Return order count:", count);
}
main();
