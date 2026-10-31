# Purchase Orders: direct goods receipt

Saved PO → Receive Goods → existing pending GRN → GRN confirmation → stock and bill posting.

## Changes

- Normal PO creation now explicitly saves `APPROVED` (displayed as **Ready for Receipt**), including older callers supplying `PENDING_APPROVAL`. Explicit `DRAFT` stays a draft. No approval timestamp or approver is fabricated.
- Legacy `PENDING_APPROVAL`, existing `APPROVED`, `ORDERED`, `SENT`, and `PARTIALLY_RECEIVED` POs are receipt-eligible. Old rows and approval history are not rewritten.
- Saving a completed draft updates its existing ID to `APPROVED`; saving an edited draft as Draft also updates the same ID.
- PO list/details use Receive Goods / Receive Remaining Goods. Draft rows offer Edit / Complete PO. Existing View Details remains available for completed records. No Approve button or Pending Approval filter remains; the Ready for Receipt filter includes legacy pending records.
- The list API adds `canReceive`, considering existing receipt/return fulfillment. The Pending GRNs counter and GRN queue use receipt eligibility. GRN continues loading the PO through the existing `?poId=` navigation and checking authoritative remaining quantities.
- GRN creation rejects drafts and terminal POs. Posting rechecks the current PO status under its existing row lock, preventing a pending GRN from posting after cancellation. Existing GRN quantity checks, calculations, stock, bills, lots, expiry and warehouse posting are unchanged.
- Open receipt-ready POs continue protecting their vendor from deactivation, replacing the former pending-approval-only vendor guard.

## API and database

No new endpoints, migrations, status enums, or database corrections. Existing authentication and Super Admin route permissions remain. POST `/api/purchase-orders` returns `APPROVED` by default. PATCH `/api/purchase-orders/:id` accepts Draft / Ready for Receipt saves through `status`. GET `/api/purchase-orders` includes `canReceive`. GRN endpoints retain their separate create/confirm calls. The old protected PO approve endpoint remains for compatibility, but is unused by the UI and cannot reopen draft or terminal orders.

No inventory or vendor bill is created by PO creation or pending GRN creation. GRN confirmation remains the posting boundary. No Semi-Finished Excel import is added.

## Files

Backend:
- `src/modules/procurement/procurement.service.ts`
- `src/modules/procurement/po-receipt-status.ts`
- `src/modules/grn/grn.service.ts`
- `src/tests/procurement/po-direct-receipt.integration.test.ts`

Sibling frontend:
- `src/components/modules/purchases/PurchaseOrdersClient.tsx`
- `src/components/modules/purchases/PurchaseFormContent.tsx`
- `src/app/purchases/grn/page.tsx`
- `src/lib/po-receipt.ts`
- `src/lib/__tests__/po-receipt.test.ts`
- `src/components/modules/purchases/__tests__/PurchaseOrdersClient.test.tsx`

## Verification

- Real PostgreSQL rollback-only integration: raw materials, retail Finished Goods, and purchased bulk Finished Goods. Verifies no early stock/bill posting, partial/full receipt, original classification/prices/GST, purchase bills, bulk product batches, remaining-quantity checks, duplicate-post prevention, draft completion, legacy pending eligibility/history, cancelled-order guards, vendor protection, and receipt counters. Passed; fixtures and number sequences rolled back.
- Frontend: 3 receipt eligibility/counter tests, 1 rendered PO list test, 4 existing Semi-Finished client regression tests. All 8 passed.
- Backend production build passed.
- Frontend production build passed (136 static pages) in an isolated project copy, leaving the live dev server's `.next` files untouched. Existing unrelated image-optimization warnings remain.

Existing staged migration changes belong to the user's workspace and were not changed by this task. Integration execution emits the existing `pg` concurrent-query deprecation warning; assertions pass.
