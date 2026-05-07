import prisma from '../src/lib/prisma';

async function wipe() {
  console.log('🧹 Wiping all accounts from database...');
  try {
    const result = await prisma.account.deleteMany();
    console.log(`✅ SUCCESS: Deleted ${result.count} accounts.`);
  } catch (err: any) {
    console.error('❌ ERROR:', err.message);
  }
}

wipe();
