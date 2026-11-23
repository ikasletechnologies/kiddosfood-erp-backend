-- Phase 1 production-safety fixes (audit C-04, C-05, C-07).
-- Additive only: new nullable columns, one enum, one unique index, one FK,
-- and a conservative backfill of Payment.flow. No data is deleted or rewritten
-- except the NULL -> value backfill of the brand-new "flow" column.

-- C-07: persisted payment direction
CREATE TYPE "PaymentFlow" AS ENUM ('IN', 'OUT');
ALTER TABLE "Payment" ADD COLUMN "flow" "PaymentFlow";

-- C-05: PO cancellation metadata (reason is now mandatory at the API)
ALTER TABLE "ProcurementOrder"
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledBy" TEXT;

-- C-04: server-generated GRN-rejection returns, at most one per GRN
ALTER TABLE "PurchaseReturn" ADD COLUMN "goodsReceiptId" TEXT;
CREATE UNIQUE INDEX "PurchaseReturn_goodsReceiptId_key" ON "PurchaseReturn"("goodsReceiptId");
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_goodsReceiptId_fkey"
  FOREIGN KEY ("goodsReceiptId") REFERENCES "GoodsReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- C-07 backfill: classify legacy payments only where the creating code path is
-- unambiguous. Mirrors inferLegacyPaymentFlow() in
-- src/modules/finance/payment-flow.ts — keep the two in sync. Anything not
-- matched stays NULL and must be classified manually before it can be
-- cancelled (scripts/phase1-reconciliation-report.ts lists them).
UPDATE "Payment" SET "flow" = CASE
  WHEN "type" = 'REVERSAL' THEN NULL
  WHEN "type" = 'INTERNAL_TRANSFER' AND "paymentNumber" LIKE '%-IN' THEN 'IN'::"PaymentFlow"
  WHEN "type" = 'INTERNAL_TRANSFER' THEN 'OUT'::"PaymentFlow"
  WHEN "sourceModule" = 'FRANCHISE' THEN 'OUT'::"PaymentFlow"
  WHEN "sourceModule" IN ('EXPENSE', 'PAYROLL') THEN 'OUT'::"PaymentFlow"
  WHEN "sourceModule" = 'PROCUREMENT' AND "type" = 'REFUND' THEN 'IN'::"PaymentFlow"
  WHEN "sourceModule" = 'PROCUREMENT' THEN 'OUT'::"PaymentFlow"
  WHEN "sourceModule" = 'POS' AND "entityType" = 'VENDOR' THEN 'OUT'::"PaymentFlow"
  WHEN "sourceModule" = 'POS' THEN 'IN'::"PaymentFlow"
  WHEN "entityType" = 'CENTRAL_WAREHOUSE' THEN 'IN'::"PaymentFlow"
  ELSE NULL
END
WHERE "flow" IS NULL;
