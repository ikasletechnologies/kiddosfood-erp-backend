import prisma from '../../lib/prisma';

// Read-only verification. Does NOT call convertProformaToInvoice (that
// would create a real new Order/OrderItem row — a DB write, out of scope
// for verification). Instead: (1) proves Issue A's display fix against the
// real, already-existing INV-2026-00010 OrderItems, and (2) proves Issue
// B's mapping fix would produce the correct unit by applying the exact new
// mapping expression to the real, unmodified PI-2026-00007 items in memory.

function deriveTaxPercent(it: { taxPercent?: number; gstRate?: number; quantity: number; price: number; taxAmount: number }) {
  const stored = (it as any).taxPercent ?? (it as any).gstRate;
  if (stored !== undefined && stored !== null) return String(stored);
  const base = it.quantity * it.price;
  if (it.taxAmount > 0 && base > 0) return ((it.taxAmount / base) * 100).toFixed(0);
  return '—';
}

(async () => {
  const order = await prisma.order.findUnique({
    where: { invoiceNum: 'INV-2026-00010' },
    include: { orderItems: true },
  });
  if (!order) throw new Error('INV-2026-00010 not found');

  console.log('=== ISSUE A: Tax % display fix, run against REAL existing OrderItem rows ===');
  for (const it of order.orderItems) {
    console.log({
      orderItemId: it.id,
      quantity: it.quantity,
      price: it.price,
      taxAmount: it.taxAmount,
      OLD_display: `${(it as any).taxPercent ?? (it as any).gstRate ?? '—'}%`,
      NEW_display: `${deriveTaxPercent(it as any)}%`,
    });
  }

  console.log('\n=== ISSUE B: unit propagation ===');
  console.log('Existing (pre-fix) OrderItem.unit values on INV-2026-00010 — NOT modified, no DB row was patched:');
  console.log(order.orderItems.map(it => ({ id: it.id, unit: it.unit })));

  const proforma = await prisma.proformaInvoice.findUnique({
    where: { id: order.sourceProformaInvoiceId! },
    include: { items: true },
  });
  console.log('\nSource Proforma (PI-2026-00007) items — real, unmodified stored unit values:');
  console.log(proforma!.items.map(i => ({ id: i.id, unit: i.unit })));

  console.log('\nApplying the NEW convertProformaToInvoice mapping (in-memory only, no write) to those real Proforma items:');
  const simulatedNewOrderItems = proforma!.items.map((item) => ({
    quantity: item.quantity,
    unit: item.unit || 'NONE', // <- the fixed line
    price: item.rate,
    taxAmount: item.taxAmount,
    totalAmount: item.totalAmount,
  }));
  console.log(simulatedNewOrderItems);

  const allCorrect = simulatedNewOrderItems.every((it, i) => it.unit === proforma!.items[i].unit);
  console.log(`\nEvery simulated new OrderItem.unit matches its source ProformaInvoiceItem.unit: ${allCorrect ? '✅ YES' : '❌ NO'}`);

  console.log('\nNOTE: INV-2026-00010 itself was converted before this fix, so its stored OrderItem.unit stays "NONE" — the fix was not backfilled onto it, per "do not manually patch DB rows." Any Proforma converted to a Tax Invoice from now on will carry the correct unit.');

  await prisma.$disconnect();
})();
