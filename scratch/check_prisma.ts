import prisma from '../src/lib/prisma';

async function check() {
  console.log('Available models:', Object.keys(prisma).filter(key => !key.startsWith('_') && !key.startsWith('$')));
  process.exit(0);
}

check();
