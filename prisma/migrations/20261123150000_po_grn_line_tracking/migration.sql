-- PO / GRN line-level receipt tracking.
--
-- Additive only: new nullable / defaulted columns, indexes and foreign keys,
-- followed by a backfill of existing rows. No existing column, status value
-- or row is removed or rewritten beyond filling the new columns.
--
--   ProcurementOrderItem.receivedQty / pendingQty  receipt counters per PO line
--   GoodsReceipt.grnNumber (unique)                human GRN number
--   GoodsReceipt.vendorId                          vendor of the GRN (= PO vendor)
--   GoodsReceiptItem.poItemId                      PO line the GRN line fulfils

-- 1. Columns -----------------------------------------------------------------
ALTER TABLE "ProcurementOrderItem"
  ADD COLUMN "receivedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "pendingQty"  DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "GoodsReceipt"
  ADD COLUMN "grnNumber" TEXT,
  ADD COLUMN "vendorId"  TEXT;

ALTER TABLE "GoodsReceiptItem"
  ADD COLUMN "poItemId" TEXT;

-- 2. Indexes and foreign keys ---------------------------------------------------
CREATE UNIQUE INDEX "GoodsReceipt_grnNumber_key" ON "GoodsReceipt"("grnNumber");
CREATE INDEX "GoodsReceipt_poId_idx" ON "GoodsReceipt"("poId");
CREATE INDEX "GoodsReceiptItem_poItemId_idx" ON "GoodsReceiptItem"("poItemId");
CREATE INDEX "ProcurementOrderItem_poId_idx" ON "ProcurementOrderItem"("poId");

ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_poItemId_fkey"
  FOREIGN KEY ("poItemId") REFERENCES "ProcurementOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Backfill: GRN vendor = PO vendor -----------------------------------------
UPDATE "GoodsReceipt" g
SET "vendorId" = po."vendorId"
FROM "ProcurementOrder" po
WHERE po.id = g."poId" AND g."vendorId" IS NULL;

-- 4. Backfill: GRN numbers GRN-YYYY-NNNNN in creation order per year ----------
WITH numbered AS (
  SELECT id,
         EXTRACT(YEAR FROM "createdAt")::int AS yr,
         ROW_NUMBER() OVER (PARTITION BY EXTRACT(YEAR FROM "createdAt") ORDER BY "createdAt", id) AS n
  FROM "GoodsReceipt"
  WHERE "grnNumber" IS NULL
)
UPDATE "GoodsReceipt" g
SET "grnNumber" = 'GRN-' || numbered.yr || '-' || LPAD(numbered.n::text, 5, '0')
FROM numbered
WHERE numbered.id = g.id;

-- Continue numbering after the backfilled values (key GRN_<year>).
INSERT INTO "NumberSequence" ("key", "value")
SELECT 'GRN_' || EXTRACT(YEAR FROM "createdAt")::int, COUNT(*)
FROM "GoodsReceipt"
GROUP BY EXTRACT(YEAR FROM "createdAt")
ON CONFLICT ("key") DO UPDATE SET "value" = GREATEST("NumberSequence"."value", EXCLUDED."value");

-- 5. Backfill: link GRN lines to their PO line (same PO, same material) -------
UPDATE "GoodsReceiptItem" gi
SET "poItemId" = m.po_item_id
FROM (
  SELECT DISTINCT ON (gi2.id) gi2.id AS grn_item_id, poi.id AS po_item_id
  FROM "GoodsReceiptItem" gi2
  JOIN "GoodsReceipt" g ON g.id = gi2."grnId"
  JOIN "ProcurementOrderItem" poi ON poi."poId" = g."poId" AND poi."inventoryItemId" = gi2."materialId"
  WHERE gi2."poItemId" IS NULL
  ORDER BY gi2.id, poi.id
) m
WHERE gi.id = m.grn_item_id;

-- 6. Backfill: PO line receipt counters ----------------------------------------
-- Same definition as po-fulfilment.ts: fulfilled = accepted on COMPLETED GRNs
-- + completed GRN-rejection return quantity (matched by line name, capped at
-- what is still open after accepted), never above the ordered quantity.
WITH accepted AS (
  SELECT gi."poItemId" AS po_item_id, SUM(gi."acceptedQty") AS qty
  FROM "GoodsReceiptItem" gi
  JOIN "GoodsReceipt" g ON g.id = gi."grnId"
  WHERE g.status = 'COMPLETED' AND gi."poItemId" IS NOT NULL
  GROUP BY gi."poItemId"
),
returned AS (
  SELECT poi.id AS po_item_id, SUM(pri.quantity) AS qty
  FROM "PurchaseReturn" pr
  JOIN "PurchaseReturnItem" pri ON pri."returnId" = pr.id
  JOIN "ProcurementOrderItem" poi ON poi."poId" = pr."procurementOrderId"
  LEFT JOIN "InventoryItem" ii ON ii.id = poi."inventoryItemId"
  WHERE pr."returnSource" = 'GRN_REJECTION' AND pr.status = 'COMPLETED'
    AND LOWER(TRIM(pri."itemName")) = LOWER(TRIM(COALESCE(poi."itemName", ii.name, '')))
  GROUP BY poi.id
),
totals AS (
  SELECT poi.id,
         LEAST(poi.quantity,
               COALESCE(a.qty, 0) + LEAST(GREATEST(poi.quantity - COALESCE(a.qty, 0), 0), COALESCE(r.qty, 0))) AS received
  FROM "ProcurementOrderItem" poi
  LEFT JOIN accepted a ON a.po_item_id = poi.id
  LEFT JOIN returned r ON r.po_item_id = poi.id
)
UPDATE "ProcurementOrderItem" poi
SET "receivedQty" = totals.received,
    "pendingQty"  = CASE WHEN po."shortClosedAt" IS NOT NULL THEN 0
                         ELSE GREATEST(poi.quantity - totals.received, 0) END
FROM totals, "ProcurementOrder" po
WHERE totals.id = poi.id AND po.id = poi."poId";
