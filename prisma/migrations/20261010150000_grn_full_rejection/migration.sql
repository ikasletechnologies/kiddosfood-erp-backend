-- AlterEnum
ALTER TYPE "GRNStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT,
ADD COLUMN     "rejectionReason" TEXT;

