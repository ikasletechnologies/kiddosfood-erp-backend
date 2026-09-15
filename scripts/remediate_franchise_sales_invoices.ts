import prisma from '../src/lib/prisma';

async function remediateFranchiseSalesInvoices() {
  console.log('--- Starting Franchise Sales Invoice Remediation ---');

  const hq = await prisma.franchise.findFirst({
    where: { isHQ: true }
  });

  if (!hq) {
    throw new Error('HQ Franchise not found! Cannot remediate without HQ ID.');
  }

  console.log(`Found HQ Franchise: ${hq.name} (${hq.id})`);

  // Find all orders where partyType is FRANCHISE but franchiseId is not HQ
  const misattributedOrders = await prisma.order.findMany({
    where: {
      partyType: 'FRANCHISE',
      franchiseId: { not: hq.id }
    },
    select: {
      id: true,
      invoiceNum: true,
      partyType: true,
      partyId: true,
      franchiseId: true,
      customerName: true,
      totalAmount: true
    }
  });

  console.log(`Found ${misattributedOrders.length} misattributed franchise sales orders:`);
  for (const o of misattributedOrders) {
    console.log(`- ${o.invoiceNum} (Party: ${o.customerName || o.partyId}, Old FranchiseId: ${o.franchiseId})`);
  }

  if (misattributedOrders.length > 0) {
    const orderIds = misattributedOrders.map(o => o.id);
    const updateResult = await prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data: {
        franchiseId: hq.id
      }
    });

    console.log(`Successfully updated ${updateResult.count} orders to have franchiseId = ${hq.id} (HQ).`);
  } else {
    console.log('No misattributed orders found to update.');
  }

  console.log('--- Remediation Complete ---');
}

remediateFranchiseSalesInvoices()
  .catch((err) => {
    console.error('Error during remediation:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
