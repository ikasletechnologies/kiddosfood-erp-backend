-- AlterTable
ALTER TABLE "GoodsReceiptItem" ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'UNIT';

-- AlterTable
ALTER TABLE "ProcurementOrderItem" ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'UNIT';
