import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Starting Vendor Ledger Recalculation Migration...");

  // Get all vendors with their ledger entries
  const vendors = await prisma.vendor.findMany({
    include: {
      ledgerEntries: {
        orderBy: { createdAt: 'asc' }
      }
    }
  });

  for (const vendor of vendors) {
    console.log(`Processing Vendor: ${vendor.name}`);
    let runningBalance = 0;

    // Check if OPENING_BALANCE entry exists
    const hasOpeningBalanceEntry = vendor.ledgerEntries.some(e => e.referenceType === 'OPENING_BALANCE');
    
    if (!hasOpeningBalanceEntry && vendor.openingBalance !== 0) {
      console.log(`  -> Injecting missing OPENING_BALANCE of ${vendor.openingBalance}`);
      const type = vendor.openingBalance > 0 ? 'CREDIT' : 'DEBIT'; // CREDIT = We owe them, DEBIT = They owe us
      const amount = Math.abs(vendor.openingBalance);
      await prisma.vendorLedger.create({
        data: {
          vendorId: vendor.id,
          type,
          amount,
          balanceAfterTransaction: vendor.openingBalance,
          referenceType: 'OPENING_BALANCE',
          paymentMode: 'CASH',
          note: 'Opening Balance (Auto-injected by Migration)',
          createdAt: new Date('2000-01-01') // Force it to the beginning of time
        }
      });
      runningBalance += vendor.openingBalance;
    }

    for (const entry of vendor.ledgerEntries) {
      let correctType = entry.type;
      let newReferenceId = entry.referenceId;
      
      // 1. Correct the Ledger Direction (Type)
      if (entry.referenceType === 'PURCHASE') {
        correctType = 'CREDIT'; // Purchases increase liability (Cr)
      } else if (entry.referenceType === 'PAYMENT' || entry.referenceType === 'ADVANCE') {
        correctType = 'DEBIT'; // Payments decrease liability (Dr)
      } else if (entry.referenceType === 'OPENING_BALANCE') {
        // If it's opening payable, it's CREDIT. We assume opening entries were created correctly or will be verified.
        // Assuming positive amount = payable = CREDIT.
      }

      // 2. Recalculate Balance
      if (correctType === 'CREDIT') {
        runningBalance += entry.amount;
      } else {
        runningBalance -= entry.amount;
      }

      // 3. Update to Human Readable Reference IDs
      if (entry.referenceId && entry.referenceId.length > 20) { // If it's a UUID
        if (entry.referenceType === 'PAYMENT' || entry.referenceType === 'ADVANCE') {
          const payment = await prisma.payment.findUnique({ where: { id: entry.referenceId } });
          if (payment && payment.paymentNumber) {
            newReferenceId = payment.paymentNumber;
          }
        } else if (entry.referenceType === 'PURCHASE') {
          if (entry.sourceModule === 'PROCUREMENT') {
            const po = await prisma.procurementOrder.findUnique({ where: { id: entry.referenceId } });
            if (po && po.poNumber) newReferenceId = po.poNumber;
          } else if (entry.sourceModule === 'FINANCE') {
            const invoice = await prisma.vendorInvoice.findUnique({ where: { id: entry.referenceId } });
            if (invoice && invoice.invoiceNumber) newReferenceId = invoice.invoiceNumber;
          }
        }
      }

      // Update the entry
      await prisma.vendorLedger.update({
        where: { id: entry.id },
        data: {
          type: correctType,
          balanceAfterTransaction: runningBalance,
          referenceId: newReferenceId
        }
      });
    }
    
    console.log(`Vendor ${vendor.name} final balance: ${runningBalance}`);
  }

  console.log("Migration Complete! All balances recalculated and reference IDs updated.");
}

main().catch(e => {
  console.error("Migration failed:", e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
