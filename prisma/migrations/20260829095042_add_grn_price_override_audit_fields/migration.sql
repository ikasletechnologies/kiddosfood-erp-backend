-- AlterTable
ALTER TABLE "GoodsReceiptItem" ADD COLUMN     "poPrice" DOUBLE PRECISION,
ADD COLUMN     "priceOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceOverrideReason" TEXT,
ADD COLUMN     "priceOverrideBy" TEXT,
ADD COLUMN     "priceOverrideAt" TIMESTAMP(3);
