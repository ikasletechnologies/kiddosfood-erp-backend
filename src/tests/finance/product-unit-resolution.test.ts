import prisma from '../../lib/prisma';
import { ProductService } from '../../modules/product/product.service';
import { FranchiseService } from '../../modules/franchise/franchise.service';

// Safe-by-construction, same pattern as pl-return-netting.test.ts: every
// Prisma method ProductService.getAll touches is monkey-patched with
// fabricated in-memory data, never a real query — this suite never reads or
// writes the live database. It exercises the REAL production function.
//
// Regression target: "No unit conversion found for item APPAM to unit 450G".
// Root cause — ProductService.getAll's resolvedUnit let a SKU's parsed
// pack-size (e.g. "450G", from parseSkuPackSize) override the real
// InventoryItem.unit as the transactable `unit` sent through the whole
// sales pipeline. The fix reorders priority so the real unit always wins;
// packSize stays a separate, informational field.

let failures = 0;
const check = (label: string, cond: boolean, extra?: string) => {
  if (cond) console.log(`   ✅ PASS: ${label}${extra ? ` (${extra})` : ''}`);
  else { console.error(`   ❌ FAIL: ${label}${extra ? ` (${extra})` : ''}`); failures++; }
};

function installMocks(opts: {
  products: any[];
  inventoryItems: any[];
  hq?: { id: string } | null;
}) {
  (prisma as any).product = { findMany: async () => opts.products };
  (prisma as any).inventoryItem = { findMany: async () => opts.inventoryItems };
  (FranchiseService as any).getHqFranchiseOrNull = async () => opts.hq ?? null;
}

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING PRODUCT UNIT-RESOLUTION VALIDATION (mocked, no DB writes)');
  console.log('====================================================\n');

  // ── 1. APPAM 450G: real InventoryItem.unit (PCS) must win over the SKU's
  //     parsed pack-size ("450G"), and packSize stays available separately ──
  {
    installMocks({
      hq: { id: 'hq-1' },
      products: [{ id: 'prod-appam-450', name: 'APPAM', sku: 'FG-APPA-450G', recipe: null }],
      inventoryItems: [{
        id: 'inv-appam-450', sku: 'FG-APPA-450G', name: 'APPAM', unit: 'PCS',
        franchiseId: 'hq-1', currentStock: 53, basePrice: 40, costPrice: 20,
        franchisePrice: null, dealerPrice: 40, customerPrice: null,
        baseUnit: null, conversions: [],
      }],
    });
    const rows = await ProductService.getAll({}, 'hq-1');
    const appam = rows.find((r: any) => r.sku === 'FG-APPA-450G');
    check('1. APPAM 450G resolves unit=PCS (not 450G)', appam?.unit === 'PCS', `got unit=${appam?.unit}`);
    check('1. APPAM 450G still carries packSize={qty:450, unit:G} separately', appam?.packSize?.qty === 450 && appam?.packSize?.unit === 'G', `got ${JSON.stringify(appam?.packSize)}`);
    check('1. Stock quantity untouched: 53', appam?.currentStock === 53);
  }

  // ── 2. Variant isolation: APPAM 450G and APPAM 900G resolve independently,
  //     each to its OWN InventoryItem by SKU — no cross-contamination ──────
  {
    installMocks({
      hq: { id: 'hq-1' },
      products: [
        { id: 'prod-450', name: 'APPAM', sku: 'FG-APPA-450G', recipe: null },
        { id: 'prod-900', name: 'APPAM', sku: 'FG-APPA-900G', recipe: null },
      ],
      inventoryItems: [
        { id: 'inv-450', sku: 'FG-APPA-450G', name: 'APPAM', unit: 'PCS', franchiseId: 'hq-1', currentStock: 53, basePrice: 40, costPrice: 20, baseUnit: null, conversions: [] },
        { id: 'inv-900', sku: 'FG-APPA-900G', name: 'APPAM', unit: 'PCS', franchiseId: 'hq-1', currentStock: 10, basePrice: 70, costPrice: 35, baseUnit: null, conversions: [] },
      ],
    });
    const rows = await ProductService.getAll({}, 'hq-1');
    const r450 = rows.find((r: any) => r.sku === 'FG-APPA-450G');
    const r900 = rows.find((r: any) => r.sku === 'FG-APPA-900G');
    check('2. 450G variant keeps its own stock (53)', r450?.currentStock === 53, `got ${r450?.currentStock}`);
    check('2. 900G variant keeps its own stock (10), not merged with 450G', r900?.currentStock === 10, `got ${r900?.currentStock}`);
    check('2. 450G packSize is {450,G}, not {900,G}', r450?.packSize?.qty === 450);
    check('2. 900G packSize is {900,G}, not {450,G}', r900?.packSize?.qty === 900);
  }

  // ── 3. baseUnit still wins over a bare packSize fallback when unit is unset ──
  {
    installMocks({
      hq: { id: 'hq-1' },
      products: [{ id: 'prod-rice', name: 'Rice Bag', sku: 'RM-RICE-25KG', recipe: null }],
      inventoryItems: [{
        id: 'inv-rice', sku: 'RM-RICE-25KG', name: 'Rice Bag', unit: null,
        franchiseId: 'hq-1', currentStock: 100, basePrice: 0, costPrice: 0,
        baseUnit: { id: 'u-kg', name: 'Kilograms', shortName: 'KG' }, conversions: [],
      }],
    });
    const rows = await ProductService.getAll({}, 'hq-1');
    const rice = rows.find((r: any) => r.sku === 'RM-RICE-25KG');
    check('3. No unit but baseUnit present: resolves KG (baseUnit), not 25KG (packSize)', rice?.unit === 'KG', `got unit=${rice?.unit}`);
  }

  // ── 4. Bare packSize.unit is still a reasonable last-resort fallback when
  //     nothing else is configured (never the qty-prefixed composite) ──────
  {
    installMocks({
      hq: { id: 'hq-1' },
      products: [{ id: 'prod-x', name: 'Mystery Item', sku: 'FG-MYST-250G', recipe: null }],
      inventoryItems: [{
        id: 'inv-x', sku: 'FG-MYST-250G', name: 'Mystery Item', unit: null,
        franchiseId: 'hq-1', currentStock: 5, basePrice: 0, costPrice: 0,
        baseUnit: null, conversions: [],
      }],
    });
    const rows = await ProductService.getAll({}, 'hq-1');
    const x = rows.find((r: any) => r.sku === 'FG-MYST-250G');
    check('4. Nothing configured: falls back to bare unit code "G", never "250G"', x?.unit === 'G', `got unit=${x?.unit}`);
  }

  // ── 5. No-franchise (unscoped) branch has the same fix applied ─────────
  {
    installMocks({ products: [{ id: 'prod-y', name: 'APPAM', sku: 'FG-APPA-450G', recipe: null }], inventoryItems: [] });
    const rows = await ProductService.getAll({}, undefined);
    const y = rows.find((r: any) => r.sku === 'FG-APPA-450G');
    check('5. Unscoped list also never returns the qty-prefixed composite as unit', y?.unit !== '450G', `got unit=${y?.unit}`);
  }

  console.log('\n====================================================');
  if (failures > 0) console.error(`❌ ${failures} check(s) FAILED`);
  else console.log('✅ ALL CHECKS PASSED');
  console.log('====================================================\n');
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error running product unit-resolution validation:', err);
  process.exit(1);
});
