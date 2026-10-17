/**
 * Gives existing recipes the default Additional Expenses (₹1 Manpower, ₹1
 * Electricity, ₹1 Other, ₹2 Packaging Materials — per packet; or the
 * admin-saved defaults) — ONLY recipes that have never had an expense
 * configuration (Recipe.expenseConfig is null).
 *
 *   - never configured            → defaults applied
 *   - every category saved        → kept as is (custom amounts, ₹0 amounts
 *                                   and disabled expenses are all preserved)
 *   - some categories saved, or
 *     an empty / unreadable list  → listed for review, left unchanged
 *
 * Safe to re-run: an applied recipe is no longer "never configured". Each
 * update is versioned and audited (same path as Recipe Master), and runs
 * already started keep their own expense snapshot, so no historical cost
 * changes.
 *
 *   npx tsx scripts/backfill-recipe-default-expenses.ts           # preview
 *   npx tsx scripts/backfill-recipe-default-expenses.ts --apply   # apply
 */
import prisma from '../src/lib/prisma';
import { ProductionCostingService } from '../src/modules/production/production-costing.service';
import { RecipeService } from '../src/modules/recipes/recipe.service';

type Plan = 'APPLY_DEFAULTS' | 'KEEP_CUSTOM' | 'REVIEW';

async function main() {
  const apply = process.argv.includes('--apply');
  const categories = await ProductionCostingService.getExpenseCategories();
  const defaults = await ProductionCostingService.getDefaultRecipeExpenses(categories);
  const recipes = await prisma.recipe.findMany({ select: { id: true, recipeCode: true, name: true, expenseConfig: true }, orderBy: { name: 'asc' } });

  const rows = recipes.map((r) => {
    const cfg = r.expenseConfig as unknown;
    let plan: Plan;
    let note = '';
    if (cfg == null) {
      plan = 'APPLY_DEFAULTS';
    } else if (!Array.isArray(cfg) || cfg.length === 0) {
      plan = 'REVIEW';
      note = Array.isArray(cfg) ? 'saved as an empty list' : 'unreadable configuration';
    } else {
      const saved = new Set(cfg.map((e: any) => String(e?.category || '').toUpperCase()));
      const missing = categories.filter((c) => !saved.has(c.code)).map((c) => c.label);
      plan = missing.length ? 'REVIEW' : 'KEEP_CUSTOM';
      note = missing.length ? `missing: ${missing.join(', ')}` : '';
    }
    return { ...r, plan, note };
  });

  const label: Record<Plan, string> = { APPLY_DEFAULTS: 'apply defaults', KEEP_CUSTOM: 'keep (custom)', REVIEW: 'REVIEW — unchanged' };
  console.log(`Defaults: ${defaults.filter((d) => d.enabled).map((d) => `${d.label} ₹${d.rate} ${d.basis.replace('PER_', 'per ').toLowerCase()}`).join(' · ')}\n`);
  for (const r of rows) console.log(`${(r.recipeCode || '—').padEnd(10)} ${r.name.padEnd(40).slice(0, 40)} → ${label[r.plan]}${r.note ? ` (${r.note})` : ''}`);
  const toApply = rows.filter((r) => r.plan === 'APPLY_DEFAULTS');
  console.log(`\n${toApply.length} to update · ${rows.filter((r) => r.plan === 'KEEP_CUSTOM').length} kept · ${rows.filter((r) => r.plan === 'REVIEW').length} for review`);
  if (!apply) { console.log('\nPreview only — nothing changed. Re-run with --apply.'); return; }

  let updated = 0;
  for (const r of toApply) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Recipe" WHERE id = ${r.id} FOR UPDATE`;
      // Re-checked under the lock: configured meanwhile → leave it.
      const now = await tx.recipe.findUnique({ where: { id: r.id }, select: { expenseConfig: true } });
      if (now?.expenseConfig != null) return;
      await RecipeService.saveExpenseConfig(tx, r.id, defaults, categories, undefined);
      updated++;
    });
  }
  console.log(`\nDone: ${updated} recipe(s) updated.`);
}

main().catch((e) => { console.error(e?.message || e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
