-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "code" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';
