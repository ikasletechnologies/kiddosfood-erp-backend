import { PrismaClient } from './node_modules/@prisma/client/index.js';
const prisma = new PrismaClient();
prisma.customer.findFirst({ where: { name: 'Harikrishna G' } }).then(c => console.log('DB Customer Address:', c.address)).finally(() => prisma.$disconnect());
