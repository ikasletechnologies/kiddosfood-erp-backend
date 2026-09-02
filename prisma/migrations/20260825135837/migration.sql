-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('CUSTOMER', 'DEALER', 'FRANCHISE');

-- AlterTable
ALTER TABLE "ProcurementOrder" ADD COLUMN     "paymentTerms" TEXT;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType" NOT NULL DEFAULT 'CUSTOMER';
