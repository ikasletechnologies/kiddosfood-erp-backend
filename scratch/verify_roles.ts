import prisma from '../src/lib/prisma';

async function listUsers() {
  const users = await prisma.user.findMany({
    include: { role: true, franchise: true }
  });
  console.log('Users and Roles:');
  users.forEach(u => {
    console.log(`- [${u.id}] ${u.fullName} (${u.email}): Role=${u.role?.name}, Franchise=${u.franchise?.name}`);
  });
  await prisma.$disconnect();
}

listUsers();
