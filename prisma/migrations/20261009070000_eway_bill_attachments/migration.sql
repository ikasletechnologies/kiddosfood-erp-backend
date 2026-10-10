-- AlterEnum
BEGIN;
CREATE TYPE "PurchaseType_new" AS ENUM ('ALL', 'RAW_MATERIAL', 'PACKAGING', 'EQUIPMENT', 'CONSUMABLES', 'SERVICES', 'OTHERS');
ALTER TABLE "public"."ProcurementOrder" ALTER COLUMN "purchaseType" DROP DEFAULT;
-- Preserve existing vendor categories; values outside the enum become NULL
ALTER TABLE "Vendor" ALTER COLUMN "category" TYPE "PurchaseType_new" USING (
  CASE WHEN "category"::text IN ('ALL', 'RAW_MATERIAL', 'PACKAGING', 'EQUIPMENT', 'CONSUMABLES', 'SERVICES', 'OTHERS')
       THEN "category"::text::"PurchaseType_new" ELSE NULL END
);
ALTER TABLE "ProcurementOrder" ALTER COLUMN "purchaseType" TYPE "PurchaseType_new" USING ("purchaseType"::text::"PurchaseType_new");
ALTER TYPE "PurchaseType" RENAME TO "PurchaseType_old";
ALTER TYPE "PurchaseType_new" RENAME TO "PurchaseType";
DROP TYPE "public"."PurchaseType_old";
ALTER TABLE "ProcurementOrder" ALTER COLUMN "purchaseType" SET DEFAULT 'RAW_MATERIAL';
COMMIT;

-- CreateTable
CREATE TABLE "EWayBill" (
    "id" TEXT NOT NULL,
    "refNumber" TEXT NOT NULL,
    "ewbNumber" TEXT,
    "ewbDate" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "franchiseId" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "supplyType" TEXT NOT NULL DEFAULT 'O',
    "subSupplyType" TEXT NOT NULL DEFAULT '1',
    "subSupplyDesc" TEXT,
    "docType" TEXT NOT NULL DEFAULT 'INV',
    "docNo" TEXT NOT NULL,
    "docDate" TIMESTAMP(3) NOT NULL,
    "transactionType" INTEGER NOT NULL DEFAULT 1,
    "fromGstin" TEXT NOT NULL,
    "fromTradeName" TEXT NOT NULL,
    "fromAddr1" TEXT,
    "fromAddr2" TEXT,
    "fromPlace" TEXT,
    "fromPincode" TEXT NOT NULL,
    "fromStateCode" INTEGER NOT NULL,
    "actFromStateCode" INTEGER NOT NULL,
    "toGstin" TEXT NOT NULL,
    "toTradeName" TEXT NOT NULL,
    "toAddr1" TEXT,
    "toAddr2" TEXT,
    "toPlace" TEXT,
    "toPincode" TEXT NOT NULL,
    "toStateCode" INTEGER NOT NULL,
    "actToStateCode" INTEGER NOT NULL,
    "totalValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cgstValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sgstValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "igstValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cessValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totInvValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transMode" TEXT,
    "transDistance" INTEGER NOT NULL DEFAULT 0,
    "transporterId" TEXT,
    "transporterName" TEXT,
    "transDocNo" TEXT,
    "transDocDate" TIMESTAMP(3),
    "vehicleNo" TEXT,
    "vehicleType" TEXT NOT NULL DEFAULT 'R',
    "cancelReason" TEXT,
    "cancelRemarks" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "extensionCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EWayBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EWayBillItem" (
    "id" TEXT NOT NULL,
    "ewayBillId" TEXT NOT NULL,
    "itemNo" INTEGER NOT NULL,
    "productName" TEXT NOT NULL,
    "productDesc" TEXT,
    "hsnCode" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "qtyUnit" TEXT NOT NULL DEFAULT 'NOS',
    "taxableAmount" DOUBLE PRECISION NOT NULL,
    "cgstRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sgstRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "igstRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cessRate" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "EWayBillItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EWayBillVehicleUpdate" (
    "id" TEXT NOT NULL,
    "ewayBillId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'VEHICLE',
    "vehicleNo" TEXT,
    "transMode" TEXT,
    "transDocNo" TEXT,
    "transDocDate" TIMESTAMP(3),
    "fromPlace" TEXT,
    "fromStateCode" INTEGER,
    "reasonCode" TEXT NOT NULL,
    "reasonRemarks" TEXT,
    "remainingKm" INTEGER,
    "validUntil" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EWayBillVehicleUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'DOCUMENT',
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "franchiseId" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EWayBill_refNumber_key" ON "EWayBill"("refNumber");

-- CreateIndex
CREATE UNIQUE INDEX "EWayBill_ewbNumber_key" ON "EWayBill"("ewbNumber");

-- CreateIndex
CREATE INDEX "EWayBill_franchiseId_status_idx" ON "EWayBill"("franchiseId", "status");

-- CreateIndex
CREATE INDEX "EWayBill_sourceType_sourceId_idx" ON "EWayBill"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "EWayBill_docNo_idx" ON "EWayBill"("docNo");

-- CreateIndex
CREATE INDEX "EWayBillItem_ewayBillId_idx" ON "EWayBillItem"("ewayBillId");

-- CreateIndex
CREATE INDEX "EWayBillVehicleUpdate_ewayBillId_idx" ON "EWayBillVehicleUpdate"("ewayBillId");

-- CreateIndex
CREATE INDEX "Attachment_entityType_entityId_idx" ON "Attachment"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "EWayBillItem" ADD CONSTRAINT "EWayBillItem_ewayBillId_fkey" FOREIGN KEY ("ewayBillId") REFERENCES "EWayBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EWayBillVehicleUpdate" ADD CONSTRAINT "EWayBillVehicleUpdate_ewayBillId_fkey" FOREIGN KEY ("ewayBillId") REFERENCES "EWayBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

