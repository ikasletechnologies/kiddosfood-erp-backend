-- Additive only: existing prices, lots and invoice snapshots are unchanged.
-- MRP includes GST. Upcountry Franchise Price and White Label Cost exclude GST.
ALTER TABLE "InventoryItem"
  ADD COLUMN "upcountryFranchisePrice" DECIMAL(14,2),
  ADD COLUMN "mrp" DECIMAL(14,2),
  ADD COLUMN "whiteLabelCost" DECIMAL(14,2);
