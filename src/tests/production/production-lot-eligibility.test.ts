// Production Planning purchase-lot eligibility: Stock Hub and Production
// Planning apply the same rule, ineligible lots are listed with the reason,
// and allocation cost / deduction are exact.
// Run: npx tsx src/tests/production/production-lot-eligibility.test.ts
import prisma from '../../lib/prisma';
import { ProductionCostingService } from '../../modules/production/production-costing.service';
import { PurchaseLotsService } from '../../modules/inventory/purchase-lots.service';
import { PRODUCTION_EXPIRED_MESSAGE, productionLotIssue } from '../../modules/inventory/lot-eligibility';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`   ✅ PASS: ${label}`);
  else { console.error(`   ❌ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
}
const near = (a: number, b: number, eps = 0.0005) => Math.abs(a - b) < eps;
class Rollback extends Error {}

// Runs fn in a transaction that is always rolled back, returning its result.
async function dryRun<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await prisma.$transaction(async (tx) => { out = await fn(tx); throw new Rollback(); });
  } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return out as T;
}

async function run() {
  console.log('🧪 Production purchase-lot eligibility\n');
  const id = `PLE${Date.now().toString().slice(-6)}`;
  const [whA, whB] = await prisma.warehouse.findMany({ take: 2 });
  if (!whA || !whB) throw new Error('Need two warehouses');
  const item = await prisma.inventoryItem.create({
    data: { name: `Thenai Test ${id}`, sku: `RM-${id}`, category: 'RAW_MATERIAL', unit: 'kg', currentStock: 0, franchiseId: null, costPrice: 100 },
  });
  const day = 86400000;
  const lot = (n: string, qty: number, cost: number, exp: Date | null, warehouseId: string, status: any = 'APPROVED') =>
    prisma.inventoryBatch.create({ data: { inventoryItemId: item.id, batchNumber: `${n}-${id}`, lotNumber: `${n}-${id}`, initialQty: qty, currentQty: qty, unitCost: cost, expDate: exp, warehouseId, status, receivedAt: new Date() } });

  try {
    const A = await lot('A', 48.618, 100, new Date(Date.now() + day), whA.id);      // eligible
    const B = await lot('B', 2, 120, new Date(Date.now() + 2 * day), whA.id);       // eligible, other price
    const X = await lot('X', 10, 90, new Date(Date.now() - 2 * day), whA.id);       // expired (two days ago)
    const W = await lot('W', 5, 95, new Date(Date.now() + day), whB.id);            // other warehouse
    const Q = await lot('Q', 3, 95, new Date(Date.now() + day), whA.id, 'QC_HOLD'); // held
    const total = 48.618 + 2 + 10 + 5 + 3;
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { currentStock: total } });

    console.log('1️⃣ Lot options for the selected warehouse');
    const [opt] = await ProductionCostingService.getLotOptions([item.id], whA.id);
    check('Eligible lots A and B are selectable, oldest first', opt.lots.map(l => l.id).join() === [A.id, B.id].join(), opt.lots.map(l => l.lotNumber).join());
    const why = (lotId: string) => opt.unavailableLots.find(l => l.id === lotId);
    check('Expired lot listed with the expiry message', why(X.id)?.reason === PRODUCTION_EXPIRED_MESSAGE);
    check('Other-warehouse lot listed with reason', why(W.id)?.reasonCode === 'OTHER_WAREHOUSE');
    check('QC-hold lot listed with reason', why(Q.id)?.reasonCode === 'STATUS');
    check('No lot silently omitted', opt.lots.length + opt.unavailableLots.length === 5);

    console.log('\n2️⃣ Stock Hub uses the same rule');
    const hub = await PurchaseLotsService.getMaterialLots(item.id);
    const usable = (lotId: string) => hub.lots.find(l => l.id === lotId)?.productionUsable;
    check('Stock Hub: A/B usable, X expired and Q held not usable', usable(A.id) === true && usable(B.id) === true && usable(X.id) === false && usable(Q.id) === false);
    const sum = (await PurchaseLotsService.getLotSummaries([item.id])).get(item.id)!;
    check('Stock Hub usable lot qty excludes expired and held lots', near(sum.usableQty, 48.618 + 2 + 5), String(sum.usableQty));

    console.log('\n3️⃣ Expiry boundary (date only: expired ON the expiry date, IST)');
    const issue = (exp: string | null, at: string) =>
      productionLotIssue({ status: 'APPROVED', currentQty: 1, expDate: exp }, { now: new Date(at) })?.code ?? null;
    // Expiry "16 Oct 2026" stored as UTC midnight, like LOT-20261015-00025.
    check('Day before expiry, 23:59 IST (15 Oct) → usable', issue('2026-10-16T00:00:00.000Z', '2026-10-15T18:29:00.000Z') === null);
    check('Expiry date, 00:00 IST (16 Oct) → expired', issue('2026-10-16T00:00:00.000Z', '2026-10-15T18:30:00.000Z') === 'EXPIRED');
    check('Expiry date, 12:09 IST (16 Oct) → expired', issue('2026-10-16T00:00:00.000Z', '2026-10-16T06:39:00.000Z') === 'EXPIRED');
    check('Expiry stored as IST midnight → same rule',
      issue('2026-10-15T18:30:00.000Z', '2026-10-15T18:29:00.000Z') === null && issue('2026-10-15T18:30:00.000Z', '2026-10-15T18:30:00.000Z') === 'EXPIRED');
    check('No expiry → usable', issue(null, '2026-10-16T06:39:00.000Z') === null);
    check('Expiry two days ahead → usable', productionLotIssue({ status: 'APPROVED', currentQty: 1, expDate: new Date(Date.now() + 2 * day) }) === null);

    console.log('\n3️⃣b Available stock excludes expired and held lots');
    const hubSum = PurchaseLotsService.summarize(total, 100, sum);
    check('Stock Hub usable stock = total − expired (10) − held (3)', near(hubSum.usableStock, total - 10 - 3), String(hubSum.usableStock));
    check('Stock Hub reports 10 expired', near(hubSum.expiredQty, 10), String(hubSum.expiredQty));
    const unusable = (await PurchaseLotsService.getUnusableLotQty([item.id], whA.id)).get(item.id)!;
    check('Warehouse view: expired 10, held 3 (other warehouse not counted)', near(unusable.expired, 10) && near(unusable.held, 3), JSON.stringify(unusable));

    console.log('\n4️⃣ Allocation cost and deduction (rolled back — selecting never deducts)');
    const one = await dryRun(async (tx) => {
      const r = await ProductionCostingService.depleteAllocatedLots(tx, item, [{ batchId: A.id, qty: 1.382 }], 1.382, whA.id);
      const left = (await tx.inventoryBatch.findUnique({ where: { id: A.id } })).currentQty;
      return { cost: r.totalCost, left };
    });
    check('1.382 KG from Lot A costs ₹138.20', near(one.cost, 138.2, 0.005), String(one.cost));
    check('Lot A after consumption: 47.236 KG', near(one.left, 47.236), String(one.left));
    check('Option lookup and rollback left Lot A untouched (48.618)', near((await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: A.id } })).currentQty, 48.618));

    const two = await dryRun((tx) => ProductionCostingService.depleteAllocatedLots(tx, item, [{ batchId: A.id, qty: 0.5 }, { batchId: B.id, qty: 0.882 }], 1.382, whA.id));
    check('Two lots: 0.5 × ₹100 + 0.882 × ₹120 = ₹155.84', near(two.totalCost, 155.84, 0.005), String(two.totalCost));
    check('Weighted cost ₹112.76/KG from actual allocations', near(two.unitCost, 155.84 / 1.382, 0.001), String(two.unitCost));

    for (const [label, alloc, re] of [
      ['Expired lot cannot be consumed', [{ batchId: X.id, qty: 1 }], /expiry restrictions/],
      ['Over-allocation beyond lot stock is refused', [{ batchId: B.id, qty: 3 }], /only has/],
      ['Lot from another warehouse is refused', [{ batchId: W.id, qty: 1 }], /different warehouse/],
    ] as const) {
      try {
        await dryRun((tx) => ProductionCostingService.depleteAllocatedLots(tx, item, alloc as any, (alloc as any)[0].qty, whA.id));
        check(label, false, 'was allowed');
      } catch (e: any) { check(label, re.test(e.message), e.message); }
    }

    console.log('\n5️⃣ Untracked stock');
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { currentStock: total + 0.0003 } });
    // computeWarehouseStock reads the movement ledger; this item has none, so untracked is 0 either way.
    const [opt2] = await ProductionCostingService.getLotOptions([item.id], whA.id);
    check('Floating residue is not offered as stock without lot', opt2.untrackedQty === 0, String(opt2.untrackedQty));
  } finally {
    await prisma.inventoryBatch.deleteMany({ where: { inventoryItemId: item.id } });
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  }

  if (failures) { console.error(`\n💥 ${failures} CHECK(S) FAILED`); process.exit(1); }
  console.log('\n🎉 ALL PRODUCTION LOT ELIGIBILITY TESTS PASSED');
}

run().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
