-- AlterTable
ALTER TABLE "Production" ADD COLUMN     "formulationId" TEXT,
ADD COLUMN     "formulationSnapshot" JSONB,
ADD COLUMN     "plannedYieldQty" DOUBLE PRECISION,
ADD COLUMN     "plannedYieldUnit" TEXT;

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeFormulation" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "yieldQty" DOUBLE PRECISION NOT NULL,
    "yieldUnit" TEXT NOT NULL,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'PLANNING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeFormulation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeFormulationItem" (
    "id" TEXT NOT NULL,
    "formulationId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeFormulationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecipeIngredient_recipeId_inventoryItemId_key" ON "RecipeIngredient"("recipeId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "RecipeFormulation_recipeId_isActive_idx" ON "RecipeFormulation"("recipeId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeFormulation_recipeId_version_key" ON "RecipeFormulation"("recipeId", "version");

-- CreateIndex
CREATE INDEX "RecipeFormulationItem_formulationId_idx" ON "RecipeFormulationItem"("formulationId");

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeFormulation" ADD CONSTRAINT "RecipeFormulation_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeFormulationItem" ADD CONSTRAINT "RecipeFormulationItem_formulationId_fkey" FOREIGN KEY ("formulationId") REFERENCES "RecipeFormulation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeFormulationItem" ADD CONSTRAINT "RecipeFormulationItem_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "InventoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Production" ADD CONSTRAINT "Production_formulationId_fkey" FOREIGN KEY ("formulationId") REFERENCES "RecipeFormulation"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill 1: Recipe Master ingredient list from each recipe's existing BOM
-- (one row per distinct material).
INSERT INTO "RecipeIngredient" ("id", "recipeId", "inventoryItemId", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text,
       r."recipeId",
       r."inventoryItemId",
       (row_number() OVER (PARTITION BY r."recipeId" ORDER BY r.first_id)) - 1,
       now()
FROM (
  SELECT "recipeId", "inventoryItemId", min("id") AS first_id
  FROM "RecipeItem"
  GROUP BY "recipeId", "inventoryItemId"
) r;

-- Backfill 2: every recipe that already has a BOM gets formulation version 1
-- holding exactly its existing yield and ingredient quantities/units, marked
-- LEGACY. Recipe.yieldQty/yieldUnit and RecipeItem rows are left untouched,
-- so every existing consumer keeps reading identical values. Recipes with
-- no BOM get no formulation (nothing is invented for them).
INSERT INTO "RecipeFormulation" ("id", "recipeId", "version", "yieldQty", "yieldUnit", "notes", "source", "isActive", "createdAt")
SELECT gen_random_uuid()::text, rc."id", 1, rc."yieldQty", rc."yieldUnit",
       'Imported from the recipe''s existing bill of materials', 'LEGACY', true, rc."updatedAt"
FROM "Recipe" rc
WHERE EXISTS (SELECT 1 FROM "RecipeItem" ri WHERE ri."recipeId" = rc."id");

INSERT INTO "RecipeFormulationItem" ("id", "formulationId", "inventoryItemId", "quantity", "unit", "sortOrder")
SELECT gen_random_uuid()::text, f."id", ri."inventoryItemId", ri."quantityRequired", ri."unit",
       (row_number() OVER (PARTITION BY f."id" ORDER BY ri."id")) - 1
FROM "RecipeItem" ri
JOIN "RecipeFormulation" f ON f."recipeId" = ri."recipeId" AND f."source" = 'LEGACY' AND f."version" = 1;
