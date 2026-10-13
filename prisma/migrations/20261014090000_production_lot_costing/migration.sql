-- Purchase lot-wise production costing & packaging unit cost.
-- Additive only: two nullable/defaulted columns and one new table.

-- AlterTable
ALTER TABLE "ProductionItem" ADD COLUMN "isAdditional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductionItem" ADD COLUMN "note" TEXT;

-- AlterTable
ALTER TABLE "ProductPackaging" ADD COLUMN "costBreakdown" JSONB;

-- CreateTable
CREATE TABLE "ProductionExpense" (
    "id" TEXT NOT NULL,
    "productBatchId" TEXT NOT NULL,
    "productPackagingId" TEXT,
    "category" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "baseQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionExpense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionExpense_productBatchId_idx" ON "ProductionExpense"("productBatchId");
CREATE INDEX "ProductionExpense_productPackagingId_idx" ON "ProductionExpense"("productPackagingId");

-- AddForeignKey
ALTER TABLE "ProductionExpense" ADD CONSTRAINT "ProductionExpense_productBatchId_fkey" FOREIGN KEY ("productBatchId") REFERENCES "ProductBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductionExpense" ADD CONSTRAINT "ProductionExpense_productPackagingId_fkey" FOREIGN KEY ("productPackagingId") REFERENCES "ProductPackaging"("id") ON DELETE CASCADE ON UPDATE CASCADE;
