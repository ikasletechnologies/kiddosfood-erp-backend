// Read-only audit: flags DailySettlement rows persisted before the Day
// Closing fix (payment-mode totals not reconciling with grandTotal). Does
// NOT modify any data — for review only. Run: npx tsx scripts/check-settlement-consistency.ts
import prisma from '../src/lib/prisma';

async function main() {
  const settlements = await prisma.dailySettlement.findMany({
    orderBy: { businessDate: 'desc' },
    include: { franchise: { select: { name: true } } },
  });

  const inconsistent = settlements.filter((s) => {
    const modeTotal = s.cashTotal + s.upiTotal + s.cardTotal + (s.otherTotal || 0);
    return Math.abs(modeTotal - s.grandTotal) > 0.01;
  });

  console.log(`Checked ${settlements.length} settlement record(s). ${inconsistent.length} inconsistent.\n`);

  for (const s of inconsistent) {
    const modeTotal = s.cashTotal + s.upiTotal + s.cardTotal + (s.otherTotal || 0);
    console.log(
      `[INCONSISTENT] id=${s.id} franchise=${s.franchise?.name || s.franchiseId} businessDate=${s.businessDate.toISOString().slice(0, 10)} ` +
      `closedAt=${s.createdAt.toISOString()} closedBy=${s.closedBy || '—'} ` +
      `cash=${s.cashTotal} upi=${s.upiTotal} card=${s.cardTotal} other=${s.otherTotal || 0} modeTotal=${modeTotal} grandTotal=${s.grandTotal}`
    );
  }

  if (inconsistent.length === 0) {
    console.log('No inconsistent settlement records found.');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
