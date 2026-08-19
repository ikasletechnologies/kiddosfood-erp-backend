import prisma from './src/lib/prisma';
import { InventoryService } from './src/modules/inventory/inventory.service';

async function main() {
  const raw = await prisma.inventoryItem.findMany({
    where: { franchiseId: 'hq-001', isActive: true },
  });
  console.log('RAW findMany count (franchiseId=hq-001, isActive=true):', raw.length);
  for (const r of raw.slice(0, 5)) console.log(' -', r.name, r.category, r.isActive, r.franchiseId);

  const dosa = await prisma.inventoryItem.findFirst({ where: { name: { contains: 'masala', mode: 'insensitive' } } });
  console.log('DOSA ROW:', dosa);

  console.log('--- calling service ---');
  try {
    const result = await InventoryService.getRawMaterialStockSummary(undefined, 'hq-001', 'ALL' as any);
    console.log('SERVICE RESULT LENGTH:', result.length);
  } catch (e: any) {
    console.log('SERVICE THREW:', e.message, e.stack);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
