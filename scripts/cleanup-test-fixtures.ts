/**
 * Remove leftover automated-test fixtures from a local/dev database: the
 * warehouses, items, recipes and products tests create with a 13-digit
 * Date.now() stamp in their names ("Kitchen 1792151206239"), and every row
 * that depends on them. See src/tests/fixture-cleanup.ts.
 *
 *   npx tsx scripts/cleanup-test-fixtures.ts            # preview (default)
 *   npx tsx scripts/cleanup-test-fixtures.ts --apply    # delete
 */
import prisma from '../src/lib/prisma';
import { removeTestFixtures } from '../src/tests/fixture-cleanup';

const apply = process.argv.includes('--apply');
removeTestFixtures({ apply })
  .then((counts) => {
    if (!Object.keys(counts).length) console.log('No test fixtures found.');
    else console.log(apply ? '\nDone.' : '\nPreview only — nothing changed. Re-run with --apply.');
  })
  .catch((e) => { console.error(e.message || e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
