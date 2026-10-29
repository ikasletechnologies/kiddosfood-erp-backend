// Run only against the disposable database created for this test. Never seed or reset an ERP database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import express from 'express';
import prisma from '../../lib/prisma';
import { LotPricingController } from '../../modules/sales/lot-pricing.controller';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { resolvePosLine } from '../../modules/pos/pos.service';
import { ProductService } from '../../modules/product/product.service';
import { readPricing } from '../../modules/sales/sku-price-fields';

test('six-field migration, API persistence, lot reuse and historical snapshots', { timeout: 120000 }, async t => {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(process.env.KIDDOS_PRICING_TEST_DB, '1', 'Explicit disposable database opt-in required');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/kiddos_pricing_test');
  let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;
  try {
    const item = await prisma.inventoryItem.create({ data: { name: 'APPAM 500g', sku: 'FG-APPA-500G', category: 'FINISHED_GOOD', unit: 'PC', currentStock: 5, costPrice: 20, basePrice: 70, customerPrice: 100, dealerPrice: 80, franchisePrice: 70, gstRate: 5 } });
    const oldLot = await prisma.inventoryBatch.create({ data: { inventoryItemId: item.id, batchNumber: 'A', initialQty: 5, currentQty: 5, unitCost: 20, status: 'APPROVED' } });
    await t.test('additive migration preserves existing channel prices and lot costs', async () => {
      // Simulate the pre-migration table on this disposable database only, then apply the exact migration.
      await prisma.$executeRawUnsafe('ALTER TABLE "InventoryItem" DROP COLUMN "upcountryFranchisePrice", DROP COLUMN "mrp", DROP COLUMN "whiteLabelCost"');
      await prisma.$executeRawUnsafe(readFileSync('prisma/migrations/20261028120000_optional_sku_pricing_fields/migration.sql', 'utf8'));
      const migrated = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      assert.deepEqual(readPricing(migrated), { customerPrice: 100, dealerPrice: 80, franchisePrice: 70, upcountryFranchisePrice: null, mrp: null, whiteLabelCost: null });
      assert.equal((await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: oldLot.id } })).unitCost, 20);
    });
    const product = await prisma.product.create({ data: { name: item.name, sku: item.sku, basePrice: 70, taxPercent: 5, productType: 'FINISHED_GOOD', category: 'FINISHED_GOOD' } });
    const hq = await prisma.franchise.create({ data: { name: 'Test HQ', location: 'Test', ownerName: 'Test', contactNum: '0000000000', isHQ: true } });
    const order = await prisma.order.create({ data: { invoiceNum: 'HISTORICAL-1', franchiseId: hq.id, subTotal: 95, taxAmount: 4.75, totalAmount: 99.75, orderItems: { create: { productId: product.id, quantity: 1, price: 95, unitCost: 20 } }, invoice: { create: { totalAmount: 95, taxAmount: 4.75, finalAmount: 99.75 } } }, include: { invoice: true, orderItems: true } });
    const historical = JSON.stringify(order);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.user = { role: req.headers['x-test-role'] || 'SUPER_ADMIN' }; next(); });
    app.get('/api/sales/set-price/products', LotPricingController.listProducts);
    app.get('/api/sales/set-price/products/:id', LotPricingController.getProduct);
    app.put('/api/sales/set-price/products/:id/prices', LotPricingController.setProductPrices);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address() as { port: number };
    const base = 'http://127.0.0.1:' + address.port + '/api/sales/set-price/products';
    const get = async () => { const response = await fetch(base + '/' + item.id); assert.equal(response.status, 200); return response.json() as Promise<any>; };
    const put = async (body: any, status = 200, role = 'SUPER_ADMIN') => {
      const response = await fetch(base + '/' + item.id + '/prices', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
      const result: any = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
    };
    const six = { customerPrice: 100, dealerPrice: 80, franchisePrice: 70, upcountryFranchisePrice: 75, mrp: 120, whiteLabelCost: 55 };
    await t.test('all six values save and persist across independent API reads', async () => {
      const saved = await put({ ...six, taxInclusive: false });
      assert.equal(saved.pricingStatus, 'FULLY_PRICED');
      assert.deepEqual(readPricing(await get()), six);
      assert.deepEqual(readPricing(await get()), six);
    });
    await t.test('partial edits, explicit clears and optimistic concurrency preserve other fields', async () => {
      await put({ whiteLabelCost: 60 });
      assert.deepEqual(readPricing(await get()), { ...six, whiteLabelCost: 60 });
      await put({ mrp: null });
      assert.equal((await get()).mrp, null);
      await put({ whiteLabelCost: 61, expected: { whiteLabelCost: 55 } }, 409);
      await put({ mrp: 120, whiteLabelCost: 55 });
      await put({ mrp: 0 }, 400);
      await put({ mrp: 130 }, 403, 'CASHIER');
    });
    await t.test('GST conversion, MRP ceiling warnings and optional pricing status', async () => {
      await put({ upcountryFranchisePrice: 78.75, whiteLabelCost: 57.75, mrp: 120, taxInclusive: true });
      assert.deepEqual(readPricing(await get()), six);
      await put({ taxPercent: 12 });
      assert.equal((await get()).taxPercent, 12);
      const warning = await put({ mrp: 110 });
      assert.equal(warning.mrpWarnings.length, 1);
      assert.equal((await get()).customerPrice, 100);
      await put({ upcountryFranchisePrice: null, mrp: null, whiteLabelCost: null });
      assert.equal((await get()).pricingStatus, 'FULLY_PRICED');
      await put({ ...six, taxPercent: 5 });
    });
    await t.test('repeated production and purchase receipts reuse all prices and retain costs and quantities', async () => {
      for (const [i, cost] of [10, 20, 110, 90].entries()) {
        await prisma.$transaction(tx => InventoryService.recordMovement(tx, { itemId: item.id, type: i === 3 ? 'PURCHASE_IN' : 'PRODUCTION_IN', quantity: 5, receiveAtCost: { unitCost: cost, batchNumber: 'RECEIPT-' + i } }));
        assert.deepEqual(readPricing(await get()), six);
      }
      const lots = await prisma.inventoryBatch.findMany({ where: { inventoryItemId: item.id }, orderBy: { createdAt: 'asc' } });
      assert.deepEqual(lots.map(l => l.unitCost).sort((a, b) => a! - b!), [10, 20, 20, 90, 110]);
      const current = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      assert.equal(current.currentStock, 25);
      assert.equal(current.costPrice, 50); // Actual weighted lot costs; White Label Cost is 55.
      assert.equal((await get()).availableQty, 25);
      assert.equal((await get()).stockValue, 1250);
      await put({ mrp: 125, acknowledgeBelowCost: true });
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).costPrice, 50);
    });
    await t.test('SKU isolation, original sales channels, metadata edits and historical invoices', async () => {
      const other = await prisma.inventoryItem.create({ data: { name: 'APPAM 900g', sku: 'FG-APPA-900G', category: 'FINISHED_GOOD', unit: 'PC', currentStock: 0 } });
      const response = await fetch(base); const list: any = await response.json();
      assert.equal(list.products.find((p: any) => p.id === other.id).pricingStatus, 'PRICING_PENDING');
      assert.equal(list.summary.fullyPriced, 1);
      for (const [channel, price] of [['CUSTOMER', 100], ['DEALER', 80], ['FRANCHISE', 70]] as const) {
        const line = await resolvePosLine(prisma, { productId: product.id, quantity: 1, unit: 'PC' }, channel, null);
        assert.equal(line.unitPrice, price); assert.equal(line.lineTax, price * 0.05);
      }
      await ProductService.update(product.id, { description: 'Metadata edit only' });
      assert.deepEqual(readPricing(await get()), { ...six, mrp: 125 });
      assert.equal(JSON.stringify(await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { invoice: true, orderItems: true } })), historical);
    });
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});
