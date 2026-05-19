import dotenv from 'dotenv';
import path from 'path';

// 1. Explicitly load .env from the backend root folder BEFORE any database imports
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  // 2. Dynamically import prisma after process.env is configured
  const { default: prisma } = await import('../src/lib/prisma');

  const items = await prisma.inventoryItem.findMany();
  console.log('--- ALL INVENTORY ITEMS IN DATABASE ---');
  console.log(JSON.stringify(items, null, 2));
  
  const franchises = await prisma.franchise.findMany();
  console.log('--- ALL FRANCHISES IN DATABASE ---');
  console.log(JSON.stringify(franchises, null, 2));
  process.exit(0);
}

main().catch(console.error);
