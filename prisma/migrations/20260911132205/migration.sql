-- AlterTable
ALTER TABLE "DeliveryChallanReturnItem" ADD COLUMN     "recallId" TEXT;

-- AlterTable
ALTER TABLE "InventoryBatch" ADD COLUMN     "billNumber" TEXT;

-- AlterTable
ALTER TABLE "ProductPackaging" ADD COLUMN     "bulkBreakdown" JSONB;

-- AlterTable
ALTER TABLE "ReturnItem" ADD COLUMN     "recallId" TEXT;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "consumptionBreakdown" JSONB;

-- CreateIndex
CREATE INDEX "DeliveryChallanReturnItem_recallId_idx" ON "DeliveryChallanReturnItem"("recallId");

-- CreateIndex
CREATE INDEX "InventoryBatch_productBatchId_idx" ON "InventoryBatch"("productBatchId");

-- CreateIndex
CREATE INDEX "InventoryBatch_inventoryItemId_status_idx" ON "InventoryBatch"("inventoryItemId", "status");

-- CreateIndex
CREATE INDEX "ReturnItem_recallId_idx" ON "ReturnItem"("recallId");

-- CreateIndex
CREATE INDEX "StockMovement_batchId_referenceType_idx" ON "StockMovement"("batchId", "referenceType");

-- AddForeignKey
ALTER TABLE "ReturnItem" ADD CONSTRAINT "ReturnItem_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "BatchRecall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturnItem" ADD CONSTRAINT "DeliveryChallanReturnItem_recallId_fkey" FOREIGN KEY ("recallId") REFERENCES "BatchRecall"("id") ON DELETE SET NULL ON UPDATE CASCADE;
