import prisma from '../src/lib/prisma';

console.log('--- Models available on Prisma Client ---');
const keys = Object.keys(prisma).filter(
  k => !k.startsWith('_') && typeof (prisma as any)[k] === 'object' && (prisma as any)[k] !== null
);
console.log(JSON.stringify(keys, null, 2));
process.exit(0);
