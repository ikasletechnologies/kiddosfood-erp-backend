// Single source of truth for the selling price applicable to a sales channel.
// Used by the product catalog (what POS search shows and lets you bill) and
// by POS checkout (what is actually charged), so the two can never disagree.
//
// Rule: the channel's own configured price (InventoryItem.customerPrice /
// dealerPrice / franchisePrice) when it is a positive number; otherwise the
// generic base price (InventoryItem.basePrice, then Product.basePrice);
// otherwise null — no valid price, the item cannot be billed. Channel prices
// default to 0 in the schema, which means "not configured", never "free".
// Values are coerced from string/Decimal-like input; NaN, null, undefined and
// non-positive values all count as "not configured".

export type SellingChannel = 'CUSTOMER' | 'DEALER' | 'FRANCHISE';

type PriceSource = {
  basePrice?: unknown;
  customerPrice?: unknown;
  dealerPrice?: unknown;
  franchisePrice?: unknown;
} | null | undefined;

const positive = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function resolveSellingPrice(
  channel: SellingChannel,
  inventoryItem: PriceSource,
  product: { basePrice?: unknown } | null | undefined
): number | null {
  const channelPrice =
    channel === 'DEALER' ? inventoryItem?.dealerPrice :
    channel === 'FRANCHISE' ? inventoryItem?.franchisePrice :
    inventoryItem?.customerPrice;
  return positive(channelPrice) ?? positive(inventoryItem?.basePrice) ?? positive(product?.basePrice);
}

export function resolveSellingPrices(
  inventoryItem: PriceSource,
  product: { basePrice?: unknown } | null | undefined
): Record<SellingChannel, number | null> {
  return {
    CUSTOMER: resolveSellingPrice('CUSTOMER', inventoryItem, product),
    DEALER: resolveSellingPrice('DEALER', inventoryItem, product),
    FRANCHISE: resolveSellingPrice('FRANCHISE', inventoryItem, product),
  };
}

/**
 * Product.pricingStatus: "PRICED" (default, every existing product) or
 * "PENDING" — a finished-goods variant created in Packaging, which records
 * production cost only. A pending product's basePrice column holds 0 purely
 * as storage (the column is required); 0 means "not configured", never free.
 * Saving a real price in Product Master marks it PRICED.
 */
export const PRICING_PENDING = 'PENDING';
export const PRICED = 'PRICED';

/**
 * Billing guard: a Pricing Pending product can only be billed once a real
 * selling price (> 0) resolves for the channel. Never bills it at ₹0.
 * Products that aren't pending are unaffected.
 */
export function assertBillablePrice(product: { name?: string; pricingStatus?: string | null } | null | undefined, rate: number | null | undefined) {
  if (product?.pricingStatus === PRICING_PENDING && !(Number(rate) > 0)) {
    throw new Error(`"${product.name || 'This product'}" is Pricing Pending — set its selling price in Product Master before billing it.`);
  }
}
