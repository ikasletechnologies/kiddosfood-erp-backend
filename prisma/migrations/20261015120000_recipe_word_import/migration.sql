-- Word recipe import & reference formulation links.
-- Additive only: nullable columns on RecipeFormulation / RecipeFormulationItem
-- and two new tables. No existing row is changed.

-- AlterTable
ALTER TABLE "RecipeFormulation" ADD COLUMN     "outputStage" TEXT,
ADD COLUMN     "outputStages" JSONB,
ADD COLUMN     "sourceReference" JSONB,
ADD COLUMN     "unresolvedItems" JSONB;

-- AlterTable
ALTER TABLE "RecipeFormulationItem" ADD COLUMN     "sourceName" TEXT,
ADD COLUMN     "sourceText" TEXT;

-- CreateTable
CREATE TABLE "RecipeProduct" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeImportSession" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "status" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeImportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecipeProduct_productId_key" ON "RecipeProduct"("productId");

-- CreateIndex
CREATE INDEX "RecipeProduct_recipeId_idx" ON "RecipeProduct"("recipeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeImportSession_fileHash_key" ON "RecipeImportSession"("fileHash");

-- AddForeignKey
ALTER TABLE "RecipeProduct" ADD CONSTRAINT "RecipeProduct_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeProduct" ADD CONSTRAINT "RecipeProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

