/*
  Warnings:

  - The values [DRAFT] on the enum `SalesOrderStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [RETURN_QUARANTINE_IN] on the enum `StockMovementType` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `dealerId` on the `DeliveryChallan` table. All the data in the column will be lost.
  - You are about to drop the column `deliveredAt` on the `DeliveryChallan` table. All the data in the column will be lost.
  - You are about to drop the column `idempotencyKey` on the `DeliveryChallan` table. All the data in the column will be lost.
  - You are about to drop the column `podReference` on the `DeliveryChallan` table. All the data in the column will be lost.
  - You are about to drop the column `receivedBy` on the `DeliveryChallan` table. All the data in the column will be lost.
  - You are about to drop the column `sourceInvoiceId` on the `DeliveryChallan` table. All the data in the column will be lost.
  - You are about to drop the column `unit` on the `GoodsReceiptItem` table. All the data in the column will be lost.
  - You are about to drop the column `customerName` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `partyId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `partyType` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `sourceProformaInvoiceId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `sourceQuotationId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `paymentTerms` on the `ProcurementOrder` table. All the data in the column will be lost.
  - You are about to drop the column `unit` on the `ProcurementOrderItem` table. All the data in the column will be lost.
  - You are about to drop the column `confirmedAt` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `damagedQty` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `goodQty` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `physicalChecked` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `spoiledQty` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `stickersPrinted` on the `ProductPackaging` table. All the data in the column will be lost.
  - You are about to drop the column `returnSource` on the `PurchaseReturn` table. All the data in the column will be lost.
  - You are about to drop the column `convertedInvoiceId` on the `Quotation` table. All the data in the column will be lost.
  - You are about to drop the column `partyId` on the `Quotation` table. All the data in the column will be lost.
  - You are about to drop the column `partyType` on the `Quotation` table. All the data in the column will be lost.
  - You are about to drop the column `customerPhone` on the `SalesOrder` table. All the data in the column will be lost.
  - You are about to drop the column `idempotencyKey` on the `SalesOrder` table. All the data in the column will be lost.
  - You are about to drop the column `partyId` on the `SalesOrder` table. All the data in the column will be lost.
  - You are about to drop the column `partyType` on the `SalesOrder` table. All the data in the column will be lost.
  - You are about to drop the column `proformaInvoiceId` on the `SalesOrder` table. All the data in the column will be lost.
  - You are about to drop the column `transactionUnit` on the `StockMovement` table. All the data in the column will be lost.
  - You are about to drop the column `discountAmount` on the `VendorInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `freightCost` on the `VendorInvoice` table. All the data in the column will be lost.
  - You are about to drop the column `code` on the `Warehouse` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Warehouse` table. All the data in the column will be lost.
  - You are about to drop the column `productPackagingId` on the `WasteEntry` table. All the data in the column will be lost.
  - You are about to drop the `DeliveryChallanReturn` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeliveryChallanReturnItem` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProformaInvoice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProformaInvoiceItem` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[sku]` on the table `InventoryItem` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "SalesOrderStatus_new" AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED');
ALTER TABLE "public"."SalesOrder" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "SalesOrder" ALTER COLUMN "status" TYPE "SalesOrderStatus_new" USING ("status"::text::"SalesOrderStatus_new");
ALTER TYPE "SalesOrderStatus" RENAME TO "SalesOrderStatus_old";
ALTER TYPE "SalesOrderStatus_new" RENAME TO "SalesOrderStatus";
DROP TYPE "public"."SalesOrderStatus_old";
ALTER TABLE "SalesOrder" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "StockMovementType_new" AS ENUM ('PURCHASE_IN', 'PRODUCTION_OUT', 'PRODUCTION_IN', 'SALES_OUT', 'WASTE_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'RETURN_OUT', 'RECALL_RETURN_IN');
ALTER TABLE "StockMovement" ALTER COLUMN "movementType" TYPE "StockMovementType_new" USING ("movementType"::text::"StockMovementType_new");
ALTER TYPE "StockMovementType" RENAME TO "StockMovementType_old";
ALTER TYPE "StockMovementType_new" RENAME TO "StockMovementType";
DROP TYPE "public"."StockMovementType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "DeliveryChallan" DROP CONSTRAINT "DeliveryChallan_dealerId_fkey";

-- DropForeignKey
ALTER TABLE "DeliveryChallanReturn" DROP CONSTRAINT "DeliveryChallanReturn_challanId_fkey";

-- DropForeignKey
ALTER TABLE "DeliveryChallanReturnItem" DROP CONSTRAINT "DeliveryChallanReturnItem_challanItemId_fkey";

-- DropForeignKey
ALTER TABLE "DeliveryChallanReturnItem" DROP CONSTRAINT "DeliveryChallanReturnItem_returnId_fkey";

-- DropForeignKey
ALTER TABLE "ProformaInvoice" DROP CONSTRAINT "ProformaInvoice_customerId_fkey";

-- DropForeignKey
ALTER TABLE "ProformaInvoiceItem" DROP CONSTRAINT "ProformaInvoiceItem_proformaInvoiceId_fkey";

-- DropForeignKey
ALTER TABLE "WasteEntry" DROP CONSTRAINT "WasteEntry_productPackagingId_fkey";

-- DropIndex
DROP INDEX "Customer_franchiseId_idx";

-- DropIndex
DROP INDEX "Dealer_franchiseId_idx";

-- DropIndex
DROP INDEX "DeliveryChallan_idempotencyKey_key";

-- DropIndex
DROP INDEX "Expense_date_idx";

-- DropIndex
DROP INDEX "Expense_franchiseId_date_idx";

-- DropIndex
DROP INDEX "FranchiseOrder_createdAt_idx";

-- DropIndex
DROP INDEX "FranchiseOrder_franchiseId_createdAt_idx";

-- DropIndex
DROP INDEX "FranchiseOrder_franchiseId_status_idx";

-- DropIndex
DROP INDEX "FranchiseOrder_status_idx";

-- DropIndex
DROP INDEX "InventoryItem_sku_franchiseId_key";

-- DropIndex
DROP INDEX "Order_createdAt_idx";

-- DropIndex
DROP INDEX "Order_customerId_paymentStatus_idx";

-- DropIndex
DROP INDEX "Order_franchiseId_createdAt_idx";

-- DropIndex
DROP INDEX "Order_franchiseId_paymentStatus_idx";

-- DropIndex
DROP INDEX "Order_franchiseId_status_idx";

-- DropIndex
DROP INDEX "Payment_orderId_idx";

-- DropIndex
DROP INDEX "Payment_status_createdAt_idx";

-- DropIndex
DROP INDEX "ProcurementOrder_createdAt_idx";

-- DropIndex
DROP INDEX "ProcurementOrder_franchiseId_createdAt_idx";

-- DropIndex
DROP INDEX "ProductBatch_franchiseId_expiryDate_idx";

-- DropIndex
DROP INDEX "Production_franchiseId_status_producedAt_idx";

-- DropIndex
DROP INDEX "ReturnOrder_createdAt_idx";

-- DropIndex
DROP INDEX "ReturnOrder_franchiseId_createdAt_idx";

-- DropIndex
DROP INDEX "SalesOrder_idempotencyKey_key";

-- DropIndex
DROP INDEX "SalesOrder_proformaInvoiceId_key";

-- DropIndex
DROP INDEX "SalesOrder_quotationId_key";

-- DropIndex
DROP INDEX "StockMovement_movementType_createdAt_idx";

-- DropIndex
DROP INDEX "VendorLedger_vendorId_idx";

-- AlterTable
ALTER TABLE "DeliveryChallan" DROP COLUMN "dealerId",
DROP COLUMN "deliveredAt",
DROP COLUMN "idempotencyKey",
DROP COLUMN "podReference",
DROP COLUMN "receivedBy",
DROP COLUMN "sourceInvoiceId";

-- AlterTable
ALTER TABLE "GoodsReceiptItem" DROP COLUMN "unit";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "customerName",
DROP COLUMN "partyId",
DROP COLUMN "partyType",
DROP COLUMN "sourceProformaInvoiceId",
DROP COLUMN "sourceQuotationId";

-- AlterTable
ALTER TABLE "ProcurementOrder" DROP COLUMN "paymentTerms";

-- AlterTable
ALTER TABLE "ProcurementOrderItem" DROP COLUMN "unit";

-- AlterTable
ALTER TABLE "ProductPackaging" DROP COLUMN "confirmedAt",
DROP COLUMN "damagedQty",
DROP COLUMN "goodQty",
DROP COLUMN "physicalChecked",
DROP COLUMN "spoiledQty",
DROP COLUMN "status",
DROP COLUMN "stickersPrinted";

-- AlterTable
ALTER TABLE "PurchaseReturn" DROP COLUMN "returnSource";

-- AlterTable
ALTER TABLE "Quotation" DROP COLUMN "convertedInvoiceId",
DROP COLUMN "partyId",
DROP COLUMN "partyType";

-- AlterTable
ALTER TABLE "SalesOrder" DROP COLUMN "customerPhone",
DROP COLUMN "idempotencyKey",
DROP COLUMN "partyId",
DROP COLUMN "partyType",
DROP COLUMN "proformaInvoiceId",
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "StockMovement" DROP COLUMN "transactionUnit";

-- AlterTable
ALTER TABLE "VendorInvoice" DROP COLUMN "discountAmount",
DROP COLUMN "freightCost";

-- AlterTable
ALTER TABLE "Warehouse" DROP COLUMN "code",
DROP COLUMN "status";

-- AlterTable
ALTER TABLE "WasteEntry" DROP COLUMN "productPackagingId";

-- DropTable
DROP TABLE "DeliveryChallanReturn";

-- DropTable
DROP TABLE "DeliveryChallanReturnItem";

-- DropTable
DROP TABLE "ProformaInvoice";

-- DropTable
DROP TABLE "ProformaInvoiceItem";

-- DropEnum
DROP TYPE "PackagingRunStatus";

-- DropEnum
DROP TYPE "PartyType";

-- DropEnum
DROP TYPE "ProformaInvoiceStatus";

-- CreateIndex
CREATE UNIQUE INDEX "InventoryItem_sku_key" ON "InventoryItem"("sku");
