/**
 * Removes the records automated tests create, identified by the 13-digit
 * Date.now() stamp in their names ("Kitchen 1792151206239", "Rice Batter
 * 500g 1792151206239"). Finds those root rows (warehouses, items, recipes,
 * products, plus productions run in them), follows every foreign key to the
 * rows that depend on them and deletes children-first in one transaction.
 *
 * Refuses (deletes nothing) if any dependent row is a business document real
 * data could own (invoices, orders, ledgers, …).
 *
 * Used by scripts/cleanup-test-fixtures.ts and by tests to clean up after
 * themselves (pass that run's stamp).
 */
import prisma from '../lib/prisma';

const rootsFor = (stamp: string): Array<{ table: string; where: string }> => {
  const STAMP = `(^|[^0-9])${stamp}([^0-9]|$)`;
  return [
    { table: 'Warehouse', where: `name ~ '^(Kitchen|Store) ${stamp}$'` },
    { table: 'InventoryItem', where: `name ~ '${STAMP}' OR sku ~ '${STAMP}'` },
    { table: 'Recipe', where: `name ~ '${STAMP}'` },
    { table: 'Product', where: `name ~ '${STAMP}' OR sku ~ '${STAMP}'` },
  ];
};
// Dependents that may belong to real business documents: stop instead of deleting.
const GUARDED = new Set([
  'Invoice', 'InvoiceItem', 'SalesOrder', 'SalesOrderItem', 'Order', 'OrderItem', 'PosSale', 'PosSaleItem',
  'CustomerLedger', 'VendorLedger', 'FranchiseLedger', 'Payment', 'ProcurementOrder', 'GoodsReceipt',
  'DeliveryChallan', 'DeliveryChallanItem', 'Estimate', 'EstimateItem', 'ProformaInvoice', 'ProformaInvoiceItem',
]);

type Fk = { table: string; column: string; refTable: string; refColumn: string };

export async function removeTestFixtures(opts: { apply: boolean; stamp?: string; log?: boolean }): Promise<Record<string, number>> {
  const apply = opts.apply;
  const stamp = opts.stamp && /^[0-9]{13}$/.test(opts.stamp) ? opts.stamp : '17[0-9]{11}';
  const log = opts.log ?? true;
  const fks = await prisma.$queryRawUnsafe<Fk[]>(`
    SELECT tc.table_name AS "table", kcu.column_name AS "column", ccu.table_name AS "refTable", ccu.column_name AS "refColumn"
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);

  // ids to delete, per table
  const ids = new Map<string, Set<string>>();
  const add = (table: string, list: string[]) => {
    const set = ids.get(table) ?? new Set<string>();
    let added = 0;
    for (const id of list) if (!set.has(id)) { set.add(id); added++; }
    ids.set(table, set);
    return added;
  };
  for (const r of rootsFor(stamp)) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "${r.table}" WHERE ${r.where}`);
    add(r.table, rows.map((x) => x.id));
  }
  // Productions run in a test warehouse or on a test recipe are test runs too.
  const wh = [...(ids.get('Warehouse') ?? [])];
  const rc = [...(ids.get('Recipe') ?? [])];
  if (wh.length || rc.length) {
    const prods = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Production" WHERE "warehouseId" = ANY($1::text[]) OR "recipeId" = ANY($2::text[])`, wh, rc);
    add('Production', prods.map((x) => x.id));
  }

  // Follow foreign keys to every dependent row (fixed point).
  const pkOf = async (table: string) => {
    const r = await prisma.$queryRawUnsafe<Array<{ c: string }>>(`
      SELECT kcu.column_name AS c FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1`, table);
    return r.length === 1 ? r[0].c : null;
  };
  const pks = new Map<string, string | null>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fk of fks) {
      const parents = ids.get(fk.refTable);
      if (!parents?.size || fk.refColumn !== 'id') continue;
      if (!pks.has(fk.table)) pks.set(fk.table, await pkOf(fk.table));
      const pk = pks.get(fk.table);
      if (!pk) continue; // join tables without a single id are handled by ON DELETE / below
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "${pk}"::text AS id FROM "${fk.table}" WHERE "${fk.column}" = ANY($1::text[])`, [...parents]);
      if (add(fk.table, rows.map((x) => x.id))) changed = true;
    }
  }

  const summary = [...ids.entries()].filter(([, s]) => s.size).sort(([a], [b]) => a.localeCompare(b));
  const counts = Object.fromEntries(summary.map(([t, s]) => [t, s.size]));
  if (log && summary.length) {
    console.log(`${apply ? 'Deleting' : 'Would delete'}:`);
    for (const [t, s] of summary) console.log(`  ${t.padEnd(36)} ${s.size}`);
  }
  const blocked = summary.filter(([t]) => GUARDED.has(t));
  if (blocked.length) {
    throw new Error(`Test records are referenced by business documents (${blocked.map(([t, s]) => `${t} ×${s.size}`).join(', ')}). Nothing deleted.`);
  }
  if (!apply || !summary.length) return counts;

  // Delete children first: repeatedly delete rows of tables nothing pending still references.
  await prisma.$transaction(async (tx) => {
    const pending = new Map(summary.map(([t, s]) => [t, [...s]]));
    while (pending.size) {
      const ready = [...pending.keys()].filter((t) =>
        !fks.some((fk) => fk.refTable === t && fk.table !== t && pending.has(fk.table)));
      if (!ready.length) throw new Error(`Cannot order deletes for: ${[...pending.keys()].join(', ')}`);
      for (const t of ready) {
        const pk = pks.get(t) ?? 'id';
        // Self-references (e.g. a lot pointing at another lot) are cleared first.
        for (const fk of fks.filter((f) => f.table === t && f.refTable === t)) {
          await tx.$executeRawUnsafe(`UPDATE "${t}" SET "${fk.column}" = NULL WHERE "${pk}"::text = ANY($1::text[])`, pending.get(t)!);
        }
        await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "${pk}"::text = ANY($1::text[])`, pending.get(t)!);
        pending.delete(t);
      }
    }
  }, { timeout: 120_000 });
  return counts;
}

/** For a test's .finally(): remove this run's fixtures; never fails the test run. */
export async function cleanupTestRun(stamp: number | string) {
  try {
    await removeTestFixtures({ apply: true, stamp: String(stamp), log: false });
  } catch (e: any) {
    console.warn(`⚠️  Test fixture cleanup skipped: ${e.message}`);
  }
}

