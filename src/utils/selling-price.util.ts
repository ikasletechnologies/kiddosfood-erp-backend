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
