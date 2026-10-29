BEGIN;
CREATE TABLE "FranchiseDocument" (
  "id" TEXT NOT NULL,
  "franchiseId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "originalFileName" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL CHECK ("fileSize" > 0),
  "familyId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','HISTORICAL','ARCHIVED')),
  "visibility" TEXT NOT NULL DEFAULT 'INTERNAL' CHECK ("visibility" IN ('INTERNAL','SHARED')),
  "uploadedBy" TEXT NOT NULL,
  "uploadedByName" TEXT NOT NULL,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "issueDate" TIMESTAMP(3),
  "expiryDate" TIMESTAMP(3),
  "notes" TEXT,
  CONSTRAINT "FranchiseDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FranchiseDocument_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "Franchise"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FranchiseDocument_storageKey_fkey" FOREIGN KEY ("storageKey") REFERENCES "Attachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FranchiseDocument_category_check" CHECK ("category" IN ('CATALOGUE','BROCHURE','RENTAL_AGREEMENT','FSSAI_CERTIFICATE','LEGAL_AGREEMENTS','OTHER_DOCUMENTS','APPLICATION_FORM','FRANCHISE_PRICE_LIST','CUSTOMER_PRICE_LIST'))
);
CREATE UNIQUE INDEX "FranchiseDocument_storageKey_key" ON "FranchiseDocument"("storageKey");
CREATE UNIQUE INDEX "FranchiseDocument_familyId_version_key" ON "FranchiseDocument"("familyId","version");
CREATE INDEX "FranchiseDocument_franchiseId_status_category_idx" ON "FranchiseDocument"("franchiseId","status","category");
-- One active file per single-file category. Multidocument categories retain separate families.
CREATE UNIQUE INDEX "FranchiseDocument_single_active_category_key" ON "FranchiseDocument"("franchiseId","category")
WHERE "status" = 'ACTIVE' AND "category" NOT IN ('LEGAL_AGREEMENTS','OTHER_DOCUMENTS');
COMMIT;

