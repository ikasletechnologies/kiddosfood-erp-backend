import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredSkuPrices, hasCompleteSkuPrices, resolveSkuPriceMaster } from '../../utils/sku-pricing';
import { resolveSellingPrice } from '../../utils/selling-price.util';
import { checkLotPrice } from '../../modules/sales/lot-pricing';

test('all three independent tiers must be finite positive prices', () => {
  assert.equal(hasCompleteSkuPrices({}), false);
  assert.equal(hasCompleteSkuPrices({ customerPrice: 100, dealerPrice: 80 }), false);
  for (const value of [0, -1, Infinity, NaN, null]) assert.equal(hasCompleteSkuPrices({ customerPrice: 100, dealerPrice: 80, franchisePrice: value }), false);
  assert.deepEqual(configuredSkuPrices({ customerPrice: '100', dealerPrice: 80, franchisePrice: 70 }), { customerPrice: 100, dealerPrice: 80, franchisePrice: 70 });
});

test('exact SKU master is reused for repeated production and purchased lot costs', async () => {
  const master = { id: 'sku-500', customerPrice: 100, dealerPrice: 80, franchisePrice: 70, basePrice: 70, gstRate: 5 };
  const tx = { inventoryItem: { findFirst: async (query: any) => {
    assert.equal(query.where.category, 'FINISHED_GOOD');
    assert.ok(query.where.OR.some((scope: any) => scope.franchiseId === null));
    return query.where.sku === 'FG-APPA-500G' ? master : null;
  } } } as any;
  for (const cost of [10, 20, 65, 110, 90]) {
    const prices = await resolveSkuPriceMaster(tx, 'FG-APPA-500G');
    assert.equal(hasCompleteSkuPrices(prices!), true);
    for (const [channel, expected] of [['CUSTOMER', 100], ['DEALER', 80], ['FRANCHISE', 70]] as const) {
      const price = resolveSellingPrice(channel, prices, null)!;
      assert.equal(price, expected);
      assert.equal(checkLotPrice({ price, taxInclusive: false, taxPercent: 5, unitCost: cost }).unitProfit, expected - cost);
    }
  }
  assert.equal(await resolveSkuPriceMaster(tx, 'FG-APPA-900G'), null);
  assert.equal(master.customerPrice, 100);
  assert.equal(checkLotPrice({ price: 105, taxInclusive: true, taxPercent: 5, unitCost: 110 }).unitProfit, -10);
});
