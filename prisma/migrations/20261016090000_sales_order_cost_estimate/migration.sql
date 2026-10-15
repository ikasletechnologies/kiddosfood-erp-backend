-- Estimated cost / profit frozen on a Sales Order when it is saved (an
-- estimate: realized cost is recorded when stock is issued on fulfilment).
-- Additive and nullable: existing orders are untouched (null = not estimated).
ALTER TABLE "SalesOrder" ADD COLUMN "estimatedCostOfGoods" DOUBLE PRECISION;
ALTER TABLE "SalesOrder" ADD COLUMN "estimatedGrossProfit" DOUBLE PRECISION;
ALTER TABLE "SalesOrder" ADD COLUMN "estimatedMarginPct" DOUBLE PRECISION;
ALTER TABLE "SalesOrder" ADD COLUMN "costUnavailableLines" INTEGER;
ALTER TABLE "SalesOrder" ADD COLUMN "costEstimatedAt" TIMESTAMP(3);

ALTER TABLE "SalesOrderItem" ADD COLUMN "estimatedUnitCost" DOUBLE PRECISION;
ALTER TABLE "SalesOrderItem" ADD COLUMN "estimatedCostOfGoods" DOUBLE PRECISION;
ALTER TABLE "SalesOrderItem" ADD COLUMN "estimatedProfit" DOUBLE PRECISION;
