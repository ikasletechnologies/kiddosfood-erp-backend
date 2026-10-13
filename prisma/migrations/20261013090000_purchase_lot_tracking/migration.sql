-- AlterTable
ALTER TABLE "PurchaseReturnItem" ADD COLUMN     "baseQty" DOUBLE PRECISION,
ADD COLUMN     "inventoryBatchId" TEXT,
ADD COLUMN     "materialId" TEXT,
ADD COLUMN     "unitCost" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "InventoryBatch" ADD COLUMN     "goodsReceiptItemId" TEXT,
ADD COLUMN     "procurementOrderId" TEXT,
ADD COLUMN     "purchasePrice" DOUBLE PRECISION,
ADD COLUMN     "purchaseQty" DOUBLE PRECISION,
ADD COLUMN     "purchaseUnit" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "vendorId" TEXT;

-- CreateIndex
CREATE INDEX "PurchaseReturnItem_inventoryBatchId_idx" ON "PurchaseReturnItem"("inventoryBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBatch_goodsReceiptItemId_key" ON "InventoryBatch"("goodsReceiptItemId");

-- CreateIndex
CREATE INDEX "InventoryBatch_vendorId_idx" ON "InventoryBatch"("vendorId");

-- CreateIndex
CREATE INDEX "InventoryBatch_procurementOrderId_idx" ON "InventoryBatch"("procurementOrderId");

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_inventoryBatchId_fkey" FOREIGN KEY ("inventoryBatchId") REFERENCES "InventoryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_goodsReceiptItemId_fkey" FOREIGN KEY ("goodsReceiptItemId") REFERENCES "GoodsReceiptItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_procurementOrderId_fkey" FOREIGN KEY ("procurementOrderId") REFERENCES "ProcurementOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBatch" ADD CONSTRAINT "InventoryBatch_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: link purchase lots that GRN approval created before these
-- columns existed. Such a lot's only link to its receipt is billNumber,
-- which GRN approval also used as the auto-generated vendor bill's
-- invoiceNumber (with grnId set). A lot is linked only when exactly one
-- accepted GRN line of that GRN matches it (same material, same lot
-- number) and that line matches no other lot, so nothing is guessed.
-- Lots with no bill (zero-value receipts) stay unlinked and still display,
-- just without supplier/PO details.
WITH candidates AS (
  SELECT
    b."id"            AS batch_id,
    gi."id"           AS gi_id,
    g."poId"          AS po_id,
    po."vendorId"     AS vendor_id,
    g."receivedAt"    AS received_at,
    gi."acceptedQty"  AS purchase_qty,
    gi."unit"         AS purchase_unit,
    gi."price"        AS purchase_price
  FROM "InventoryBatch" b
  JOIN "VendorInvoice" vi    ON vi."invoiceNumber" = b."billNumber" AND vi."grnId" IS NOT NULL
  JOIN "GoodsReceipt" g      ON g."id" = vi."grnId" AND g."status" = 'COMPLETED'
  JOIN "GoodsReceiptItem" gi ON gi."grnId" = g."id"
                            AND gi."materialId" = b."inventoryItemId"
                            AND gi."acceptedQty" > 0
                            AND gi."lotNumber" IS NOT DISTINCT FROM b."lotNumber"
  JOIN "ProcurementOrder" po ON po."id" = g."poId"
  WHERE b."goodsReceiptItemId" IS NULL
    AND b."billNumber" IS NOT NULL
),
unique_pairs AS (
  SELECT c.* FROM candidates c
  WHERE (SELECT count(*) FROM candidates c2 WHERE c2.batch_id = c.batch_id) = 1
    AND (SELECT count(*) FROM candidates c3 WHERE c3.gi_id = c.gi_id) = 1
)
UPDATE "InventoryBatch" b
SET "goodsReceiptItemId" = u.gi_id,
    "procurementOrderId" = u.po_id,
    "vendorId"           = u.vendor_id,
    "receivedAt"         = u.received_at,
    "purchaseQty"        = u.purchase_qty,
    "purchaseUnit"       = u.purchase_unit,
    "purchasePrice"      = u.purchase_price
FROM unique_pairs u
WHERE b."id" = u.batch_id;

-- Second pass, for lots whose bill no longer exists (or never did): match
-- on the GRN line's own lot number. GRN lot numbers are unique by
-- construction (atomic LOT-<date>-<seq>, or a manual value checked for
-- uniqueness at GRN creation), so together with the material and a
-- one-to-one guard this identifies the receipt without guessing.
WITH candidates AS (
  SELECT
    b."id"            AS batch_id,
    gi."id"           AS gi_id,
    g."poId"          AS po_id,
    po."vendorId"     AS vendor_id,
    g."receivedAt"    AS received_at,
    gi."acceptedQty"  AS purchase_qty,
    gi."unit"         AS purchase_unit,
    gi."price"        AS purchase_price
  FROM "InventoryBatch" b
  JOIN "GoodsReceiptItem" gi ON gi."lotNumber" = b."lotNumber"
                            AND gi."materialId" = b."inventoryItemId"
                            AND gi."acceptedQty" > 0
  JOIN "GoodsReceipt" g      ON g."id" = gi."grnId" AND g."status" = 'COMPLETED'
  JOIN "ProcurementOrder" po ON po."id" = g."poId"
  WHERE b."goodsReceiptItemId" IS NULL
    AND b."billNumber" IS NOT NULL
    AND b."lotNumber" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "InventoryBatch" x WHERE x."goodsReceiptItemId" = gi."id")
),
unique_pairs AS (
  SELECT c.* FROM candidates c
  WHERE (SELECT count(*) FROM candidates c2 WHERE c2.batch_id = c.batch_id) = 1
    AND (SELECT count(*) FROM candidates c3 WHERE c3.gi_id = c.gi_id) = 1
)
UPDATE "InventoryBatch" b
SET "goodsReceiptItemId" = u.gi_id,
    "procurementOrderId" = u.po_id,
    "vendorId"           = u.vendor_id,
    "receivedAt"         = u.received_at,
    "purchaseQty"        = u.purchase_qty,
    "purchaseUnit"       = u.purchase_unit,
    "purchasePrice"      = u.purchase_price
FROM unique_pairs u
WHERE b."id" = u.batch_id;
