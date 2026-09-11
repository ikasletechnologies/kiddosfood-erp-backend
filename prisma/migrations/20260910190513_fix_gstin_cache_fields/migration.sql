-- Correct GstinCache columns to match GSTVerify's actual response schema
-- (previous columns were guessed from a different provider's field names).
-- Existing rows were cached under the wrong mapping, so clear them.
DELETE FROM "GstinCache";

-- AlterTable
ALTER TABLE "GstinCache" DROP COLUMN "district",
DROP COLUMN "city",
DROP COLUMN "pinCode",
ADD COLUMN "constitution" TEXT,
ADD COLUMN "registrationDate" TEXT,
ADD COLUMN "pan" TEXT,
ADD COLUMN "natureOfBusiness" JSONB;
