-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED', 'PARTIAL');

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN     "discountType" TEXT DEFAULT 'PERCENT',
ADD COLUMN     "discountValue" DOUBLE PRECISION DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "discountType" TEXT DEFAULT 'PERCENT',
ADD COLUMN     "discountValue" DOUBLE PRECISION DEFAULT 0;

-- CreateTable
CREATE TABLE "InventoryReservation" (
    "id" TEXT NOT NULL,
    "franchiseOrderId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "InventoryReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryReservationAllocation" (
    "id" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "inventoryBatchId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "reservedQty" DOUBLE PRECISION NOT NULL,
    "consumedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "releasedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "InventoryReservationAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryReservation_franchiseOrderId_key" ON "InventoryReservation"("franchiseOrderId");

-- CreateIndex
CREATE INDEX "InventoryReservationAllocation_reservationId_idx" ON "InventoryReservationAllocation"("reservationId");

-- CreateIndex
CREATE INDEX "InventoryReservationAllocation_inventoryBatchId_idx" ON "InventoryReservationAllocation"("inventoryBatchId");

-- CreateIndex
CREATE INDEX "InventoryReservationAllocation_inventoryItemId_idx" ON "InventoryReservationAllocation"("inventoryItemId");

-- AddForeignKey
ALTER TABLE "InventoryReservation" ADD CONSTRAINT "InventoryReservation_franchiseOrderId_fkey" FOREIGN KEY ("franchiseOrderId") REFERENCES "FranchiseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservationAllocation" ADD CONSTRAINT "InventoryReservationAllocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "InventoryReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservationAllocation" ADD CONSTRAINT "InventoryReservationAllocation_inventoryBatchId_fkey" FOREIGN KEY ("inventoryBatchId") REFERENCES "InventoryBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryReservationAllocation" ADD CONSTRAINT "InventoryReservationAllocation_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
