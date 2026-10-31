# Purchase GST snapshots and business dates

## Causes and changes

The purchase line editor used a truthy fallback (`gstRate || masterRate`), replacing an explicit zero. GRN listing omitted PO lines, so its details fell back to current Product Master tax instead of the saved purchase snapshot. Return tax backfilling also guessed a 5% rate when no source matched and rounded mixed rates; bill-based return valuation could include GST in the goods rate and then add GST again.

Purchase creation/update now requires an explicit valid line GST rate (including zero). Missing, invalid or ambiguous source rates fail clearly. Manual tax totals must match calculated totals. GRNs expose their original PO lines; GRN and bill views use those snapshots, and backend bills calculate tax from accepted quantities. Returns resolve original lots/POs and stable material IDs, sum per-line tax with Decimal arithmetic, and keep goods value separate from tax. Vendor ledger return credits include that saved tax exactly once. Recognized bills and ledger postings cannot be silently rewritten by bill replay; listing bills no longer deletes duplicates.

The backend derives new Purchase Date from its current timestamp in Asia/Kolkata. The frontend displays it read-only, ignores stale draft purchase dates, and submits date-only values. Expected Delivery is required and must be on or after both Purchase Date and today's business date. Frontend picker minimum and explicit validation mirror server validation. Existing historical Purchase Dates are immutable; unchanged historical delivery dates are retained, while changed delivery dates and draft completion must satisfy current validation.

No schema migration is needed. Existing `createdAt` is the authoritative purchase timestamp; existing PO line rates, bill totals and return tax fields store the snapshots. Purchase Orders remain immediately receipt-eligible; no approval step was added. Stock is still posted only by the existing confirmed-GRN flow.

## Changed files

Backend:
- `src/modules/procurement/purchase-tax.ts`
- `src/modules/procurement/purchase-dates.ts`
- `src/modules/procurement/procurement.service.ts`
- `src/modules/grn/grn.service.ts`
- `src/modules/vendor-invoices/vendor-invoices.service.ts`
- `src/modules/purchase/purchase.service.ts`
- `src/tests/procurement/purchase-gst-dates.integration.test.ts`
- `src/tests/procurement/po-direct-receipt.integration.test.ts` (required delivery-date fixture)
- `scripts/review-purchase-tax.ts`
- `docs/purchase-tax-review.json`

Frontend (sibling `kiddosfood-erp-frontend` repository):
- `src/context/PurchaseOrderContext.tsx`
- `src/components/modules/purchases/PurchaseFormContent.tsx`
- `src/components/documents/LineItemsTable.tsx`
- `src/app/purchases/grn/page.tsx`
- `src/app/purchases/invoices/page.tsx`
- `src/components/modules/purchases/PurchaseReturnDetailsModal.tsx`
- `src/components/modules/purchases/PurchaseReturnsClient.tsx`
- `src/components/modules/purchases/NewPurchaseReturnModal.tsx`
- `src/lib/purchase-dates.ts` and its tests
- `src/lib/purchase-return-totals.ts` and its tests
- `src/components/modules/purchases/__tests__/PurchaseGstDates.test.tsx`
- `src/components/modules/purchases/__tests__/PurchaseReturnGst.test.tsx`

## API contract

Existing PO endpoints and authentication remain unchanged. New PO requests require `expectedDeliveryDate` (prefer `YYYY-MM-DD`) and explicit `items[].gstRate`. Optional `purchaseDate` must equal today's server business date; clients cannot backdate a new PO. Update requests cannot change the historical Purchase Date. Validation failures use the existing HTTP 400 error response.

Purchase Bills linked to GRNs require a confirmed GRN belonging to the specified PO and vendor. GRN-only requests derive the PO from the GRN. Server calculations override client subtotal/tax guesses. Replaying an already recognized bill preserves its original reference and totals; changed recognized amounts require an audited correction.

## Read-only historical review

`docs/purchase-tax-review.json` records six bills and six completed GRNs reviewed, with **zero posted financial mismatch candidates**. Three GRNs have saved zero rates and current master rates of 5%, exposing the old display fallback. The reported TEST purchase is `PO-2026-008`: saved taxable value ₹100, GST ₹0, total ₹100. Its bill and ledger match. No posted financial record was corrected.

The review cannot prove that a consistently saved 5% PO was originally intended to be 0%; that requires original entry evidence. Mixed-source legacy returns without lot/PO identities require review rather than guessing.

## Safe correction procedure

1. Run `npx tsx scripts/review-purchase-tax.ts` read-only and retain the report. Identify exact PO line, GRN accepted quantities, bill, return, payment and ledger IDs.
2. Compare original saved tax snapshots and source-entry evidence. Distinguish a display error from a posted amount error; display-only errors need no financial adjustment.
3. Prepare a specific correction with before/after goods value, tax components, credit/payable amounts and affected reports. Obtain explicit Super Admin approval before any write.
4. Preserve original rows and references. Apply separately reviewed linked compensating entries through the established accounting mechanisms and record actor, approval, reason, source references and before/after amounts in the audit trail. A vendor-ledger adjustment alone does not correct bill tax or GST reports; those need a coordinated approved correction plan.
5. Reconcile vendor balance, bill outstanding, return credits and tax reports. Retain approval and verification evidence. Do not delete posted bills, reset balances or run bulk historical rewrites.

No automatic posted-tax correction endpoint or bulk repair is introduced by this change.

## Verification

Database-backed integration tests run inside a rolled-back transaction: GST 0%, 5%, 12%, 18%, 28% and 2.5%; PO → confirmed GRN → bill → vendor ledger → full return; partial acceptance; posted-bill replay; missing tax; tampered totals; server date validation; historical date preservation. The direct-receipt regression covers raw and finished goods, partial/full receipts and protected statuses.

Frontend tests cover zero-rate preservation against master defaults, configured custom rates, read-only Purchase Date, date picker minimum, invalid manual delivery dates, date-only request payloads, saved return totals and rendered return-details totals. Fifteen distinct frontend tests passed, including the existing PO list regression. Changed frontend sources passed lint. Backend integration and backend production build passed. The frontend production build passed type checking and generated all 136 pages. It ran in an isolated verification copy, with lint checked separately, to preserve the running development server's chunk output. An initial missing return-view import was caught by type checking, corrected and covered by the rendering regression before the successful build.
