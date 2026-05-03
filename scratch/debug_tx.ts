import prisma from '../src/lib/prisma';

async function testTransaction() {
  try {
    await prisma.$transaction(async (tx) => {
      console.log('Keys on tx:', Object.keys(tx).filter(k => !k.startsWith('_')));
      // @ts-ignore
      console.log('financialPayment on tx:', !!tx.financialPayment);
    });
  } catch (err) {
    console.error('Transaction error:', err);
  }
  process.exit(0);
}

testTransaction();
