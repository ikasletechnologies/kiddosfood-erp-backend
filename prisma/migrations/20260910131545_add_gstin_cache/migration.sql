-- CreateTable
CREATE TABLE "GstinCache" (
    "id" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "legalName" TEXT,
    "tradeName" TEXT,
    "status" TEXT,
    "address" TEXT,
    "state" TEXT,
    "district" TEXT,
    "city" TEXT,
    "pinCode" TEXT,
    "taxpayerType" TEXT,
    "raw" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GstinCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GstinCache_gstin_key" ON "GstinCache"("gstin");
