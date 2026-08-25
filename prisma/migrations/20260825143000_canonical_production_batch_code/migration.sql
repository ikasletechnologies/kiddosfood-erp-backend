-- A production run owns one canonical business-facing batch identity.
ALTER TABLE "Production" ADD COLUMN "productionBatchCode" TEXT;

-- The completion operation is idempotent at the database boundary: one
-- ProductBatch can exist for each production run.
CREATE UNIQUE INDEX "Production_productionBatchCode_key"
  ON "Production"("productionBatchCode");
CREATE UNIQUE INDEX "ProductBatch_productionId_key"
  ON "ProductBatch"("productionId");

-- Intentionally no historical backfill here. Legacy BATCH-* codes require an
-- audited, separately approved migration rather than a silent rewrite.
