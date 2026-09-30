import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.customer.findFirst({ where: { name: 'Harikrishna G' } }).then(c => console.log(c)).finally(() => prisma.$disconnect());
