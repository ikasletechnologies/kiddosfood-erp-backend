import prisma from './src/lib/prisma';

async function check() {
  const franchises = await prisma.franchise.findMany();
  console.log('Franchises in DB:', franchises.map(f => ({ id: f.id, name: f.name })));
}

check().finally(() => prisma.$disconnect());
//