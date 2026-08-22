export interface StageDef {
  key: string;
  label: string;
}

// Server-side mirror of the stage sequences in
// ERP-frontend/src/app/admin/approvals/page.tsx (PURCHASE_STAGES /
// PRODUCTION_STAGES / EXPENSE_STAGES). Keep the stage keys/order identical —
// the frontend still owns the display labels/descriptions. Every stage is
// advanced by a Franchise Admin (scoped to their own franchise, enforced in
// WorkflowApprovalsService.approve) or a Super Admin — there's no separate
// department-role permission gate per stage.
export const STAGE_CONFIG: Record<'PURCHASE' | 'PRODUCTION' | 'EXPENSE', StageDef[]> = {
  PURCHASE: [
    { key: 'REQUEST', label: 'Purchase Request' },
    { key: 'MANAGER_APPROVE', label: 'Manager Approval' },
    { key: 'ORDER', label: 'Purchase Order' },
    { key: 'GRN', label: 'GRN Receipt' },
    { key: 'ACCOUNTS_VERIFY', label: 'Accounts Review' },
    { key: 'PAYMENT', label: 'Vendor Payment' },
  ],
  PRODUCTION: [
    { key: 'PLAN', label: 'Production Plan' },
    { key: 'FACTORY_APPROVE', label: 'Factory Approval' },
    { key: 'EXECUTION', label: 'Execution' },
    { key: 'QC', label: 'QC Verification' },
    { key: 'FINISHED_ENTRY', label: 'Finished Goods Entry' },
  ],
  EXPENSE: [
    { key: 'ENTRY', label: 'Expense Entry' },
    { key: 'DEPT_APPROVE', label: 'Dept Approval' },
    { key: 'ACCOUNTS_APPROVE', label: 'Accounts Approval' },
    { key: 'PAYMENT_RELEASE', label: 'Payment Release' },
  ],
};

export function getStageIndex(category: keyof typeof STAGE_CONFIG, stageKey: string) {
  return STAGE_CONFIG[category].findIndex((s) => s.key === stageKey);
}
