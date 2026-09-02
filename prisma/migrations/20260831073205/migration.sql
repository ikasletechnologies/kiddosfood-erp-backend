/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `ReturnOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "DailySettlement" ADD COLUMN     "netTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "otherTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "refundTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ProformaInvoice" ADD COLUMN     "stateOfSupply" TEXT;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "stateOfSupply" TEXT;

-- AlterTable
ALTER TABLE "ReturnOrder" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "orderDate" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "stateOfSupply" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReturnOrder_idempotencyKey_key" ON "ReturnOrder"("idempotencyKey");
