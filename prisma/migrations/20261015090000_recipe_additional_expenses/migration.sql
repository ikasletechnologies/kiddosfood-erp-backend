-- Additional Expenses move to Recipe Master.
-- Additive only: nullable/defaulted columns. Existing runs keep a NULL
-- expenseSnapshot and existing expense rows default to the PACKAGING stage,
-- so their costing is unchanged.

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN "expenseConfig" JSONB;
ALTER TABLE "Recipe" ADD COLUMN "expenseConfigVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Production" ADD COLUMN "expenseSnapshot" JSONB;

-- AlterTable
ALTER TABLE "ProductionExpense" ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'PACKAGING';
