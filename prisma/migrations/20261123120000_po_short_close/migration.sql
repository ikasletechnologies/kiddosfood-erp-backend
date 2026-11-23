-- F-03: short-close a partially received purchase order (undelivered balance
-- cancelled with a mandatory reason). Additive, nullable columns only.
ALTER TABLE "ProcurementOrder"
  ADD COLUMN "shortCloseReason" TEXT,
  ADD COLUMN "shortClosedAt" TIMESTAMP(3),
  ADD COLUMN "shortClosedBy" TEXT;
