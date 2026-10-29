import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { readPricing, mergePricing, mrpWarnings } from '../../modules/sales/sku-price-fields';
import { hasCompleteSkuPrices } from '../../utils/sku-pricing';

const existing = { customerPrice: 100, dealerPrice: 80, franchisePrice: 70, upcountryFranchisePrice: 75, mrp: 120, whiteLabelCost: 55 };
test('a partial update preserves all omitted prices and explicit null clears only that field', () => {
  assert.deepEqual(mergePricing(existing, { whiteLabelCost: 60 }, false, 5), { ...existing, whiteLabelCost: 60 });
  assert.deepEqual(mergePricing(existing, { mrp: null }, false, 5), { ...existing, mrp: null });
  assert.deepEqual(mergePricing(existing, { upcountryFranchisePrice: '' }, false, 5), { ...existing, upcountryFranchisePrice: null });
  assert.deepEqual(mergePricing(existing, { customerPrice: undefined }, true, 28), existing);
  const optionalBlank = { ...existing, upcountryFranchisePrice: null, mrp: null, whiteLabelCost: null };
  assert.equal(hasCompleteSkuPrices(optionalBlank), true);
});
test('Decimal conversion rounds once, keeps MRP inclusive, and never converts omitted fields', () => {
  assert.deepEqual(mergePricing(existing, { upcountryFranchisePrice: 78.75, mrp: 120, whiteLabelCost: 57.75 }, true, 5), existing);
  assert.equal(mergePricing(existing, { whiteLabelCost: 0.29 }, true, 18).whiteLabelCost, 0.25);
  assert.equal(readPricing({ ...existing, mrp: new Prisma.Decimal('120.10') }).mrp, 120.1);
});
test('invalid money is rejected, including zero, booleans, NaN, excessive precision and size', () => {
  for (const value of [0, -1, Infinity, NaN, true, {}, 'abc', 1.001, 10000000.01]) {
    assert.throws(() => mergePricing(existing, { mrp: value }, false, 5));
  }
});
test('MRP warnings compare the customer price including GST without changing any price', () => {
  assert.equal(mrpWarnings(existing, 5).length, 0);
  assert.equal(mrpWarnings({ ...existing, mrp: 104.99 }, 5).length, 1);
  assert.equal(mrpWarnings({ ...existing, mrp: 105 }, 5).length, 0);
  assert.equal(mrpWarnings({ ...existing, mrp: null }, 28).length, 0);
  assert.equal(existing.customerPrice, 100);
});
