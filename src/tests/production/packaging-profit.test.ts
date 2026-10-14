/**
 * Packaging cost & profit/loss per packet (pure calculation, no database):
 *   npx tsx src/tests/production/packaging-profit.test.ts
 */
import { computePackagingCosts, DEFAULT_EXPENSE_CATEGORIES, CostRowInput, ExpenseLineInput } from '../../modules/production/production-costing';

let passed = 0;
function check(title: string, condition: boolean, details?: unknown) {
  if (!condition) {
    console.error(`[FAIL] ${title}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
  passed++;
  console.log(`[PASS] ${title}`);
}

// Rice Batter: actual yield 10 KG, raw material ₹1,500 → ₹150/KG.
const COST_PER_KG = 150;
const row = (packetSize: string, kg: number, good: number, sellingPrice: number | null, damaged = 0): CostRowInput => ({
  packetSize, packWeight: kg, good, damaged, bulkCost: COST_PER_KG * kg * (good + damaged), sellingPrice,
});
const perPacket5: ExpenseLineInput[] = [
  { category: 'MANPOWER', basis: 'PER_PACKET', rate: 1 },
  { category: 'ELECTRICITY', basis: 'PER_PACKET', rate: 1 },
  { category: 'OTHER', basis: 'PER_PACKET', rate: 1 },
  { category: 'PACKAGING_MATERIAL', basis: 'PER_PACKET', rate: 2 },
];
const cost = (rows: CostRowInput[], lines: ExpenseLineInput[] = perPacket5, shared: any[] = [], finishesBatch = false) =>
  computePackagingCosts({ rows, bulkUnit: 'KG', lines, shared, yieldQty: 10, finishesBatch, categories: DEFAULT_EXPENSE_CATEGORIES }).rows;

// 1–11: 1kg × 10 @ ₹140 → cost ₹155, loss ₹15/pkt, ₹150 total
const [loss] = cost([row('1kg', 1, 10, 140)]);
check('3. Raw material ₹150 per 1kg packet', loss.rawMaterialPerPacket === 150);
check('8. Production cost ₹155 per packet (₹150 + ₹5)', loss.costPerGoodPacket === 155 && loss.expenseTotal === 50 && loss.totalCost === 1550, loss);
check('10–11. ₹140 → loss ₹15 per packet, ₹150 total', loss.marginPerPacket === -15 && loss.marginTotal === -150 && loss.profitStatus === 'LOSS', loss);
const [even] = cost([row('1kg', 1, 10, 155)]);
check('Break-even at ₹155', even.marginPerPacket === 0 && even.marginTotal === 0 && even.profitStatus === 'BREAK_EVEN');
const [profit] = cost([row('1kg', 1, 10, 180)]);
check('12–13. ₹180 → profit ₹25 per packet, ₹250 total', profit.marginPerPacket === 25 && profit.marginTotal === 250 && profit.profitStatus === 'PROFIT' && profit.sellingValue === 1800);

// 14–15: 250g and 500g, alone and together — each row costed on its own
const multi = cost([row('250g', 0.25, 8, 45), row('500g', 0.5, 4, 80), row('1kg', 1, 2, 150)]);
check('14–15. 250g = ₹37.50 + ₹5 = ₹42.50; 500g = ₹75 + ₹5 = ₹80; 1kg = ₹155',
  multi[0].costPerGoodPacket === 42.5 && multi[1].costPerGoodPacket === 80 && multi[2].costPerGoodPacket === 155, multi.map((r) => r.costPerGoodPacket));
check('15b. Per-row profit/loss: +₹2.50, break-even, −₹5', multi[0].marginPerPacket === 2.5 && multi[1].profitStatus === 'BREAK_EVEN' && multi[2].marginTotal === -10);

// 16: Per KG and Per Batch
const [perKg] = cost([row('500g', 0.5, 10, 100)], [{ category: 'ELECTRICITY', basis: 'PER_KG', rate: 4 }]);
check('16a. ₹4 per KG on a 500g packet = ₹2', perKg.costPerGoodPacket === 77 && perKg.expenseTotal === 20, perKg);
const batchShared = [{ category: 'MANPOWER', total: 200, allocatedBefore: 0 }];
const [s1] = cost([row('1kg', 1, 4, 200)], [], batchShared);
check('16b. ₹200 per batch, 4 of 10 KG packed → ₹80 (₹20/pkt)', s1.expenseTotal === 80 && s1.costPerGoodPacket === 170);
const [s2] = cost([row('1kg', 1, 6, 200)], [], [{ category: 'MANPOWER', total: 200, allocatedBefore: 80 }], true);
check('16c. Final session takes only the remaining ₹120 (never charged twice)', s2.expenseTotal === 120);

// 18: damaged packets carried by the good ones (existing policy)
const [dmg] = cost([row('1kg', 1, 8, 180, 2)]);
check('18. 8 good + 2 damaged: ₹1,550 / 8 = ₹193.75 per good packet → loss ₹13.75',
  dmg.costPerPacket === 155 && dmg.costPerGoodPacket === 193.75 && dmg.damageAbsorbed === 310 && dmg.marginPerPacket === -13.75 && dmg.marginTotal === -110, dmg);

// 19: zero quantity and invalid prices
const [zero] = cost([row('1kg', 1, 0, 140)]);
check('19a. Zero packets: no cost per packet, no profit figure', zero.packets === 0 && zero.costPerGoodPacket === null && zero.marginTotal === null && zero.expenseTotal === 0);
for (const bad of [0, -5, NaN, null]) {
  const [r] = cost([row('1kg', 1, 10, bad as any)]);
  check(`19b. Price ${bad} → no profit/loss shown`, r.sellingPrice === null && r.marginPerPacket === null && r.profitStatus === null);
}

// Decimal precision: 0.1 + 0.2 style rates add up exactly
const [dec] = cost([row('1kg', 1, 3, 200)], [{ category: 'MANPOWER', basis: 'PER_PACKET', rate: 0.1 }, { category: 'OTHER', basis: 'PER_PACKET', rate: 0.2 }]);
check('Decimal: ₹0.10 + ₹0.20 per packet = ₹0.90 for 3 packets exactly', dec.expenseTotal === 0.9 && dec.costPerGoodPacket === 150.3);

console.log(`\nAll ${passed} checks passed.`);
