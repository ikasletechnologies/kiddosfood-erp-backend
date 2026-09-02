-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN IF NOT EXISTS "stateOfSupply" TEXT;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN IF NOT EXISTS "stateOfSupply" TEXT;

-- AlterTable
ALTER TABLE "ProformaInvoice" ADD COLUMN IF NOT EXISTS "stateOfSupply" TEXT;
