/**
 * Sales Order / POS estimated profit/loss — shared calculation (pure, no DB):
 *   npx tsx src/tests/sales/profitability.test.ts
 */
import { allocateDiscount, canViewCost, excludeTax, lossWarning, profitLine, summarizeProfit } from '../../modules/sales/profitability';

let passed = 0;
function check(title: string, condition: boolean, details?: unknown) {
  if (!condition) {
    console.error(`[FAIL] ${title}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
  passed++;
  console.log(`[PASS] ${title}`);
}

console.log('=== SALES / POS PROFITABILITY ===\n');

// Kambu Dosa 1kg: cost ₹80, price ₹100 excl. GST, qty 10.
const kambu = profitLine({ quantity: 10, netRevenue: 1000, unitCost: 80 });
check('Kambu Dosa: COGS ₹800, revenue ₹1,000, profit ₹200, margin 20%',
  kambu.costOfGoods === 800 && kambu.netRevenue === 1000 && kambu.profit === 200 && kambu.marginPct === 20 && kambu.status === 'PROFIT', kambu);
check('Kambu Dosa: ₹20 profit per unit at net ₹100', kambu.unitProfit === 20 && kambu.netUnitPrice === 100);

// Loss: cost ₹80, price ₹65, qty 10.
const loss = profitLine({ quantity: 10, netRevenue: 650, unitCost: 80 });
check('Loss: ₹15 per unit, ₹150 total', loss.unitProfit === -15 && loss.profit === -150 && loss.status === 'LOSS', loss);
check('Loss warning text', lossWarning(loss) === 'Warning: Your selling price is ₹15 below production cost per unit. Estimated loss for 10 units is ₹150.', lossWarning(loss));
check('No warning on a profit', lossWarning(kambu) === null);

// Appam: cost ₹50, price ₹60 excl. GST, qty 5.
const appam = profitLine({ quantity: 5, netRevenue: 300, unitCost: 50 });
check('Appam: COGS ₹250, revenue ₹300, profit ₹50', appam.costOfGoods === 250 && appam.profit === 50, appam);

// Missing cost: never an invented 0.
const unknown = profitLine({ quantity: 3, netRevenue: 300, unitCost: null });
check('Unknown cost → no profit, no fake ₹0', unknown.status === 'COST_UNAVAILABLE' && unknown.costOfGoods === null && unknown.profit === null && unknown.marginPct === null);

// Zero revenue is safe.
const free = profitLine({ quantity: 2, netRevenue: 0, unitCost: 10 });
check('Zero revenue: no margin %, loss = cost', free.marginPct === null && free.profit === -20);

// GST is extracted once from inclusive prices; exclusive prices are untouched.
check('₹118 incl. 18% GST → ₹100', excludeTax(118, 18) === 100);
check('₹105 incl. 5% GST → ₹100', excludeTax(105, 5) === 100);
check('0% GST unchanged', excludeTax(99.5, 0) === 99.5);

// Discounts: line revenue is after discount (10% off ₹100 × 10 → ₹900).
const disc = profitLine({ quantity: 10, netRevenue: 900, unitCost: 80 });
check('10% discount: net ₹90/unit, profit ₹100', disc.netUnitPrice === 90 && disc.profit === 100);

// Bill-level discount allocated by revenue, in paise, adding up exactly.
const shares = allocateDiscount([1000, 300, 0.01], 100);
check('Bill discount ₹100 split 1000:300 and sums exactly', Math.round(shares.reduce((s, x) => s + x, 0) * 100) === 10000 && shares[0] > shares[1], shares);
check('Bill discount capped at revenue', allocateDiscount([50], 80)[0] === 50);
check('No discount → zeros', allocateDiscount([10, 20], 0).every((x) => x === 0));

// Totals with a line whose cost is unknown: profit covers the costed lines only.
const sum = summarizeProfit([kambu, appam, unknown]);
check('Summary: revenue ₹1,600, COGS ₹1,050, profit ₹250 on costed ₹1,300; 1 line uncosted',
  sum.netRevenue === 1600 && sum.costOfGoods === 1050 && sum.profit === 250 && sum.costedRevenue === 1300 && sum.costUnavailableLines === 1, sum);
check('Summary of only uncosted lines → unavailable', summarizeProfit([unknown]).status === 'COST_UNAVAILABLE');

// Mixed batches (FIFO already blended into unitCost by the estimator): 10 @ ₹50 + 5 @ ₹65 for 15 units.
const blended = profitLine({ quantity: 15, netRevenue: 15 * 70, unitCost: (10 * 50 + 5 * 65) / 15 });
check('Two cost layers: COGS ₹825, profit ₹225', blended.costOfGoods === 825 && blended.profit === 225, blended);

// Cost visibility is an allowlist.
check('Admins may see cost; unknown roles may not', canViewCost({ role: 'SUPER_ADMIN' }) && canViewCost({ role: 'FRANCHISE_ADMIN' }) && !canViewCost({ role: 'CASHIER' }) && !canViewCost(null));

console.log(`\n${passed} checks passed`);
