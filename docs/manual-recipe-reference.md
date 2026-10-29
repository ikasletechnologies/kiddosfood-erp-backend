# Manual recipe reference formulations

The existing Recipe Master create/edit modal now saves the reference output quantity/unit and each material's reference quantity/unit alongside metadata and Additional Expenses. Material dropdowns show names only. Empty, non-finite, non-positive, duplicate and dimensionally incompatible ingredient inputs are rejected on both sides.

`POST /api/recipes` retains the existing `ingredientIds` payload and accepts `formulation: { yieldQty, yieldUnit, items: [{ inventoryItemId, quantity, unit }] }`. The existing Super Admin authorization remains. Older selection-only clients remain compatible; the updated manual form requires a complete reference.

The recipe, selected materials, formulation version, legacy BOM mirror and expense configuration are written in a single transaction. Saving a changed formulation creates a new `RECIPE_FORM` version; saving unchanged quantities with metadata changes keeps the current version. Prior versions, imported As Required metadata and production snapshots are retained. The existing restriction against changing the output unit after a recipe has been produced remains in place for downstream unit safety.

Production Planning already loads `activeFormulation`, calculates decimal scale factors, converts compatible units, checks availability in stock units and creates frozen formulation snapshots at start. It now receives the manual formulation directly; no new planning, costing, stock allocation or packaging implementation was introduced. Existing requirement rounding remains consistent with consumption: weight requirements below 1 KG round up to whole grams, larger weights and volumes/counts retain the existing precision. Reference measurements are saved unchanged; actual batch output remains separate.

No database columns, migrations, backfills or resets are needed. Existing RecipeFormulation, RecipeFormulationItem, RecipeItem, RecipeIngredient and expense configuration models are reused.

Verification:

- Backend build: `npm run build`.
- Rollback-only database test: set `KIDDOS_RECIPE_ROLLBACK_TEST=1`, then run `node --test dist/tests/production/manual-recipe-reference.test.js`. It creates isolated fixture rows inside a transaction, verifies saving, reloading, scaling, versioning and historical costs, then rolls everything back. No inventory movement is performed.
- Frontend tests: `npm test -- src/lib/__tests__/manual-recipe.test.ts src/components/modules/production/__tests__/RecipeMasterReference.test.tsx src/components/modules/production/__tests__/ReferenceFormulationPanel.test.tsx src/components/modules/production/__tests__/RecipeFormulationView.test.tsx src/lib/__tests__/recipe-expenses.test.ts --exclude tmp/**`.
- Frontend production build must use an isolated directory when the dev server is running, because both otherwise write `.next` artifacts.

Verified results: backend production build passed; isolated frontend production build passed with all 136 pages generated (only pre-existing image optimization warnings). All 50 focused frontend tests passed across reference-form validation, create/edit modal saves, existing formulation panels and expenses. The opt-in rollback-only PostgreSQL test passed, verifying persisted reference data, 10 KG scaling to 6 KG rice + 2 KG dal, L/ML and PCS conversion, version history, As Required metadata, historical batch costs and unchanged material stock. All integration fixtures were rolled back.
