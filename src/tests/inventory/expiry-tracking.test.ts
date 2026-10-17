// Expiry Tracking: date-only expiry status agrees with the lot-eligibility
// rule Production and Sales use, and the Finished Goods / Raw Materials views
// never mix lot types.
// Run: npx tsx src/tests/inventory/expiry-tracking.test.ts
import prisma from '../../lib/prisma';
import { ExpiryTrackingService, daysToExpiry, expiryStatusOf } from '../../modules/inventory/expiry-tracking.service';
import { isLotExpired } from '../../modules/inventory/lot-eligibility';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`   ✅ PASS: ${label}`);
  else { console.error(`   ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}

async function main() {
  console.log('1. Status rule (business timezone, date-only)');
  // 16 Oct 2026, 23:30 IST — late evening, so a naive UTC comparison would slip a day.
  const now = new Date('2026-10-16T18:00:00.000Z');
  const cases: Array<[string, string, string]> = [
    ['2026-10-16T00:00:00.000Z', 'EXPIRED', 'expiry today (UTC midnight) is expired'],
    ['2026-10-15T18:30:00.000Z', 'EXPIRED', 'expiry today (IST midnight) is expired'],
    ['2026-10-17T00:00:00.000Z', 'EXPIRING_SOON', 'expiry tomorrow is expiring soon'],
    ['2026-10-23T00:00:00.000Z', 'EXPIRING_SOON', 'expiry in 7 days is expiring soon'],
    ['2026-10-24T00:00:00.000Z', 'VALID', 'expiry in 8 days is valid'],
    ['2025-01-01T00:00:00.000Z', 'EXPIRED', 'long past is expired'],
  ];
  for (const [d, want, label] of cases) {
    const got = expiryStatusOf(d, now);
    check(label, got === want, `got ${got}`);
    check(`${label} — matches production/sales eligibility`, (got === 'EXPIRED') === isLotExpired(d, now));
  }
  check('days left counts calendar days', daysToExpiry('2026-10-23T00:00:00.000Z', now) === 7);

  console.log('2. Views stay separate');
  const admin = { role: 'SUPER_ADMIN' };
  const fin = await ExpiryTrackingService.list({ view: 'FINISHED', includeZero: true }, admin);
  const raw = await ExpiryTrackingService.list({ view: 'RAW', includeZero: true }, admin);
  check('finished view has only finished/bulk lots', fin.rows.every((r: any) => r.recordType === 'FINISHED_LOT' || r.recordType === 'BULK'));
  check('raw view has only raw purchase lots', raw.rows.every((r: any) => r.recordType === 'RAW_LOT'));
  const finIds = new Set(fin.rows.map((r) => r.id));
  check('no lot appears in both views', raw.rows.every((r) => !finIds.has(r.id)));
  for (const v of [fin, raw]) {
    const s = v.summary;
    check(`${v.view} cards add up`, s.total === s.valid + s.expiringSoon + s.expired && s.total === v.rows.length);
  }

  console.log('3. Zero-stock history');
  const live = await ExpiryTrackingService.list({ view: 'RAW' }, admin);
  check('default hides zero-stock lots', live.rows.every((r) => r.availableQty > 0));
  check('history includes every live lot', live.rows.every((r) => raw.rows.some((h) => h.id === r.id)));

  console.log('4. Status filter leaves the cards alone');
  const expired = await ExpiryTrackingService.list({ view: 'RAW', includeZero: true, status: 'EXPIRED' }, admin);
  check('only expired rows', expired.rows.every((r) => r.expiryStatus === 'EXPIRED'));
  check('cards unchanged', JSON.stringify(expired.summary) === JSON.stringify(raw.summary));

  console.log('5. Branch access');
  const none = await ExpiryTrackingService.list({ view: 'FINISHED', includeZero: true }, { role: 'FRANCHISE_ADMIN', franchiseId: null });
  check('branch user without a branch sees nothing', none.rows.length === 0);
  const branch = await prisma.franchise.findFirst({ where: { isHQ: false }, select: { id: true } });
  if (branch) {
    const own = await ExpiryTrackingService.list({ view: 'FINISHED', includeZero: true, franchiseId: 'ignored' }, { role: 'FRANCHISE_ADMIN', franchiseId: branch.id });
    check('branch user sees only their branch', own.rows.every((r) => r.franchiseId === branch.id));
  }

  console.log(failures ? `\n❌ ${failures} failure(s)` : '\n✅ All expiry tracking checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
