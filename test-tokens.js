const prisma = require('./src/lib/prisma').default;

async function main() {
  const tokens = await prisma.refreshToken.findMany();
  console.log(tokens);
}

main().catch(console.error).finally(() => prisma.$disconnect());
