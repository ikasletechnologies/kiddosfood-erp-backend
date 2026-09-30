const { PrismaClient } = require('@prisma/client'); 
const prisma = new PrismaClient(); 
prisma.returnOrder.findFirst({ where: { returnNumber: 'SR0000000002' }, include: { items: true } }).then(r => console.log(JSON.stringify(r.items, null, 2))).finally(() => prisma.$disconnect());
