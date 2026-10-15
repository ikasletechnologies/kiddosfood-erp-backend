-- Finished-goods variants created in Packaging (production cost only) can
-- exist without a selling price: "PENDING" until a price is set in Product
-- Master. Every existing product is "PRICED" — behaviour unchanged.
ALTER TABLE "Product" ADD COLUMN "pricingStatus" TEXT NOT NULL DEFAULT 'PRICED';
