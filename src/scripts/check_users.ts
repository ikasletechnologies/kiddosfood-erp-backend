import prisma from '../lib/prisma';

async function main() {
  const users = await prisma.user.findMany({
    include: { franchise: true }
  });
  console.log('--- USER LIST ---');
  users.forEach(u => {
    console.log(`Email: ${u.email} | Role: ${u.role} | Franchise: ${u.franchise?.name || 'NONE'}`);
  });
}

main().finally(() => prisma.$disconnect());
