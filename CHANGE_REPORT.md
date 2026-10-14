# Kiddos Foods ERP — Change Report

**Period:** this development session (up to 13 Oct 2026)
**Repositories:** `kiddosfood-erp-backend` (branch `uat`) and `kiddosfood-erp-frontend`
**Status:** all changes are **staged but not committed**.

| | Files changed | New files | Lines added | Lines removed |
|---|---|---|---|---|
| Backend | 22 | 12 | 3,141 | 87 |
| Frontend | 21 | 12 | 2,294 | 362 |

No module, table, column or record was deleted. Every database change adds something new. The items removed were screen elements only; they are listed in section 12.

---

## Contents

1. [ERP Assistant (floating chat button)](#1-erp-assistant-floating-chat-button)
2. [Purchase lot tracking: GRN, PO and Stock Hub](#2-purchase-lot-tracking-grn-po-and-stock-hub)
3. [Purchase Returns: lot-linked](#3-purchase-returns-lot-linked)
4. [Recipe Master: simplified](#4-recipe-master-simplified)
5. [Production Planning: reference formulation and scaling](#5-production-planning-reference-formulation-and-scaling)
6. [Production Planning: purchase lot selection and material cost](#6-production-planning-purchase-lot-selection-and-material-cost)
7. [Batch Manufacturing: Complete Production (actual yield and cost)](#7-batch-manufacturing-complete-production-actual-yield-and-cost)
8. [Batch Registry: planned vs actual](#8-batch-registry-planned-vs-actual)
9. [Packaging & Confirmation: cost, expenses, profit/loss](#9-packaging--confirmation-cost-expenses-profitloss)
10. [Database changes](#10-database-changes-all-additive)
11. [New and changed API endpoints](#11-new-and-changed-api-endpoints)
12. [Removed from screens](#12-removed-from-screens)
13. [Bug fixes made along the way](#13-bug-fixes-made-along-the-way)
14. [Tests and verification](#14-tests-and-verification)
15. [Settings you can change](#15-settings-you-can-change)
16. [Pending actions and known limitations](#16-pending-actions-and-known-limitations)
17. [Full file list](#17-full-file-list)

---

## 1. ERP Assistant (floating chat button)

**File:** `frontend/src/components/assistant/ERPAssistant.tsx` (+72 / −6)

| Type | Change |
|---|---|
| Upgraded | The button can now be **dragged** anywhere on screen, with mouse or touch. |
| Upgraded | The position is **remembered** in the browser and restored on the next visit. It is kept inside the window if the screen is resized. |
| Removed | The **"ERP Assistant" text** on the button. It is now a small message icon only. |
| Kept | Opening and closing the chat works as before. A drag does not count as a click. |

---

## 2. Purchase lot tracking: GRN, PO and Stock Hub

### What it does
Every approved GRN line now creates **one purchase lot**. Each lot is linked to:

- the material (SKU) and supplier;
- the Purchase Order and the GRN line;
- received date, quantity and unit;
- purchase price and cost per stock unit;
- warehouse, manufacturer batch number and expiry date.

### Backend

| File | Type | Change |
|---|---|---|
| `src/modules/grn/grn.service.ts` (+30 / −3) | Upgraded | GRN approval **locks the GRN row** before it creates any stock. |
| | Added | **Duplicate-posting protection:** a GRN line can create at most one lot, enforced in the code and by a unique key in the database. |
| | Upgraded | The lot stores cost **per stock unit**: 10 KG bought at ₹1,000 gives ₹100 per KG. |
| | Upgraded | The stock movement for the receipt carries the lot's ID and unit cost. |
| `src/modules/inventory/purchase-lots.service.ts` | **New** (243 lines) | Lot summaries per material: total quantity, weighted average cost, active lots, low-stock flag. |
| | | Lot list for one material. |
| | | Lots still holding stock for a supplier, for returns. |
| | | Pending return quantity claimed against each lot. |
| | | Deduction from a single lot that never spills into other lots. |
| `src/modules/inventory/raw-materials.controller.ts` (+20 / −1) | Added | The raw-material list now includes a `lotSummary` for each material. |
| | Added | New endpoint: `GET /api/raw-materials/:id/lots`. |
| `src/modules/procurement/procurement.service.ts` (+7 / −1) | Added | The list of materials that can be returned now includes their lots. |

### Frontend

| File | Type | Change |
|---|---|---|
| `src/components/modules/inventory/RawMaterialStockClient.tsx` (+48 / −10) | Upgraded | **Stock Hub:** each material row expands to show its purchase lots. |
| | Added | New Value and Lots columns, plus a low-stock alert. |
| `src/components/modules/inventory/MaterialLotsPanel.tsx` | **New** (182 lines) | The batch-wise lot table: lot number, supplier, PO, GRN, received date, quantity, price, cost, expiry, warehouse and status. |
| `src/lib/api/inventory.api.ts` | Added | `rawMaterialsApi.getLots`. |

### Existing data
The migration **back-filled** links for lots created before this change. It matched them first by bill number and then by GRN lot number, and nothing was guessed. On the local database, all 6 existing lots were linked.

---

## 3. Purchase Returns: lot-linked

| File | Type | Change |
|---|---|---|
| `backend/src/modules/purchase/purchase.service.ts` (+100 / −38) | Upgraded | A return line can name the **exact purchase lot**. It is checked against that lot's stock, minus quantities already claimed by other open returns. |
| | Upgraded | The stock leaves that lot at **that lot's own cost**. |
| | Security | Lot fields that should come from the server are **removed from what the browser sends**, so they can't be faked. |
| `frontend/src/components/modules/purchases/NewPurchaseReturnModal.tsx` (+68 / −6) | Added | **Lot picker** on each return line, showing available quantity and cost. |

---

## 4. Recipe Master: simplified

**Files:** `frontend/.../RecipeMasterTab.tsx` (+58 / −81), `backend/src/modules/recipes/recipe.service.ts` (+115 / −16), `backend/src/modules/recipes/recipe.controller.ts` (+24 / −1)

| Type | Change |
|---|---|
| Removed (screen) | Yield quantity, yield unit, and each ingredient's quantity and unit were removed from the Recipe Master form. These now live in Production Planning. |
| Upgraded | Recipe Master now holds only name, **category (required)**, instructions and the **ingredient list**. |
| Added | The ingredient picker **blocks duplicate ingredients**. |
| Added | The recipe list shows ingredient names and **"Formulation vN"** or **"Formulation needed"**. |
| Added (backend) | `saveSimplifiedRecipe`, plus syncing of the new `RecipeIngredient` list. |
| Upgraded (backend) | Deleting a recipe also removes its ingredient list and formulations. |
| Upgraded (backend) | The old recipe save path still works. It now also records a formulation version. |
| Compatibility | The old `Recipe.yieldQty` / `yieldUnit` / `RecipeItem` fields are **kept** and stay in sync, so POS, Finance, Franchise and Dashboard read exactly what they did before. |

---

## 5. Production Planning: reference formulation and scaling

**Files:**
- Backend: `src/modules/recipes/formulation.service.ts` (**new**, 289 lines) and `production.service.ts`.
- Frontend: `ReferenceFormulationPanel.tsx` (**new**, 198 lines) and `src/app/production/page.tsx`.

| Type | Change |
|---|---|
| Added | **Reference Formulation panel:** each ingredient row shows the name, quantity and stock unit (read-only), with a **Save Formulation** button. |
| Added | **Versioning:** every save creates a new formulation version (v1, v2 …). Older versions are kept. |
| Added | **Scaling:** enter a target such as 25 KG and every ingredient is scaled from the saved reference yield. Units are converted (g↔kg, ml↔L). |
| Added | **Stock check** per ingredient against the selected warehouse, with the shortage shown. |
| Added | **Frozen snapshot:** each run stores the formulation version, target, scaling factor and scaled requirements it started with. Later recipe edits can't change it. |
| Added (safety) | Production start re-checks under a lock that the formulation hasn't changed since the screen loaded. |
| Added (safety) | A recipe with no saved formulation **cannot start** (previously it could start and consume nothing). |
| Simplified | The current target is saved as the reference yield. The banner, separate reference-yield field, change-note box and explanatory text were removed. |
| Removed | The **"Start this production run?"** confirmation popup. Start now goes straight ahead, with expiry defaulting to today + 7 days. |

---

## 6. Production Planning: purchase lot selection and material cost

**Files:**
- Backend:
  - `src/modules/production/production-costing.service.ts` (**new**, 380 lines);
  - `production.service.ts` (`startProduction`);
  - `production.controller.ts`.
- Frontend:
  - `src/components/modules/production/IngredientLotPanel.tsx` (**new**, 118 lines);
  - `src/lib/lot-allocation.ts` (**new**, 93 lines);
  - `src/app/production/page.tsx`.

| Type | Change |
|---|---|
| Added | **Purchase lots** button on every ingredient row. It opens a **Select Purchase Lots** panel. |
| Added | The panel shows lot number, supplier, received date, expiry, available quantity, unit cost, **quantity to allocate** and the cost for that allocation. |
| Added | **Split across lots:** e.g. Rice 5 KG from Lot A at ₹100 and 5 KG from Lot B at ₹200 = ₹1,500. |
| Added | The allocation is pre-filled **oldest lot first** and can be edited. An **"Oldest first"** button resets it. |
| Added | **Stock without lot** (e.g. opening stock) appears as its own row at the material's average cost. |
| Added | Each row shows the ingredient's **material cost** and cost per unit. |
| Added | A **Production material cost** summary below the table shows the total and the planned cost per KG. |
| Validation | Start Production stays **disabled** until each ingredient's allocation equals its requirement exactly. |
| Validation | No lot can be allocated more than it holds. |
| Validation | **Expired, blocked/recalled, quarantined, rejected and other-warehouse lots** are never offered, and the server rejects them too. |
| Safety | The server **re-checks every lot under a lock** at start. Two simultaneous starts on the same lot let only one through, and a failed start deducts nothing. |
| Traceability | Each consumption record keeps the **exact lot IDs and each lot's own price**, marked "chosen by operator". |
| Kept | Purchase lot prices in Stock Hub are **never changed**. |
| Compatibility | Calls that don't send a lot allocation still use oldest-lot-first, exactly as before. |

---

## 7. Batch Manufacturing: Complete Production (actual yield and cost)

**Files:**
- Backend: `production.service.ts` (`approveProduction`) and `production.controller.ts`.
- Frontend:
  - `ActiveProductionRunsClient.tsx` (+251 / −37);
  - `src/lib/production-yield.ts` (**new**).

| Type | Change |
|---|---|
| Upgraded | The Complete Production popup shows recipe, **Production Batch ID**, **planned quantity and unit** (read-only) and **Actual Produced Quantity** (required). |
| Changed | The actual quantity box now **starts empty**. Before, it was pre-filled with the plan. |
| Added | Live **Yield Difference** and **Yield Variance %**. Example: 10 → 15 KG shows +5 KG, +50%. |
| Validation | The actual quantity must be greater than 0, with up to 3 decimals. Higher than planned is allowed. |
| Added | **Remarks become required** when the variance is more than 20% in either direction. The 20% is configurable. |
| Added | **Material cost tiles:** total material cost, planned cost per KG and **actual cost per KG**. Example: ₹1,500 / 10 = ₹150 planned, ₹1,500 / 15 = ₹100 actual. |
| Added | **Additional Materials Used** (optional): material, quantity, lot (or oldest first) and a note. Each entry is deducted, costed, added to the batch cost and saved separately as additional. |
| Rule | **Nothing extra is deducted** unless the operator enters it. A higher yield is never "explained" by inventing consumption. |
| Data | Planned and actual yield are **stored separately**, and the plan is never overwritten. |
| Data | Older runs that never stored a plan get it fixed at completion. |
| Data | **Audit log** entry for each completion: user, time, planned, actual, variance, material cost and unit cost. |
| Safety | Completing the same run twice is blocked (tested with three simultaneous clicks). |
| Unchanged | The actual quantity goes to Packaging as bulk stock. Finished goods are created only at packaging confirmation. |
| Kept | The optional Production Wastage and Batch Expiry fields. |
| Added | The run card shows **Planned Output**. |

---

## 8. Batch Registry: planned vs actual

**File:** `frontend/src/app/production/batches/page.tsx` (+36 / −4)

| Type | Change |
|---|---|
| Added | A **Planned / Actual** column showing the actual quantity, the plan and the variance %. |
| Added | The details panel shows **Actual Yield**, with planned and difference beneath it. |

---

## 9. Packaging & Confirmation: cost, expenses, profit/loss

**Files:**
- Backend:
  - `src/modules/production/production-costing.ts` (**new**, 246 lines; the calculation engine);
  - `production-costing.service.ts`;
  - `production.service.ts` (`packageAndConfirm`, `confirmPackagingTx`).
- Frontend:
  - `ProductionCostPanel.tsx` (**new**, 384 lines);
  - `src/lib/packaging-profit.ts` (**new**);
  - `src/app/packaging/page.tsx` (+126 / −119).

### 9.1 Quantity strip
Changed to **Planned Yield · Actual Yield · Already Packed · Currently Allocated · Remaining Bulk**. Packaging always works from the actual yield.

### 9.2 Production Cost Breakdown section (new)

| Part | What it shows or does |
|---|---|
| Batch header | Planned / actual yield, raw material cost (including any extra materials), planned cost/KG, **actual cost/KG** |
| Additional expenses | **Tick-boxes** for Manpower, Electricity, Other Expenses and Packaging Materials. Several can be ticked at once, and there is a **Select all / Clear all** link. |
| Each ticked expense | A **Per batch / Per KG / Per packet** switch, the ₹ amount with a /pkt, /kg or /batch hint, and **All pack sizes** or one size. **+ per size** adds a different rate for another size. |
| Blank amounts | Ignored; no error is shown. |
| Per-size table | Raw material, each expense, production cost per packet, selling price, and profit or loss per packet and in total. |
| Combined summary | Total production cost, good packets, estimated sales value, and total estimated profit or loss. |

### 9.3 Inside every packaging row (new)
**Production Cost / pkt** (read-only) · **Selling Price / pkt** · **Profit / Loss per pkt** · **Total Profit / Loss**

- **New variant:** the selling-price box sits right next to the cost (moved from the product-name row). It is still required.
- **Existing product:** its current Product Master price is shown read-only and is **never changed** here.
- **Loss** is shown in red, with the message: *"Warning: Selling price is ₹15 below production cost per packet. Estimated loss for 10 packets: ₹150. (Cost ₹155 · Selling price ₹140)"*.
- **Break-even** shows "Break-even". **Profit** is shown in green.
- A loss **does not block** confirmation, because no pricing policy in the system requires that.
- **Live updates:**
  - Profit or loss changes instantly as a price is typed.
  - Cost refreshes within about 0.25 s when packets, size or expenses change.

### 9.4 Calculation rules (server-side)
- **Raw material per packet** = actual material cost ÷ actual yield × pack weight. It uses the cost of the bulk lot actually consumed.
- **Expenses:**
  - **Per packet:** rate × packets.
  - **Per KG:** rate × packed weight (per litre for liquids).
  - **Per batch:** batch total × packed weight ÷ actual yield.
- **Per-batch expenses are charged only once.** Each session takes its share, and the session that finishes the batch takes the remainder. A per-batch amount can't be lowered below what has already been charged.
- **Damaged packets:** their cost is carried by the good packets of the same size, as before. The extra cost is shown.
- **Exact decimal arithmetic** is used for money, so profit or loss per packet × packets equals the total exactly.
- **Server is authoritative:** Confirm **recalculates everything on the server** and never uses totals sent from the screen.
- **Preview matches posting:** the preview endpoint uses the same calculation, so the screen and the posted cost match.

### 9.5 What is saved at confirmation
- Finished-goods stock is credited at the **full cost per good packet**, i.e. material plus expenses.
- Each packaging run stores a **cost snapshot**:
  - raw material cost;
  - each expense;
  - cost per packet and per good packet;
  - damage absorbed;
  - selling price;
  - profit or loss per packet and in total, and its status.
- Each charged expense is saved as a row (category, basis, rate, quantity, amount).
- The confirmation response includes the cost each packet was stocked at.

### 9.6 Removed from this screen
- The **"Packaging successfully confirmed"** summary card. Only the short "N packets added to Stock Hub" message remains.
- The old one-at-a-time **expense dropdown and "Add expense"** button, replaced by the tick-boxes.

### 9.7 Unchanged
Product selection, Create New Variant, SKU checks, pack sizes, good/damaged packets, multiple sizes in one confirmation and partial packaging across sessions.

---

## 10. Database changes (all additive)

| Migration | Adds |
|---|---|
| `20261013090000_purchase_lot_tracking` | **InventoryBatch** gets these columns: `goodsReceiptItemId` (unique), `procurementOrderId`, `vendorId`, `receivedAt`, `purchaseQty`, `purchaseUnit`, `purchasePrice`. |
| | **PurchaseReturnItem** gets `materialId`, `inventoryBatchId`, `baseQty` and `unitCost`. |
| | Indexes, foreign keys, and a two-pass back-fill of existing lots. |
| `20261013120000_recipe_formulations` | New tables: **RecipeIngredient**, **RecipeFormulation** (versioned) and **RecipeFormulationItem**. |
| | **Production** gets `formulationId`, `plannedYieldQty`, `plannedYieldUnit` and `formulationSnapshot`. |
| | Back-fill: the ingredient list and a "LEGACY" formulation v1 for every recipe that already had a bill of materials. |
| `20261014090000_production_lot_costing` | **ProductionItem** gets `isAdditional` and `note`. |
| | **ProductPackaging** gets `costBreakdown`. |
| | New table: **ProductionExpense**. |

All three were applied to the **local development database** and checked: the database matches the schema with no differences.

---

## 11. New and changed API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/raw-materials/:id/lots` | Purchase lots of a material |
| GET | `/api/recipes/:id/formulations` | Formulation versions |
| POST | `/api/recipes/:id/formulations` | Save a new formulation version |
| POST | `/api/production/plan/preview` | Scaled requirements and stock check |
| POST | `/api/production/plan/start` | Start from a formulation. **Now also accepts `lotAllocations`.** |
| GET | `/api/production/completion-settings` | Variance % above which remarks are required |
| GET | `/api/production/lot-options` | Usable lots per material in a warehouse |
| GET | `/api/production/costing-settings` | Expense categories and bases |
| GET | `/api/production/batches/:id/cost-summary` | Batch cost header, shared expenses, packaging sessions |
| POST | `/api/production/batches/:id/packaging-cost-preview` | Cost and profit preview (writes nothing) |
| POST | `/api/production/:id/approve` | **Changed:** actual yield is required. Also accepts `additionalMaterials` and returns cost per KG. |
| POST | `/api/production/batches/:id/package-confirm` | **Changed:** accepts `expenses` and returns `unitCost` per SKU. |

---

## 12. Removed from screens

| Screen | Removed |
|---|---|
| ERP Assistant | "ERP Assistant" text on the floating button |
| Recipe Master | Yield qty, yield unit, and ingredient qty and unit fields (moved to Production Planning) |
| Reference Formulation | Banner, separate reference-yield field and unit, change note, explanatory text |
| Production Planning | "Start this production run?" confirmation popup |
| Complete Production | Pre-filled actual quantity (now starts empty) |
| Packaging | "Packaging successfully confirmed" summary card |
| Packaging | Expense category dropdown and "Add expense" button (replaced by tick-boxes) |
| Packaging | Red "enter an amount" error for blank expenses |

**Nothing was deleted from the database or the code modules.**

---

## 13. Bug fixes made along the way

| Problem | Fix |
|---|---|
| Production Planning crashed with *"Cannot read properties of null (reading 'yieldQty')"* | The formulation draft is now set up safely, with a usable-formulation check. |
| A recipe with no ingredient quantities could start a run that consumed nothing | Start is now blocked with a clear message. |
| A GRN could post stock twice on a double-click or retry | Row lock plus a unique lot per GRN line. |
| Deleting a recipe failed once the new formulation tables existed | Child rows are now deleted along with the recipe. |

---

## 14. Tests and verification

### Backend (run on a throwaway database each time)

| Test file | Checks | Result |
|---|---|---|
| `src/tests/procurement/purchase-lot-tracking.test.ts` | 30 | ✅ all pass |
| `src/tests/production/recipe-formulation.test.ts` | 39 | ✅ all pass |
| `src/tests/production/actual-yield-completion.test.ts` | 28 | ✅ all pass |
| `src/tests/production/lot-wise-production-costing.test.ts` | 43 | ✅ all pass |
| `src/tests/production/packaging-profit.test.ts` | 17 | ✅ all pass |

### Frontend (vitest)

| Test file | Tests | Result |
|---|---|---|
| `ReferenceFormulationPanel.test.tsx` | 10 | ✅ |
| `production-yield.test.ts` | 4 | ✅ |
| `lot-allocation.test.ts` | 4 | ✅ |
| `ProductionCostPanel.test.ts` | 3 | ✅ |
| `packaging-profit.test.ts` | 4 | ✅ |

### Regression
After the final change, the existing Production, POS, Finance, Franchise and Inventory test scripts were run again and compared line by line with the original code. **The results are identical.** The only difference is a randomly generated SKU number inside one script that already failed on the original code.

Some older scripts fail **on the original code as well**, so these failures were not caused by this work:
- the bulk-pool cross-batch costing script, which calls QC inspection while QC is switched off;
- the purchase-return ledger script;
- the GRN units script;
- a few Franchise and Finance scripts.

### Type and lint checks
- Backend TypeScript compiles clean.
- Frontend TypeScript compiles clean, apart from errors in the existing Playwright e2e files.
- ESLint is clean on every changed frontend file.

### Not done
The screens have **not been clicked through in a browser**.

---

## 15. Settings you can change

Set these with `POST /api/settings`. There is no settings screen for them yet.

| Key | Default | Meaning |
|---|---|---|
| `PRODUCTION_YIELD_VARIANCE_REMARKS_PCT` | `20` | Remarks are required at completion when the actual yield differs from plan by more than this % |
| `PRODUCTION_EXPENSE_CATEGORIES` | Manpower, Electricity, Other Expenses, Packaging Materials | JSON list of `{code, label}` for packaging expense categories |

---

## 16. Pending actions and known limitations

1. **Nothing is committed yet.** All changes are staged in both repositories.
2. **Migration history:** the local database's migration history doesn't match the repository, so the three migrations were applied directly. Once that's sorted out, mark them as applied:
   ```
   npx prisma migrate resolve --applied 20261013090000_purchase_lot_tracking
   npx prisma migrate resolve --applied 20261013120000_recipe_formulations
   npx prisma migrate resolve --applied 20261014090000_production_lot_costing
   ```
   On any other environment (UAT or production), run the normal `prisma migrate deploy`.
3. **Bulk stock across batches:** packaging still draws bulk stock **oldest first across all batches of the same recipe**. That was the existing behaviour, and an existing test relies on it. If an older batch of the same recipe still has bulk left, packing a newer batch uses the older batch's cost first. The cost preview shows this correctly. Packing each batch from its own bulk first is a possible change; it needs a decision.
4. **Damaged-packet policy:** damaged packets' cost is added to the good packets of the same size, as before. Writing it off as a separate loss is the alternative; it needs a decision.
5. **Reports pages** do not show the new planned/actual yield or packaging cost yet.
6. **No settings screen** exists for the two settings in section 15.
7. **Browser testing** has not been done.

---

## 17. Full file list

### Backend: `kiddosfood-erp-backend`

| Status | File | +/− |
|---|---|---|
| New | `prisma/migrations/20261013090000_purchase_lot_tracking/migration.sql` | +126 |
| New | `prisma/migrations/20261013120000_recipe_formulations/migration.sql` | +106 |
| New | `prisma/migrations/20261014090000_production_lot_costing/migration.sql` | +34 |
| Modified | `prisma/schema.prisma` | +147 / −8 |
| Modified | `src/app.ts` (routes) | +10 |
| Modified | `src/modules/grn/grn.service.ts` | +30 / −3 |
| New | `src/modules/inventory/purchase-lots.service.ts` | +243 |
| Modified | `src/modules/inventory/raw-materials.controller.ts` | +20 / −1 |
| Modified | `src/modules/procurement/procurement.service.ts` | +7 / −1 |
| New | `src/modules/production/production-costing.service.ts` | +380 |
| New | `src/modules/production/production-costing.ts` | +246 |
| Modified | `src/modules/production/production.controller.ts` | +117 |
| Modified | `src/modules/production/production.service.ts` | +322 / −19 |
| Modified | `src/modules/purchase/purchase.service.ts` | +100 / −38 |
| New | `src/modules/recipes/formulation.service.ts` | +289 |
| Modified | `src/modules/recipes/recipe.controller.ts` | +24 / −1 |
| Modified | `src/modules/recipes/recipe.service.ts` | +115 / −16 |
| New | `src/tests/procurement/purchase-lot-tracking.test.ts` | +201 |
| New | `src/tests/production/actual-yield-completion.test.ts` | +142 |
| New | `src/tests/production/lot-wise-production-costing.test.ts` | +243 |
| New | `src/tests/production/packaging-profit.test.ts` | +73 |
| New | `src/tests/production/recipe-formulation.test.ts` | +166 |

### Frontend: `kiddosfood-erp-frontend`

| Status | File | +/− |
|---|---|---|
| Modified | `src/app/packaging/page.tsx` | +126 / −119 |
| Modified | `src/app/production/batches/page.tsx` | +36 / −4 |
| Modified | `src/app/production/page.tsx` | +251 / −98 |
| Modified | `src/components/assistant/ERPAssistant.tsx` | +72 / −6 |
| New | `src/components/modules/inventory/MaterialLotsPanel.tsx` | +182 |
| Modified | `src/components/modules/inventory/RawMaterialStockClient.tsx` | +48 / −10 |
| Modified | `src/components/modules/production/ActiveProductionRunsClient.tsx` | +251 / −37 |
| New | `src/components/modules/production/IngredientLotPanel.tsx` | +118 |
| New | `src/components/modules/production/ProductionCostPanel.tsx` | +384 |
| Modified | `src/components/modules/production/RecipeMasterTab.tsx` | +58 / −81 |
| New | `src/components/modules/production/ReferenceFormulationPanel.tsx` | +198 |
| New | `src/components/modules/production/__tests__/ProductionCostPanel.test.ts` | +35 |
| New | `src/components/modules/production/__tests__/ReferenceFormulationPanel.test.tsx` | +159 |
| Modified | `src/components/modules/purchases/NewPurchaseReturnModal.tsx` | +68 / −6 |
| New | `src/lib/__tests__/lot-allocation.test.ts` | +44 |
| New | `src/lib/__tests__/packaging-profit.test.ts` | +32 |
| New | `src/lib/__tests__/production-yield.test.ts` | +30 |
| Modified | `src/lib/api/inventory.api.ts` | +27 / −1 |
| New | `src/lib/lot-allocation.ts` | +93 |
| New | `src/lib/packaging-profit.ts` | +35 |
| New | `src/lib/production-yield.ts` | +47 |

**Modules not touched:**
- Sales, POS, Dispatch, Franchise, GST, Finance;
- Reports;
- Purchase Orders (apart from adding lots to the returnable-materials list);
- Batch Recall;
- Wastage.
