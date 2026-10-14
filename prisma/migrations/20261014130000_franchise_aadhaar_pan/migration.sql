-- Optional Aadhaar / PAN on Franchise (Super Admin → Add Franchise form).
-- Additive only: three nullable columns (idempotent). Existing rows are untouched.
-- Aadhaar is never stored in clear text: "aadhaarEncrypted" holds an
-- AES-256-GCM ciphertext and "aadhaarLast4" only the masked-display digits.

-- AlterTable
ALTER TABLE "Franchise" ADD COLUMN IF NOT EXISTS "aadhaarEncrypted" TEXT;
ALTER TABLE "Franchise" ADD COLUMN IF NOT EXISTS "aadhaarLast4" TEXT;
ALTER TABLE "Franchise" ADD COLUMN IF NOT EXISTS "panNumber" TEXT;
