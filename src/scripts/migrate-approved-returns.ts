import prisma from '../lib/prisma';

async function migrateApprovedReturns() {
  console.log('--- STARTING PURCHASE RETURN APPROVED -> COMPLETED MIGRATION ---');
  try {
    const approvedReturns = await prisma.purchaseReturn.findMany({
      where: { status: 'APPROVED' }
    });

    console.log(`Found ${approvedReturns.length} APPROVED purchase return(s) to migrate.`);

    for (const ret of approvedReturns) {
      console.log(`Migrating return ID: ${ret.id}, ReturnNo: ${ret.returnNumber}, current status: ${ret.status}`);
      await prisma.purchaseReturn.update({
        where: { id: ret.id },
        data: { status: 'COMPLETED' }
      });
      console.log(`Successfully updated return ${ret.returnNumber} to COMPLETED.`);
    }

    const remainingApproved = await prisma.purchaseReturn.count({
      where: { status: 'APPROVED' }
    });
    console.log(`Migration complete. Remaining APPROVED purchase returns count: ${remainingApproved}`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

migrateApprovedReturns();
