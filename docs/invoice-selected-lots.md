# Sale Invoice selected-lot fulfilment

## Root cause and posting event

The Sale Invoice UI saves invoices with deferred fulfilment. Saving selected lots records an allocation proposal, not a stock issue; payment settles money independently. INV-2026-0002 was paid, but `Order.inventory_deducted` was false and it had no linked challan or stock deduction. Nothing had reached the established Delivery Challan `IN_TRANSIT` dispatch event. Invoice details showed payment prominently without a separate inventory state.

Two additional backend weaknesses affected repeated SKU lines: partial fulfilment and cost attribution grouped by SKU instead of the selected lot, and document status could imply fulfilment without matching ledger evidence. These now retain exact lot IDs and derive deferred fulfilment quantities from actual per-lot stock movements. Invoice price/tax snapshots are matched to the selected lot. Reversal costs are attributed to that lot's invoice lines.

## Implementation

- Existing invoice save, payment, printing, POS and invoice-from-challan posting rules are retained. Deferred invoice stock still posts through the existing challan dispatch service.
- Invoice details now display Inventory Status independently of Payment Status, a lot-level before/after preview, an existing-challan link, and an explicitly confirmed **Dispatch Selected Lots** action for Super Admin.
- GET `/api/sales/invoices/:id/dispatch-review` is read-only and enforces seller scope. It checks saved allocations, existing dispatches/movements, units, SKU, warehouse, expiry, status, reservations and available quantities. Ambiguous existing history blocks automatic reconciliation.
- POST `/api/sales/invoices/:id/dispatch-selected` requires Super Admin plus `confirm: true`. It creates an `IN_TRANSIT` challan through `SalesService.createDeliveryChallan`, using a deterministic unique idempotency key. The existing transaction posts the challan, lot depletion, movements, costs and fulfilment flag atomically. Existing order/item/lot row locks and quantity checks prevent overselling. Retries return the existing posting.
- `INVOICE_FULFILMENT` movements reference the challan; its `sourceInvoiceId` references the invoice's Order, and each movement has the exact `batchId`. Existing reversal references are retained.
- Availability now uses the movement ledger rather than relying solely on cached `InventoryItem.currentStock`. Existing Stock Hub queries already derive aggregate stock from this ledger. Frontend posting refreshes invoice data and emits existing inventory refresh events.
- No new tables, Prisma fields, migrations or parallel stock system were added. Production/purchase unit costs and selling prices are untouched.

## Targeted reconciliation

Applied only to INV-2026-0002 after verifying no prior issue and both selected lots eligible. Created **DC-2026-00002** (`445d799a-55db-4ec3-b2d8-dfbbe94b053c`).

| Lot | Before | After | Issued |
| --- | ---: | ---: | ---: |
| LOT-20261031-00001 | 10 PC | 9 PC | 1 PC |
| LOT-20261031-00003 | 1 PC | 0 PC | 1 PC |

The live ledger was 26 PC when verified, not the earlier 21 PC snapshot. It became **24 PC**, exactly 2 fewer. No attempt was made to force a historical total of 19. Both lots retained their ₹35 unit cost, so issued inventory cost is ₹70. The ₹74 invoice and its existing payment rows were deep-compared before/after and remained unchanged. An immediate replay returned `alreadyPosted: true` with no further deduction. No other historical invoices were reconciled.

See `docs/INV-2026-0002-reconciliation.json` for the recorded before/after evidence. `scripts/reconcile-invoice-selected-lots.ts` reviews only this exact invoice by default; `--post` explicitly invokes the guarded single-invoice posting path. The API remains the authenticated correction mechanism.

## Files

Backend: `src/app.ts`, `src/modules/finance/finance.service.ts`, `src/modules/sales/invoice-fulfilment.service.ts`, `src/modules/sales/invoice-dispatch.service.ts`, `scripts/reconcile-invoice-selected-lots.ts`, `src/tests/with-rollback.ts`, `src/tests/sales/invoice-selected-lots.integration.test.ts`, and this report/evidence.

Frontend: `src/app/sales/invoices/SalesInvoicesClient.tsx`, `src/components/sales/InvoiceInventoryStatus.tsx`, `src/components/sales/__tests__/InvoiceInventoryStatus.test.tsx`.

## Verification

- Real PostgreSQL rollback-only integration passed: one and two selected lots; paid invoice remains pending before dispatch; exact per-lot issues/costs; partial dispatch against the second lot first; ledger stock; duplicate calls; read-only reload/print data; cancellation guards and restoration; expiry and insufficient stock; role protection. All fixtures rolled back.
- Invoice Inventory Status UI tests passed (3): no posting on load, explicit dispatch confirmation and refresh, declined confirmation, and ineligible-lot blocking.
- Existing PO regression tests passed (4 cases), preserving the preceding direct-receipt change.
- The targeted real invoice reconciliation and replay check passed independently of fixtures.
- The production backend build passed. The independent Stock Hub inventory query returned 24 PC after reconciliation, with exactly two linked deduction movements and `FULFILLED` / `PAID` states.
- The isolated frontend production build passed full TypeScript checking and generated all 136 static pages. Worker limits were applied only to the verification copy, and lint was run separately to reduce peak memory; the live dev server's build directory was untouched.
- Separate lint verification of the changed invoice UI and tests passed with no warnings or errors.

The existing disposable-database invoice suite was not run against the live database. Concurrent safety continues to use the existing PostgreSQL locks and unique challan key; no destructive database reset was performed. Existing `pg` query-concurrency and Vite deprecation warnings are unrelated to the posting result.
