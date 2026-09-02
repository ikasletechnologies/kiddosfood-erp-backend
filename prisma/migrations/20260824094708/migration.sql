/*
  Warnings:

  - A unique constraint covering the columns `[sku,franchiseId]` on the table `InventoryItem` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "InventoryItem_sku_key";

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_sku_franchiseId_key" ON "InventoryItem"("sku", "franchiseId");
