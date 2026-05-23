import prisma from './src/lib/prisma';

async function main() {
  const usersCount = await prisma.user.count();
  const tokensCount = await prisma.refreshToken.count();
  console.log({ usersCount, tokensCount });
}

main().catch(console.error).finally(() => prisma.$disconnect());
