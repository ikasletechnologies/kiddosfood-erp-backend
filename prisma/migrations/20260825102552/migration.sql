/*
  Warnings:

  - A unique constraint covering the columns `[proformaInvoiceId]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ProformaInvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'CONVERTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'DRAFT';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "sourceProformaInvoiceId" TEXT,
ADD COLUMN     "sourceQuotationId" TEXT;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "convertedInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "proformaInvoiceId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "ProformaInvoice" (
    "id" TEXT NOT NULL,
    "proformaNumber" TEXT NOT NULL,
    "sourceSalesOrderId" TEXT,
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

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_proformaNumber_key" ON "ProformaInvoice"("proformaNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_sourceSalesOrderId_key" ON "ProformaInvoice"("sourceSalesOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ProformaInvoice_convertedInvoiceId_key" ON "ProformaInvoice"("convertedInvoiceId");

-- CreateIndex
CREATE INDEX "Customer_franchiseId_idx" ON "Customer"("franchiseId");

-- CreateIndex
CREATE INDEX "Dealer_franchiseId_idx" ON "Dealer"("franchiseId");

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
CREATE UNIQUE INDEX "SalesOrder_proformaInvoiceId_key" ON "SalesOrder"("proformaInvoiceId");

-- CreateIndex
CREATE INDEX "StockMovement_movementType_createdAt_idx" ON "StockMovement"("movementType", "createdAt");

-- CreateIndex
CREATE INDEX "VendorLedger_vendorId_idx" ON "VendorLedger"("vendorId");

-- AddForeignKey
ALTER TABLE "ProformaInvoice" ADD CONSTRAINT "ProformaInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProformaInvoiceItem" ADD CONSTRAINT "ProformaInvoiceItem_proformaInvoiceId_fkey" FOREIGN KEY ("proformaInvoiceId") REFERENCES "ProformaInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
