import { Request, Response, NextFunction } from 'express';

// Production-only feature flags for the simplified production workflow
// (Planning -> Run -> Complete -> Package & Confirm -> Finished Goods).
//
// These flags only gate PRODUCTION routes and production status transitions.
// They never touch GRN/purchase QC (GoodsReceiptItem.qcStatus), which is a
// separate model with its own service.
//
// QC and Labels default to OFF — set the env var to "true" to re-enable one
// exactly as it worked before (none of its code, routes, or data were removed).
// Recall defaults to ON: it is an active, independent food-safety module that
// never adds a step to normal production or packaging. Set it to "false" to
// hide it again.
//   PRODUCTION_QC_ENABLED      — Production batch QC inspection step
//   PRODUCTION_LABELS_ENABLED  — Labels & Barcodes / sticker verification step
//   PRODUCTION_RECALL_ENABLED  — Starting new batch recalls
//
// Read through getters (not cached at import) so tests and ops can flip a
// flag via process.env without a code change.
function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const ProductionFlags = {
  get qcEnabled(): boolean {
    return envFlag('PRODUCTION_QC_ENABLED', false);
  },
  get labelsEnabled(): boolean {
    return envFlag('PRODUCTION_LABELS_ENABLED', false);
  },
  get recallEnabled(): boolean {
    return envFlag('PRODUCTION_RECALL_ENABLED', true);
  },
};

// ProductBatch.qcStatus value for a batch released straight to packaging
// because production QC is switched off. Deliberately NOT "APPROVED" — no QC
// inspection happened, and reports/audits must be able to tell the two apart.
export const QC_NOT_REQUIRED = 'QC_NOT_REQUIRED';

// qcStatus values whose quantity (ProductBatch.approvedQty) may be packaged.
export const PACKAGEABLE_QC_STATUSES = ['APPROVED', 'PARTIALLY_APPROVED', QC_NOT_REQUIRED];

type ProductionFeature = 'qc' | 'labels' | 'recall';

const FEATURE_LABELS: Record<ProductionFeature, string> = {
  qc: 'Production QC',
  labels: 'Labels & Barcodes',
  recall: 'Batch Recall',
};

function isFeatureEnabled(feature: ProductionFeature): boolean {
  if (feature === 'qc') return ProductionFlags.qcEnabled;
  if (feature === 'labels') return ProductionFlags.labelsEnabled;
  return ProductionFlags.recallEnabled;
}

// Route guard for production-specific endpoints of a hidden module.
export function requireProductionFeature(feature: ProductionFeature) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!isFeatureEnabled(feature)) {
      return res.status(403).json({
        error: `${FEATURE_LABELS[feature]} is disabled in the current production workflow.`,
      });
    }
    next();
  };
}
