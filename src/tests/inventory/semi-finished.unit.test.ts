import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeBulkLot, summarizeBulk } from '../../modules/inventory/semi-finished.service';
const fixture = (unit = 'KG') => ({ id: 'lot', initialQty: 20, currentQty: 11, unitCost: 100, status: 'APPROVED', batchNumber: 'BULK-1', inventoryItem: { id: 'family', sku: 'APPAM-BULK', name: 'APPAM - Bulk', unit }, productBatch: { id: 'batch', batchCode: 'B1', sourceType: 'PURCHASE', qcStatus: 'QC_NOT_REQUIRED', packagedQty: 9, franchiseId: 'hq', productId: 'fg-500', vendor: { name: 'Supplier' } } });
test('projects live physical balances, source traceability, valuation and exact packaging links', () => {
  const row = shapeBulkLot(fixture(), 9, 1, true);
  assert.equal(row.remainingQty, 11); assert.equal(row.availableQty, 10); assert.equal(row.packagedQty, 9);
  assert.equal(row.remainingValue, 1100); assert.equal(row.productName, 'APPAM'); assert.equal(row.familyId, 'family');
  assert.equal(row.sourceType, 'PURCHASE'); assert.equal(new URL(row.packagingUrl!, 'http://test').searchParams.get('bulkLotId'), 'lot');
});
test('expired and recalled bulk is visible but excluded from available totals', () => {
  const now = new Date('2026-10-28T05:00:00Z');
  const lot: any = fixture(); lot.expDate = new Date('2026-11-30T00:00:00Z'); lot.productBatch.expiryDate = new Date('2026-10-28T00:00:00Z');
  const expired = shapeBulkLot(lot, 9, 0, true, now);
  assert.equal(expired.status, 'EXPIRED'); assert.equal(expired.availableQty, 0);
  assert.equal(expired.remainingQty, 11); assert.equal(summarizeBulk([expired]).activeLots, 0);
  lot.productBatch.expiryDate = null; lot.productBatch.recall = { status: 'COMPLETED' };
  assert.equal(shapeBulkLot(lot, 9, 0, true, now).availableQty, 0);
});
test('never adds incompatible units and hides restricted costs', () => {
  const kg = shapeBulkLot(fixture('KG'), 9, 0, false);
  const litres = shapeBulkLot({ ...fixture('L'), id: 'litres' }, 9, 0, false);
  assert.deepEqual(summarizeBulk([kg, litres]).availableByUnit, { KG: 11, L: 11 });
  assert.equal(kg.unitCost, undefined); assert.equal(kg.remainingValue, undefined);
});
