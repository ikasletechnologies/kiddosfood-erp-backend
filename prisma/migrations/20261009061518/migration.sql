-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('INVENTORY', 'ORDER', 'PAYMENT', 'DISPATCH', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "entityId" TEXT,
    "entityType" TEXT,
    "franchiseId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Alert_dedupeKey_key" ON "Alert"("dedupeKey");

-- CreateIndex
CREATE INDEX "Alert_franchiseId_status_isRead_idx" ON "Alert"("franchiseId", "status", "isRead");

-- CreateIndex
CREATE INDEX "Alert_franchiseId_status_type_idx" ON "Alert"("franchiseId", "status", "type");

-- CreateIndex
CREATE INDEX "Alert_type_severity_idx" ON "Alert"("type", "severity");

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "Franchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;
