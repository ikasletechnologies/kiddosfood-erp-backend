import prisma from './lib/prisma';

async function audit() {
  console.log('=== AUDITING EXISTING PAYMENTS ===\n');

  const accCount = await prisma.account.count();
  const orderCount = await prisma.order.count();
  const invoiceCount = await prisma.invoice.count();
  const paymentCount = await prisma.payment.count();
  console.log(`Counts -> Accounts: ${accCount}, Orders: ${orderCount}, Invoices: ${invoiceCount}, Payments: ${paymentCount}`);


  const targetReceipts = await prisma.payment.findMany({
    where: {
      paymentNumber: { in: ['RCPT-2026-00005', 'RCPT-2026-00004'] }
    },
    include: { account: true, order: true, invoice: true }
  });
  for (const rcpt of targetReceipts) {
    console.log(`Payment Number: ${rcpt.paymentNumber}`);
    console.log(`ID: ${rcpt.id}`);
    console.log(`Mode: ${rcpt.paymentMode}`);
    console.log(`Amount: ₹${rcpt.paidAmount}`);
    console.log(`Account ID: ${rcpt.accountId}`);
    console.log(`Account Name: ${rcpt.account?.name || 'NONE'}`);
    console.log(`Account Type: ${rcpt.account?.type || 'NONE'}`);
    console.log(`Account Status: ${rcpt.account?.status || 'NONE'}`);
    console.log(`Invoice ID: ${rcpt.invoiceId}`);
    console.log(`Invoice Status: ${rcpt.invoice?.status || 'NONE'}`);
    console.log('-----------------------------------');
  }

  // 2. Fetch all payments to audit anomalies
  const allPayments = await prisma.payment.findMany({
    include: { account: true }
  });

  console.log(`Total payments in DB: ${allPayments.length}`);

  const anomalies: Array<{
    id: string;
    paymentNumber: string | null;
    paymentMode: string;
    paidAmount: number;
    accountId: string | null;
    accountName: string | null;
    accountType: string | null;
    accountStatus: string | null;
    issue: string;
  }> = [];

  for (const p of allPayments) {
    let issue = '';
    if (!p.accountId) {
      issue = 'accountId IS NULL';
    } else if (!p.account) {
      issue = 'account DOES NOT EXIST';
    } else if (p.account.status !== 'ACTIVE') {
      issue = `account INACTIVE (${p.account.status})`;
    } else {
      // Check mode vs account type match
      const mode = p.paymentMode;
      const accType = p.account.type;
      if (mode === 'CASH' && accType !== 'CASH') {
        issue = `Type mismatch: mode=${mode}, accType=${accType}`;
      } else if ((mode === 'BANK_TRANSFER' || mode === 'NEFT' || mode === 'RTGS' || mode === 'IMPS' || mode === 'CARD' || mode === 'CHEQUE') && accType !== 'BANK') {
        issue = `Type mismatch: mode=${mode}, accType=${accType}`;
      } else if (mode === 'UPI' && accType !== 'UPI' && accType !== 'BANK') {
        issue = `Type mismatch: mode=${mode}, accType=${accType}`;
      }
    }

    if (issue) {
      anomalies.push({
        id: p.id,
        paymentNumber: p.paymentNumber,
        paymentMode: p.paymentMode,
        paidAmount: p.paidAmount,
        accountId: p.accountId,
        accountName: p.account?.name || null,
        accountType: p.account?.type || null,
        accountStatus: p.account?.status || null,
        issue
      });
    }
  }

  console.log(`\n--- ANOMALIES FOUND: ${anomalies.length} ---`);
  console.table(anomalies);

  await prisma.$disconnect();
}

audit().catch((err) => {
  console.error(err);
  process.exit(1);
});
