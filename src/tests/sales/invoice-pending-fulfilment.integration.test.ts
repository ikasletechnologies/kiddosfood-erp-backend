// This suite refuses to run outside a fresh, explicitly opted-in disposable database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';
import { FinanceController } from '../../modules/finance/finance.controller';
import { SalesService } from '../../modules/sales/sales.service';
import { ProductService } from '../../modules/product/product.service';
import { InventoryService } from '../../modules/inventory/inventory.service';
import { InvoiceFulfilmentService, compareFefo } from '../../modules/sales/invoice-fulfilment.service';
import { resolvePosLine } from '../../modules/pos/pos.service';

test('FEFO uses earliest expiry, then receipt FIFO, and puts unknown expiry last', () => {
  const rows = [{ id: 'none', expDate: null, createdAt: '2020-01-01' }, { id: 'B', expDate: '2026-11-05', createdAt: '2020-01-01' }, { id: 'A2', expDate: '2026-10-30', receivedAt: '2026-10-20' }, { id: 'A1', expDate: '2026-10-30', receivedAt: '2026-10-19' }];
  assert.deepEqual(rows.sort(compareFefo).map(l => l.id), ['A1', 'A2', 'B', 'none']);
});
test('stock-independent invoices and authoritative fulfilment', { timeout: 180000 }, async t => {
  const target = new URL(process.env.DATABASE_URL || '');
  assert.equal(process.env.KIDDOS_INVOICE_TEST_DB, '1'); assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.pathname, '/kiddos_invoice_test');
  let server: any;
  try {
    assert.equal(await prisma.order.count(), 0, 'Requires an empty disposable database');
    const hq = await prisma.franchise.create({ data: { name: 'HQ', location: 'Test', ownerName: 'Test', contactNum: '0', isHQ: true } });
    const branch = await prisma.franchise.create({ data: { name: 'Branch', location: 'Test', ownerName: 'Test', contactNum: '1' } });
    const customer = await prisma.customer.create({ data: { name: 'Customer', phone: '9999999999' } });
    const dealer = await prisma.dealer.create({ data: { name: 'Dealer', franchiseId: hq.id } });
    const warehouse = await prisma.warehouse.create({ data: { name: 'Main', nameKey: 'main' } });
    const warehouseB = await prisma.warehouse.create({ data: { name: 'Other', nameKey: 'other' } });
    await prisma.account.create({ data: { name: 'Cash', type: 'CASH', franchiseId: hq.id, balance: 0 } });
    const product = await ProductService.create({ name: 'APPAM 500g', sku: 'FG-APPA-500G', basePrice: 70, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', taxPercent: 5 });
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: product.sku! } });
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { customerPrice: 100, dealerPrice: 80, franchisePrice: 70 } });
    const app = express(); app.use(express.json()); app.use((req: any, _res, next) => { req.user = { role: 'SUPER_ADMIN', fullName: 'Test' }; next(); });
    app.post('/api/sales/invoices', FinanceController.createInvoice);
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/sales/invoices';
    const create = async (quantity: number, extras: any = {}, productId = product.id) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ franchiseId: hq.id, pendingAllocationConfirmed: true, partyType: 'CUSTOMER', customerId: customer.id, partyId: customer.id, items: [{ productId, quantity, unit: 'PC', price: 1, taxPercent: 28 }], ...extras }) });
      const result: any = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result;
    };
    const receive = async (quantity: number, cost: number, batchNumber: string, days: number | null, itemId = item.id, warehouseId = warehouse.id) => {
      await prisma.$transaction(tx => InventoryService.recordMovement(tx, { itemId, type: 'PURCHASE_IN', quantity, warehouseId, receiveAtCost: { unitCost: cost, batchNumber, ...(days == null ? {} : { expDate: new Date(Date.now() + days * 86400000) }) } }));
      return prisma.inventoryBatch.findFirstOrThrow({ where: { inventoryItemId: itemId, batchNumber } });
    };
    const dispatch = (orderId: string, quantity: number, overrides: any = {}, productId = product.id) => SalesService.createDeliveryChallan({ customerId: customer.id, sourceFranchiseId: hq.id, sourceInvoiceId: orderId, status: 'IN_TRANSIT', items: [{ productId, productName: 'APPAM', quantity, unit: 'PC', rate: 999, taxPercent: 28 }], ...overrides }, 'test');
    await assert.rejects(FinanceService.createInvoice({ franchiseId: hq.id, deferFulfillment: true, items: [{ productId: product.id, quantity: -1, unit: 'PC' }] } as any), /positive, finite quantities/);
    let zero: any, paid: any;
    await t.test('zero stock invoice is numbered, taxed, printable through the existing detail API, and leaves all quantity pending', async () => {
      zero = await create(10);
      assert.ok(zero.order.invoiceNum); assert.equal(zero.finalAmount, 1050); assert.equal(zero.taxAmount, 50);
      const saved = await FinanceService.getInvoiceById(zero.id); assert.equal(saved.order.orderItems[0].price, 100); assert.equal(saved.order.orderItems[0].quantity, 10);
      assert.equal(saved.order.orderItems[0].totalCost, 0); assert.equal(saved.order.inventory_deducted, false);
      assert.equal((await InvoiceFulfilmentService.state(prisma, zero.orderId)).lines[0].pendingQty, 10);
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock, 0);
      assert.equal(await prisma.inventoryBatch.count(), 0); assert.equal(await prisma.stockMovement.count(), 0);
    });
    const a = await receive(5, 60, 'A', 2); const b = await receive(10, 70, 'B', 8);
    await t.test('multiple lots return choices without allocating, reserving or deducting stock', async () => {
      const before = await prisma.stockMovement.count();
      const suggestion = await InvoiceFulfilmentService.options(prisma, { productId: product.id, quantity: 8, unit: 'PC', franchiseId: hq.id }, true);
      assert.deepEqual(suggestion.allocations, []); assert.equal(suggestion.allocatedQty, 0); assert.equal(suggestion.pendingQty, 8);
      await assert.rejects(FinanceService.createInvoice({ franchiseId: hq.id, deferFulfillment: true, partyType: 'CUSTOMER', customerId: customer.id, items: [{ productId: product.id, quantity: 8, unit: 'PC' }] } as any), /Confirm unallocated/);
      assert.equal(await prisma.stockMovement.count(), before); assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock, 15);
    });
    await t.test('manual proposals persist exact split quantities, validate scope and require confirmation for pending stock', async () => {
      const request = (allocations: any[], quantity = 8, extra: any = {}) => FinanceService.createInvoice({ franchiseId: hq.id, deferFulfillment: true, partyType: 'CUSTOMER', customerId: customer.id, items: [{ productId: product.id, quantity, unit: 'PC', lotAllocations: allocations, ...extra }] } as any);
      const before = await prisma.stockMovement.count();
      await assert.rejects(request([{ lotId: a.id, quantity: 6 }]), /availability/);
      await assert.rejects(request([{ lotId: a.id, quantity: 5 }, { lotId: b.id, quantity: 4 }]), /invoice quantity/);
      await assert.rejects(request([{ lotId: a.id, quantity: 2 }]), /Confirm unallocated/);
      await assert.rejects(request([{ lotId: a.id, quantity: 2 }], 2, { warehouseId: warehouseB.id }), /warehouse/);
      await assert.rejects(request([{ lotId: a.id, quantity: -1 }]), /positive, finite/);
      const invoice = await request([{ lotId: a.id, quantity: 2 }, { lotId: b.id, quantity: 6 }]);
      const rows = (await FinanceService.getInvoiceById(invoice.id)).order.orderItems;
      assert.deepEqual(rows.map(l => [l.inventoryBatchId, l.quantity]).sort(), [[a.id, 2], [b.id, 6]].sort());
      assert.equal(invoice.finalAmount, 840); assert.equal(await prisma.stockMovement.count(), before);
      assert.equal((await InvoiceFulfilmentService.state(prisma, invoice.orderId)).status, 'PENDING');
      const partial = await create(8, { items: [{ productId: product.id, quantity: 8, unit: 'PC', lotAllocations: [{ lotId: a.id, quantity: 2 }] }] });
      const partialRows = (await FinanceService.getInvoiceById(partial.id)).order.orderItems;
      assert.equal(partialRows.filter(l => l.inventoryBatchId).reduce((n,l) => n + l.quantity, 0), 2);
      assert.equal(partialRows.filter(l => !l.inventoryBatchId).reduce((n,l) => n + l.quantity, 0), 6);
    });
    await t.test('paid with sufficient stock still stays pending until dispatch; dispatch posts once with actual lot costs', async () => {
      paid = await create(8, { receivedAmount: 840 });
      assert.equal((await FinanceService.getInvoiceById(paid.id)).order.paymentStatus, 'PAID');
      assert.equal((await InvoiceFulfilmentService.state(prisma, paid.orderId)).status, 'PENDING');
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock, 15);
      await assert.rejects(() => dispatch(paid.orderId, 8), /Select lots/);
      const dc = await dispatch(paid.orderId, 8, { items: [{ productId: product.id, productName: product.name, quantity: 5, unit: 'PC', inventoryBatchId: a.id }, { productId: product.id, productName: product.name, quantity: 3, unit: 'PC', inventoryBatchId: b.id }] }); assert.equal(dc.items[0].rate, 100); assert.equal(dc.items[0].taxPercent, 5);
      assert.equal((await InvoiceFulfilmentService.state(prisma, paid.orderId)).status, 'FULFILLED');
      assert.equal((await prisma.orderItem.findFirstOrThrow({ where: { orderId: paid.orderId } })).totalCost, 510);
      const movements = await prisma.stockMovement.findMany({ where: { referenceType: 'INVOICE_FULFILMENT', referenceId: dc.id } });
      assert.deepEqual(movements.map(m => m.batchId).sort(), [a.id, b.id].sort());
      await SalesService.updateDeliveryChallan(dc.id, { status: 'IN_TRANSIT' });
      await assert.rejects(() => dispatch(paid.orderId, 1), /outstanding|dispatch/i);
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock, 7);
    });
    await t.test('partial stock invoices permit later receipt, partial fulfilment and concurrency-safe final dispatch', async () => {
      const p = await ProductService.create({ name: 'APPAM 900g', sku: 'FG-APPA-900G', basePrice: 100, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', taxPercent: 5 });
      const stock = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: p.sku! } });
      await receive(4, 60, 'PARTIAL-A', 10, stock.id);
      const inv = await create(10, {}, p.id);
      const preview = await InvoiceFulfilmentService.options(prisma, { productId: p.id, quantity: 10, unit: 'PC', franchiseId: hq.id }, true);
      assert.equal(preview.allocatedQty, 4); assert.equal(preview.pendingQty, 6);
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).currentStock, 4);
      await dispatch(inv.orderId, 4, {}, p.id); const partial = await InvoiceFulfilmentService.state(prisma, inv.orderId);
      assert.equal(partial.status, 'PARTIALLY_FULFILLED'); assert.equal(partial.lines.reduce((sum: number, l: any) => sum + l.pendingQty, 0), 6);
      assert.equal((await prisma.orderItem.aggregate({ where: { orderId: inv.orderId }, _sum: { totalCost: true } }))._sum.totalCost, 240);
      const proposals = (await FinanceService.getInvoiceById(inv.id)).order.orderItems;
      assert.equal(proposals.filter(l => l.inventoryBatchId).reduce((sum,l) => sum + l.quantity, 0), 4);
      await receive(6, 70, 'PARTIAL-B', 20, stock.id);
      const results = await Promise.allSettled([dispatch(inv.orderId, 6, {}, p.id), dispatch(inv.orderId, 6, {}, p.id)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await InvoiceFulfilmentService.state(prisma, inv.orderId)).status, 'FULFILLED');
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).currentStock, 0);
      assert.equal((await prisma.orderItem.aggregate({ where: { orderId: inv.orderId }, _sum: { totalCost: true } }))._sum.totalCost, 660);
    });
    await t.test('manual lots, dispatch reversal, and saved invoice tax/prices survive master changes', async () => {
      const inv = await create(2, { partyType: 'DEALER', partyId: dealer.id, customerId: undefined });
      const snapshot = JSON.stringify((await FinanceService.getInvoiceById(inv.id)).order.orderItems.map((l: any) => ({ price: l.price, quantity: l.quantity, taxAmount: l.taxAmount })));
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { dealerPrice: 200, gstRate: 18 } });
      const dc = await dispatch(inv.orderId, 2, { customerId: undefined, dealerId: dealer.id, items: [{ productId: product.id, productName: product.name, quantity: 2, unit: 'PC', rate: 999, taxPercent: 28, inventoryBatchId: b.id }] });
      assert.equal(dc.items[0].rate, 80); assert.equal(dc.items[0].taxPercent, 5);
      assert.equal((await prisma.orderItem.aggregate({ where: { orderId: inv.orderId }, _sum: { totalCost: true } }))._sum.totalCost, 140);
      const balance = (await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: b.id } })).currentQty;
      await SalesService.updateDeliveryChallan(dc.id, { status: 'CANCELLED' });
      assert.equal((await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: b.id } })).currentQty, balance + 2);
      assert.equal((await InvoiceFulfilmentService.state(prisma, inv.orderId)).status, 'PENDING');
      assert.equal((await prisma.orderItem.findFirstOrThrow({ where: { orderId: inv.orderId } })).totalCost, 0);
      assert.equal(JSON.stringify((await FinanceService.getInvoiceById(inv.id)).order.orderItems.map((l: any) => ({ price: l.price, quantity: l.quantity, taxAmount: l.taxAmount }))), snapshot);
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { dealerPrice: 80, gstRate: 5 } });
    });
    await t.test('expired, recalled, blocked, unapproved, reserved and other-warehouse quantities are excluded', async () => {
      await receive(10, 10, 'EXPIRED', -1);
      const blocked = await receive(10, 10, 'BLOCKED', 5); await prisma.inventoryBatch.update({ where: { id: blocked.id }, data: { status: 'BLOCKED' } });
      const hold = await receive(10, 10, 'HOLD', 5); await prisma.inventoryBatch.update({ where: { id: hold.id }, data: { status: 'QC_HOLD' } });
      const pb = await prisma.productBatch.create({ data: { batchCode: 'RECALLED', quantity: 10, franchiseId: hq.id, productId: product.id, qcStatus: 'QC_NOT_REQUIRED' } });
      await prisma.batchRecall.create({ data: { productBatchId: pb.id, reason: 'Test' } });
      const recalled = await receive(10, 10, 'RECALL', 5); await prisma.inventoryBatch.update({ where: { id: recalled.id }, data: { productBatchId: pb.id } });
      await receive(9, 10, 'OTHER-WAREHOUSE', 5, item.id, warehouseB.id);
      const frOrder = await prisma.franchiseOrder.create({ data: { orderNumber: 'RESERVED', franchiseId: branch.id, totalAmount: 70 } });
      await prisma.inventoryReservation.create({ data: { franchiseOrderId: frOrder.id, allocations: { create: { inventoryBatchId: b.id, inventoryItemId: item.id, reservedQty: 2 } } } });
      const options = await InvoiceFulfilmentService.options(prisma, { productId: product.id, quantity: 100, franchiseId: hq.id, warehouseId: warehouse.id }, true);
      assert.deepEqual(options.lots.map((l: any) => l.id), [b.id]); assert.equal(options.availableQty, 5);
      const branchCatalog: any[] = await ProductService.getAll({}, branch.id, true); const entry = branchCatalog.find(p => p.id === product.id);
      assert.equal(entry.currentStock, 0); assert.equal(entry.unit, 'PC'); assert.equal(entry.sellingPrices.CUSTOMER, 100);
    });
    await t.test('duplicate SKU lines cannot over-dispatch and cancellation reverses their actual costs once', async () => {
      const inv = await create(2, { items: [{ productId: product.id, quantity: 1, unit: 'PC' }, { productId: product.id, quantity: 1, unit: 'PC' }] });
      const before = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock;
      await assert.rejects(() => dispatch(inv.orderId, 4, { items: [{ productId: product.id, productName: product.name, quantity: 2, unit: 'PC', inventoryBatchId: b.id }, { productId: product.id, productName: product.name, quantity: 2, unit: 'PC', inventoryBatchId: b.id }] }), /outstanding/i);
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock, before);
      const dc = await dispatch(inv.orderId, 2, { items: [{ productId: product.id, productName: product.name, quantity: 1, unit: 'PC', inventoryBatchId: b.id }, { productId: product.id, productName: product.name, quantity: 1, unit: 'PC', inventoryBatchId: b.id }] });
      await SalesService.updateDeliveryChallan(dc.id, { status: 'CANCELLED' });
      const lines = await prisma.orderItem.findMany({ where: { orderId: inv.orderId } });
      assert.ok(lines.every(l => l.totalCost === 0));
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).currentStock, before);
    });
    await t.test('explicit manual splits and competing invoices share physical stock safely', async () => {
      const p = await ProductService.create({ name: 'FIFO Item', sku: 'FG-FIFO-500G', basePrice: 100, category: 'FINISHED_GOOD', productType: 'FINISHED_GOOD', taxPercent: 5 });
      const stock = await prisma.inventoryItem.findFirstOrThrow({ where: { sku: p.sku! } });
      const old = await receive(3, 20, 'FIFO-OLD', null, stock.id);
      const next = await receive(2, 30, 'FIFO-NEW', null, stock.id);
      const preview = await InvoiceFulfilmentService.options(prisma, { productId: p.id, quantity: 4, unit: 'PC', franchiseId: hq.id }, true);
      assert.deepEqual(preview.allocations, []);
      const first = await create(4, {}, p.id), second = await create(4, {}, p.id);
      const manual = { items: [{ productId: p.id, productName: p.name, quantity: 3, unit: 'PC', inventoryBatchId: old.id }, { productId: p.id, productName: p.name, quantity: 1, unit: 'PC', inventoryBatchId: next.id }] };
      const results = await Promise.allSettled([dispatch(first.orderId, 4, manual, p.id), dispatch(second.orderId, 4, manual, p.id)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).currentStock, 1);
    });
    await t.test('Customer, Dealer and Franchise pricing, discounts, POS and Sales Orders keep their existing rules', async () => {
      for (const [partyType, partyId, price] of [['CUSTOMER', customer.id, 100], ['DEALER', dealer.id, 80], ['FRANCHISE', branch.id, 70]] as const) {
        const inv = await create(1, { partyType, partyId, customerId: partyType === 'CUSTOMER' ? customer.id : undefined });
        assert.equal((await FinanceService.getInvoiceById(inv.id)).order.orderItems[0].price, price);
        assert.equal((await resolvePosLine(prisma, { productId: product.id, quantity: 1, unit: 'PC' }, partyType, null)).unitPrice, price);
      }
      const discounted = await create(2, { items: [{ productId: product.id, quantity: 2, unit: 'PC', discountPct: 10 }], deliveryCharge: 3, roundOffEnabled: true });
      assert.equal(discounted.finalAmount, 192); // 200 - 20 + GST 9 + delivery 3.
      const so = await SalesService.createSalesOrder({ customerId: customer.id, partyType: 'CUSTOMER', items: [{ productId: product.id, productName: product.name, quantity: 1, unit: 'PC', rate: 999 }] });
      assert.ok(so.id); const saved = await FinanceService.getInvoiceById(zero.id); assert.equal(saved.order.orderItems[0].price, 100); assert.equal(saved.finalAmount, 1050);
    });
  } finally { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); }
});
