/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `DeliveryChallan` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[sku,franchiseId]` on the table `InventoryItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[quotationId]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[proformaInvoiceId]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[idempotencyKey]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PackagingRunStatus" AS ENUM ('AWAITING_CONFIRMATION', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('CUSTOMER', 'DEALER', 'FRANCHISE');

-- CreateEnum
CREATE TYPE "ProformaInvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'CONVERTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'DRAFT';

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'RETURN_QUARANTINE_IN';

-- DropIndex
DROP INDEX "InventoryItem_sku_key";

-- AlterTable
ALTER TABLE "DeliveryChallan" ADD COLUMN     "dealerId" TEXT,
ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "podReference" TEXT,
ADD COLUMN     "receivedBy" TEXT,
ADD COLUMN     "sourceInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "GoodsReceiptItem" ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'UNIT';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType",
ADD COLUMN     "sourceProformaInvoiceId" TEXT,
ADD COLUMN     "sourceQuotationId" TEXT;

-- AlterTable
ALTER TABLE "ProcurementOrder" ADD COLUMN     "paymentTerms" TEXT;

-- AlterTable
ALTER TABLE "ProcurementOrderItem" ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'UNIT';

-- AlterTable
ALTER TABLE "ProductPackaging" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "damagedQty" INTEGER,
ADD COLUMN     "goodQty" INTEGER,
ADD COLUMN     "physicalChecked" BOOLEAN,
ADD COLUMN     "spoiledQty" INTEGER,
ADD COLUMN     "status" "PackagingRunStatus" NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "stickersPrinted" INTEGER;

-- AlterTable
ALTER TABLE "PurchaseReturn" ADD COLUMN     "returnSource" TEXT NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "convertedInvoiceId" TEXT,
ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType" NOT NULL DEFAULT 'CUSTOMER',
ADD COLUMN     "proformaInvoiceId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "transactionUnit" TEXT;

-- AlterTable
ALTER TABLE "VendorInvoice" ADD COLUMN     "discountAmount" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "freightCost" DOUBLE PRECISION DEFAULT 0;

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "code" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "WasteEntry" ADD COLUMN     "productPackagingId" TEXT;

-- CreateTable
CREATE TABLE "ProformaInvoice" (
    "id" TEXT NOT NULL,
    "proformaNumber" TEXT NOT NULL,
    "sourceSalesOrderId" TEXT,
    "partyType" "PartyType",
    "partyId" TEXT,
    "customerId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "status" "ProformaInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subTotal" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "paymentTerms" TEXT,
    "notes" TEXT,
    "createdBy" TEXT,
    "convertedInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProformaInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProformaInvoiceItem" (
    "id" TEXT NOT NULL,
    "proformaInvoiceId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "rate" DOUBLE PRECISION NOT NULL,
    "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "taxAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ProformaInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryChallanReturn" (
    "id" TEXT NOT NULL,
    "returnNumber" TEXT NOT NULL,
    "challanId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "otherReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryChallanReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryChallanReturnItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "challanItemId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'NONE',
    "condition" TEXT,

    CONSTRAINT "DeliveryChallanReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_proformaNumber_key" ON "ProformaInvoice"("proformaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_sourceSalesOrderId_key" ON "ProformaInvoice"("sourceSalesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_convertedInvoiceId_key" ON "ProformaInvoice"("convertedInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryChallanReturn_returnNumber_key" ON "DeliveryChallanReturn"("returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryChallanReturn_idempotencyKey_key" ON "DeliveryChallanReturn"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Customer_franchiseId_idx" ON "Customer"("franchiseId");

-- CreateIndex
CREATE INDEX "Dealer_franchiseId_idx" ON "Dealer"("franchiseId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryChallan_idempotencyKey_key" ON "DeliveryChallan"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Expense_franchiseId_date_idx" ON "Expense"("franchiseId", "date");

-- CreateIndex
CREATE INDEX "Expense_date_idx" ON "Expense"("date");

-- CreateIndex
CREATE INDEX "FranchiseOrder_franchiseId_createdAt_idx" ON "FranchiseOrder"("franchiseId", "createdAt");

-- CreateIndex
CREATE INDEX "FranchiseOrder_createdAt_idx" ON "FranchiseOrder"("createdAt");

-- CreateIndex
CREATE INDEX "FranchiseOrder_franchiseId_status_idx" ON "FranchiseOrder"("franchiseId", "status");

-- CreateIndex
CREATE INDEX "FranchiseOrder_status_idx" ON "FranchiseOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_sku_franchiseId_key" ON "InventoryItem"("sku", "franchiseId");

-- CreateIndex
CREATE INDEX "Order_franchiseId_createdAt_idx" ON "Order"("franchiseId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- CreateIndex
CREATE INDEX "Order_franchiseId_status_idx" ON "Order"("franchiseId", "status");

-- CreateIndex
CREATE INDEX "Order_customerId_paymentStatus_idx" ON "Order"("customerId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Order_franchiseId_paymentStatus_idx" ON "Order"("franchiseId", "paymentStatus");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ProcurementOrder_franchiseId_createdAt_idx" ON "ProcurementOrder"("franchiseId", "createdAt");

-- CreateIndex
CREATE INDEX "ProcurementOrder_createdAt_idx" ON "ProcurementOrder"("createdAt");

-- CreateIndex
CREATE INDEX "ProductBatch_franchiseId_expiryDate_idx" ON "ProductBatch"("franchiseId", "expiryDate");

-- CreateIndex
CREATE INDEX "Production_franchiseId_status_producedAt_idx" ON "Production"("franchiseId", "status", "producedAt");

-- CreateIndex
CREATE INDEX "ReturnOrder_franchiseId_createdAt_idx" ON "ReturnOrder"("franchiseId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnOrder_createdAt_idx" ON "ReturnOrder"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_quotationId_key" ON "SalesOrder"("quotationId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_proformaInvoiceId_key" ON "SalesOrder"("proformaInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_idempotencyKey_key" ON "SalesOrder"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StockMovement_movementType_createdAt_idx" ON "StockMovement"("movementType", "createdAt");

-- CreateIndex
CREATE INDEX "VendorLedger_vendorId_idx" ON "VendorLedger"("vendorId");

-- AddForeignKey
ALTER TABLE "WasteEntry" ADD CONSTRAINT "WasteEntry_productPackagingId_fkey" FOREIGN KEY ("productPackagingId") REFERENCES "ProductPackaging"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoice" ADD CONSTRAINT "ProformaInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoiceItem" ADD CONSTRAINT "ProformaInvoiceItem_proformaInvoiceId_fkey" FOREIGN KEY ("proformaInvoiceId") REFERENCES "ProformaInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallan" ADD CONSTRAINT "DeliveryChallan_dealerId_fkey" FOREIGN KEY ("dealerId") REFERENCES "Dealer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturn" ADD CONSTRAINT "DeliveryChallanReturn_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "DeliveryChallan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturnItem" ADD CONSTRAINT "DeliveryChallanReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "DeliveryChallanReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturnItem" ADD CONSTRAINT "DeliveryChallanReturnItem_challanItemId_fkey" FOREIGN KEY ("challanItemId") REFERENCES "DeliveryChallanItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
