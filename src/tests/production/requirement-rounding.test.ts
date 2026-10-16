/**
 * Production Planning quantity-rounding policy: weights below 1 KG are
 * consumed rounded up to the next whole gram, from 1 KG as calculated; the
 * saved formulation (reference quantities and ratios) is never changed.
 *
 * Pure — no database writes:
 *   npx tsx src/tests/production/requirement-rounding.test.ts
 */
import { roundRequirement } from '../../modules/production/requirement-rounding';
import { FormulationService } from '../../modules/recipes/formulation.service';

let passed = 0;
function check(title: string, condition: boolean, details?: unknown) {
  if (!condition) {
    console.error(`[FAIL] ${title}${details !== undefined ? ` — ${JSON.stringify(details)}` : ''}`);
    throw new Error(`Test failed: ${title}`);
  }
  passed++;
  console.log(`[PASS] ${title}`);
}

console.log('=== REQUIREMENT ROUNDING POLICY ===\n');

// Spec examples, from a KG recipe line and from a gram recipe line.
for (const [kg, g] of [[0.08877, 89], [0.02427, 25], [0.16181, 162], [0.48544, 486]] as const) {
  check(`${kg} KG → ${g / 1000} KG`, roundRequirement(kg, 'KG') === g / 1000, roundRequirement(kg, 'KG'));
  check(`${kg * 1000} g → ${g} g`, roundRequirement(kg * 1000, 'g') === g, roundRequirement(kg * 1000, 'g'));
}
check('1.375405 KG is used as calculated (display rounds it)', roundRequirement(1.375405, 'KG') === 1.375405);
check('1000.4 g is used as calculated', roundRequirement(1000.4, 'G') === 1000.4);
check('999.2 g → 1000 g', roundRequirement(999.2, 'G') === 1000);
check('exact whole grams are not bumped by float noise', roundRequirement(0.025, 'KG') === 0.025 && roundRequirement(0.1 * 3, 'KG') === 0.3);
check('a trace amount becomes 1 g, never 0', roundRequirement(0.0000004, 'KG') === 0.001);
check('mg lines round to whole grams too', roundRequirement(250, 'MG') === 1000);
check('volumes are left as calculated', roundRequirement(0.08877, 'L') === 0.08877 && roundRequirement(88.77, 'ML') === 88.77);
check('count units are left as calculated', roundRequirement(2.5, 'PCS') === 2.5);
check('zero stays zero', roundRequirement(0, 'KG') === 0);

// Scaling: the plan carries the exact value and the rounded requirement;
// the reference formulation itself is untouched.
const formulation = {
  yieldQty: 10.3,
  yieldUnit: 'KG',
  items: [
    { inventoryItemId: 'dal', quantity: 0.25, unit: 'KG', inventoryItem: { name: 'Dal', unit: 'KG' } },
    { inventoryItemId: 'salt', quantity: 25, unit: 'G', inventoryItem: { name: 'Salt', unit: 'KG' } },
    { inventoryItemId: 'rice', quantity: 14.166, unit: 'KG', inventoryItem: { name: 'Rice', unit: 'KG' } },
  ],
};
const before = JSON.stringify(formulation);
const scaled = FormulationService.scale(formulation, 1, 'KG');
const [dal, salt, rice] = scaled.lines;
check('dal: 24.27… g calculated, 25 g required', Math.abs(dal.calculatedQty - 0.024272) < 1e-6 && dal.requiredQty === 0.025 && dal.requiredInStockUnit === 0.025, dal);
check('salt (g line, KG stock): 2.43 g → 3 g → 0.003 KG', salt.requiredQty === 3 && salt.requiredInStockUnit === 0.003, salt);
check('rice: 1.375340 KG used as calculated', rice.requiredQty === rice.calculatedQty && Math.abs(rice.requiredQty - 1.37534) < 1e-6, rice);
check('reference formulation unchanged', JSON.stringify(formulation) === before);
check('reference quantities kept on each line', dal.referenceQty === 0.25 && salt.referenceQty === 25);

console.log(`\n${passed} checks passed`);
