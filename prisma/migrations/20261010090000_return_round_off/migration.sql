-- Round-off reversed on a sales return (credit = taxable + tax + roundOffAmount)
ALTER TABLE "ReturnOrder" ADD COLUMN "roundOffAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
