import { Permissions } from '../../rbac/permissions';

export interface StageDef {
  key: string;
  label: string;
  requiredPermission: string;
}

// Server-side mirror of the stage sequences in
// ERP-frontend/src/app/admin/approvals/page.tsx (PURCHASE_STAGES /
// PRODUCTION_STAGES / EXPENSE_STAGES). Keep the stage keys/order identical —
// the frontend still owns the display labels/descriptions; this is only used
// to resolve which permission gates advancing out of a given stage.
export const STAGE_CONFIG: Record<'PURCHASE' | 'PRODUCTION' | 'EXPENSE', StageDef[]> = {
  PURCHASE: [
    { key: 'REQUEST', label: 'Purchase Request', requiredPermission: Permissions.PURCHASE_CREATE },
    { key: 'MANAGER_APPROVE', label: 'Manager Approval', requiredPermission: Permissions.PURCHASE_MANAGER_APPROVE },
    { key: 'ORDER', label: 'Purchase Order', requiredPermission: Permissions.PURCHASE_ORDER_DISPATCH },
    { key: 'GRN', label: 'GRN Receipt', requiredPermission: Permissions.PURCHASE_GRN_APPROVE },
    { key: 'ACCOUNTS_VERIFY', label: 'Accounts Review', requiredPermission: Permissions.PURCHASE_ACCOUNTS_VERIFY },
    { key: 'PAYMENT', label: 'Vendor Payment', requiredPermission: Permissions.PURCHASE_PAYMENT_RELEASE },
  ],
  PRODUCTION: [
    { key: 'PLAN', label: 'Production Plan', requiredPermission: Permissions.PRODUCTION_PLAN_CREATE },
    { key: 'FACTORY_APPROVE', label: 'Factory Approval', requiredPermission: Permissions.PRODUCTION_FACTORY_APPROVE },
    { key: 'EXECUTION', label: 'Execution', requiredPermission: Permissions.PRODUCTION_EXECUTION },
    { key: 'QC', label: 'QC Verification', requiredPermission: Permissions.PRODUCTION_QC_VERIFY },
    { key: 'FINISHED_ENTRY', label: 'Finished Goods Entry', requiredPermission: Permissions.PRODUCTION_FINISHED_ENTRY },
  ],
  EXPENSE: [
    { key: 'ENTRY', label: 'Expense Entry', requiredPermission: Permissions.EXPENSE_ENTRY_CREATE },
    { key: 'DEPT_APPROVE', label: 'Dept Approval', requiredPermission: Permissions.EXPENSE_DEPT_APPROVE },
    { key: 'ACCOUNTS_APPROVE', label: 'Accounts Approval', requiredPermission: Permissions.EXPENSE_ACCOUNTS_APPROVE },
    { key: 'PAYMENT_RELEASE', label: 'Payment Release', requiredPermission: Permissions.EXPENSE_PAYMENT_RELEASE },
  ],
};

export function getStageIndex(category: keyof typeof STAGE_CONFIG, stageKey: string) {
  return STAGE_CONFIG[category].findIndex((s) => s.key === stageKey);
}
