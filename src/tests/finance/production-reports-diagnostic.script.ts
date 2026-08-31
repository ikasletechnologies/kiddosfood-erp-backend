/**
 * READ-ONLY diagnostic for three "Production" reports: Production Planning,
 * QC & Inspection Report, Material Consumption Report. Calls the actual
 * service methods directly (bypassing HTTP/auth) against the LIVE database,
 * with (a) no filters, (b) a date range matching "This Month" 2026-08-01 to
 * 2026-08-31. Does not create/update/delete anything.
 *
 * Run: npx tsx src/tests/finance/production-reports-diagnostic.script.ts
 */
import prisma from '../../lib/prisma';
import { ProductionService } from '../../modules/production/production.service';
import { InventoryService } from '../../modules/inventory/inventory.service';

async function run(label: string, fn: () => Promise<any>) {
  const start = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - start;
    const len = Array.isArray(r) ? r.length : 'n/a';
    console.log(`OK   [${ms}ms] ${label} :: len=${len}`);
    if (Array.isArray(r) && r.length > 0) {
      console.log(`       sample keys: ${Object.keys(r[0]).join(', ')}`);
      console.log(`       sample: ${JSON.stringify(r[0]).slice(0, 500)}`);
    }
  } catch (err: any) {
    const ms = Date.now() - start;
    console.error(`FAIL [${ms}ms] ${label} :: ${err?.message}`);
  }
}

async function main() {
  console.log('=== Production Planning (ProductionService.getProductionHistory) ===');
  await run('no filters', () => ProductionService.getProductionHistory(undefined, undefined, undefined, undefined));
  await run('This Month range, no status', () => ProductionService.getProductionHistory(undefined, '2026-08-01', '2026-08-31', undefined));
  await run('status=PLANNED (as sent by reports/page.tsx dispatch case)', () => ProductionService.getProductionHistory(undefined, undefined, undefined, 'PLANNED'));
  await run('status=PLANNED + This Month range', () => ProductionService.getProductionHistory(undefined, '2026-08-01', '2026-08-31', 'PLANNED'));
  await run('status=PENDING (valid enum, for comparison)', () => ProductionService.getProductionHistory(undefined, undefined, undefined, 'PENDING'));

  console.log('\n=== QC & Inspection Report (ProductionService.getPendingQCBatches) ===');
  await run('no filters', () => ProductionService.getPendingQCBatches(undefined, undefined, undefined, undefined));
  await run('This Month range', () => ProductionService.getPendingQCBatches(undefined, '2026-08-01', '2026-08-31', undefined));

  console.log('\n=== Material Consumption Report (InventoryService.getRawMaterialConsumption) ===');
  await run('no filters', () => InventoryService.getRawMaterialConsumption(undefined, undefined, undefined, undefined, undefined));
  await run('This Month range', () => InventoryService.getRawMaterialConsumption(undefined, undefined, undefined, '2026-08-01', '2026-08-31'));

  console.log('\n=== Raw DB counts (read-only) ===');
  const productionCount = await prisma.production.count();
  const productionPlannedCount = await prisma.production.count({ where: { status: 'PENDING' } }).catch(e => `ERROR: ${e.message}`);
  const productBatchCount = await prisma.productBatch.count();
  const stockMovementConsumptionCount = await prisma.stockMovement.count({ where: { quantity: { lt: 0 } } });
  console.log(`prisma.production.count() = ${productionCount}`);
  console.log(`prisma.production.count({status: PENDING}) = ${productionPlannedCount}`);
  console.log(`prisma.productBatch.count() = ${productBatchCount}`);
  console.log(`prisma.stockMovement.count({quantity < 0}) = ${stockMovementConsumptionCount}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
