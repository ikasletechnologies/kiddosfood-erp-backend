import prisma from '../lib/prisma';

async function main() {
  const users = await prisma.user.findMany({
    include: { franchise: true, role: true }
  });
  console.log('--- USER LIST ---');
  users.forEach(u => {
    console.log(`Email: ${u.email} | Role: ${u.role.name} | Franchise: ${u.franchise?.name || 'NONE'}`);
  });
}

main().finally(() => prisma.$disconnect());
