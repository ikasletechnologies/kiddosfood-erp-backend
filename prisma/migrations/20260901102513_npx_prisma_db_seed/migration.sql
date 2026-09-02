/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `ReturnOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "ProductType" ADD VALUE 'SERVICE';

-- AlterTable
ALTER TABLE "DailySettlement" ADD COLUMN     "netTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "otherTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "refundTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "GoodsReceiptItem" ADD COLUMN     "poPrice" DOUBLE PRECISION,
ADD COLUMN     "priceOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceOverrideAt" TIMESTAMP(3),
ADD COLUMN     "priceOverrideBy" TEXT,
ADD COLUMN     "priceOverrideReason" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sacCode" TEXT;

-- AlterTable
ALTER TABLE "ProformaInvoiceItem" ADD COLUMN     "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PurchaseReturn" ADD COLUMN     "cgst" DOUBLE PRECISION,
ADD COLUMN     "gstRate" DOUBLE PRECISION,
ADD COLUMN     "igst" DOUBLE PRECISION,
ADD COLUMN     "sgst" DOUBLE PRECISION,
ADD COLUMN     "taxAmount" DOUBLE PRECISION,
ADD COLUMN     "taxableValue" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "QuotationItem" ADD COLUMN     "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ReturnOrder" ADD COLUMN     "cgst" DOUBLE PRECISION,
ADD COLUMN     "gstRate" DOUBLE PRECISION,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "igst" DOUBLE PRECISION,
ADD COLUMN     "sgst" DOUBLE PRECISION,
ADD COLUMN     "taxAmount" DOUBLE PRECISION,
ADD COLUMN     "taxableValue" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "orderDate" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "SalesOrderItem" ADD COLUMN     "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "discountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "ReturnOrder_idempotencyKey_key" ON "ReturnOrder"("idempotencyKey");
