import dotenv from 'dotenv';
dotenv.config();

import prisma from '../lib/prisma';
import { seedRoles } from './seed/roles';
import { seedFranchises } from './seed/franchises';
import { seedUsers } from './seed/users';
import { seedMasterData } from './seed/master-data';

async function main() {
  console.log('🌱 Starting Master Seed...');

  // 1. Schema Consistency Check (Temporary until migrations are fully used)//
  console.log('🔄 Checking Schema Consistency...');
  try {
    await prisma.$executeRawUnsafe(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'InventoryItem' AND column_name = 'isActive') THEN
          ALTER TABLE "InventoryItem" ADD COLUMN "isActive" BOOLEAN DEFAULT true;
        END IF;
      END $$;
    `);
  } catch (e) {
    console.warn('⚠️ Schema check warning:', (e as any).message);
  }

  // 2. Run Modular Seeds
  const roleMap = await seedRoles();
  await seedFranchises();
  await seedUsers(roleMap);
  await seedMasterData();

  console.log('🚀 MASTER SEED COMPLETED SUCCESSFULLY!');
}

main()
  .catch((e) => {
    console.error('❌ Master Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
