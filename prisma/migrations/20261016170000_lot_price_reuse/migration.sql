-- Automatic price reuse for finished-goods lots with an identical production
-- cost. Additive only: three nullable columns on InventoryBatch.
--   priceSource:      MANUAL (set in Set Price) | AUTO_REUSED (inherited at
--                     packaging from a manually priced lot of the same stock
--                     item and exact cost). Null = not priced / not a FG lot.
--   priceSourceLotId: the manually priced lot an AUTO_REUSED price came from.
--   pricingNote:      MULTIPLE_PRICE_MATCHES when several manual prices exist
--                     for the same item + cost (left for review, never guessed).
ALTER TABLE "InventoryBatch" ADD COLUMN "priceSource" TEXT;
ALTER TABLE "InventoryBatch" ADD COLUMN "priceSourceLotId" TEXT;
ALTER TABLE "InventoryBatch" ADD COLUMN "pricingNote" TEXT;

-- Every lot priced so far was priced by hand in Set Price.
UPDATE "InventoryBatch" SET "priceSource" = 'MANUAL' WHERE "sellingPrice" IS NOT NULL AND "sellingPrice" > 0;
