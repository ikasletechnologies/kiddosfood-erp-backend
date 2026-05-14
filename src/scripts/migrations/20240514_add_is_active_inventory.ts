import prisma from '../lib/prisma';

async function migrate() {
  console.log('🚀 Running manual schema sync...');
  try {
    // Add isActive if missing
    await prisma.$executeRawUnsafe(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'InventoryItem' AND column_name = 'isActive') THEN
          ALTER TABLE "InventoryItem" ADD COLUMN "isActive" BOOLEAN DEFAULT true;
        END IF;
      END $$;
    `);
    console.log('✅ Column isActive verified/added to InventoryItem');
    
    // Add isActive to other models if needed later
  } catch (e) {
    console.error('❌ Migration failed:', e);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
