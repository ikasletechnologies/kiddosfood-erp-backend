import prisma from '../src/lib/prisma';

// One-time backfill: WasteEntry rows logged as DAMAGED/SPOILAGE during
// Confirm Packaging carry a productPackagingId but never got a warehouseId
// (see ProductionService.confirmPackaging — the bug this fixes for new
// entries). Their original warehouse IS recoverable by joining back through
// productPackaging -> batch -> production -> warehouseId.
//
// QC_FAIL entries are deliberately left alone — WasteEntry stores no link
// back to the batch/production for those, so there is nothing to backfill
// from; assigning them a warehouse now would be a guess, not a recovery.
async function main() {
  console.log('Starting Waste Warehouse Backfill...');

  const candidates = await prisma.wasteEntry.findMany({
    where: {
      warehouseId: null,
      productPackagingId: { not: null },
    },
    include: {
      productPackaging: {
        include: {
          batch: {
            include: { production: { select: { warehouseId: true } } },
          },
        },
      },
    },
  });

  console.log(`Found ${candidates.length} DAMAGED/SPOILAGE entries with no warehouse recorded.`);

  let updated = 0;
  let skipped = 0;

  for (const entry of candidates) {
    const warehouseId = entry.productPackaging?.batch?.production?.warehouseId;
    if (!warehouseId) {
      console.log(`  -> Skipping ${entry.id}: no warehouseId on the source production run either.`);
      skipped++;
      continue;
    }

    await prisma.wasteEntry.update({
      where: { id: entry.id },
      data: { warehouseId },
    });
    console.log(`  -> Updated ${entry.id} (${entry.reason}) -> warehouse ${warehouseId}`);
    updated++;
  }

  console.log(`Backfill complete. Updated: ${updated}, Skipped: ${skipped}.`);
}

main().catch(e => {
  console.error('Backfill failed:', e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
