/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `DeliveryChallan` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[quotationId]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[idempotencyKey]` on the table `SalesOrder` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'RETURN_QUARANTINE_IN';

-- AlterTable
ALTER TABLE "DeliveryChallan" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "podReference" TEXT,
ADD COLUMN     "receivedBy" TEXT,
ADD COLUMN     "sourceInvoiceId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType";

-- AlterTable
ALTER TABLE "ProformaInvoice" ADD COLUMN     "partyId" TEXT,
ADD COLUMN     "partyType" "PartyType";

-- AlterTable
ALTER TABLE "PurchaseReturn" ADD COLUMN     "returnSource" TEXT NOT NULL DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "idempotencyKey" TEXT;

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
CREATE UNIQUE INDEX "DeliveryChallanReturn_returnNumber_key" ON "DeliveryChallanReturn"("returnNumber");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryChallanReturn_idempotencyKey_key" ON "DeliveryChallanReturn"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryChallan_idempotencyKey_key" ON "DeliveryChallan"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_quotationId_key" ON "SalesOrder"("quotationId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_idempotencyKey_key" ON "SalesOrder"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturn" ADD CONSTRAINT "DeliveryChallanReturn_challanId_fkey" FOREIGN KEY ("challanId") REFERENCES "DeliveryChallan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturnItem" ADD CONSTRAINT "DeliveryChallanReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "DeliveryChallanReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryChallanReturnItem" ADD CONSTRAINT "DeliveryChallanReturnItem_challanItemId_fkey" FOREIGN KEY ("challanItemId") REFERENCES "DeliveryChallanItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
