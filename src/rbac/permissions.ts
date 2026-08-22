export const Permissions = {
  // User Management
  USERS_VIEW: 'users:view',
  USERS_CREATE: 'users:create',
  USERS_EDIT: 'users:edit',
  USERS_DELETE: 'users:delete',

  // Role Management
  ROLES_VIEW: 'roles:view',
  ROLES_CREATE: 'roles:create',
  ROLES_EDIT: 'roles:edit',
  ROLES_DELETE: 'roles:delete',

  // Franchise Management
  FRANCHISE_VIEW: 'franchise:view',
  FRANCHISE_MANAGE: 'franchise:manage',

  // Inventory
  INVENTORY_VIEW: 'inventory:view',
  INVENTORY_MANAGE: 'inventory:manage',

  // POS
  POS_ACCESS: 'pos:access',
  POS_REFUND: 'pos:refund',

  // Finance
  FINANCE_REPORTS: 'finance:reports',
  FINANCE_EXPENSES: 'finance:expenses',

  // Production
  PRODUCTION_MANAGE: 'production:manage',
  RECIPES_MANAGE: 'recipes:manage',

  // HR
  PAYROLL_MANAGE: 'payroll:manage',

  // Purchase Approval Workflow (per-stage gatekeepers)
  PURCHASE_VIEW: 'purchase:view',
  PURCHASE_CREATE: 'purchase:create',
  PURCHASE_MANAGER_APPROVE: 'purchase:manager_approve',
  PURCHASE_ORDER_DISPATCH: 'purchase:order_dispatch',
  PURCHASE_GRN_APPROVE: 'purchase:grn_approve',
  PURCHASE_ACCOUNTS_VERIFY: 'purchase:accounts_verify',
  PURCHASE_PAYMENT_RELEASE: 'purchase:payment_release',
  PURCHASE_EXPORT: 'purchase:export',
  PURCHASE_PRINT: 'purchase:print',

  // Production Approval Workflow
  PRODUCTION_VIEW: 'production:view',
  PRODUCTION_PLAN_CREATE: 'production:plan_create',
  PRODUCTION_FACTORY_APPROVE: 'production:factory_approve',
  PRODUCTION_EXECUTION: 'production:execution',
  PRODUCTION_QC_VERIFY: 'production:qc_verify',
  PRODUCTION_FINISHED_ENTRY: 'production:finished_entry',
  PRODUCTION_EXPORT: 'production:export',

  // Expense Approval Workflow
  EXPENSE_VIEW: 'expense:view',
  EXPENSE_ENTRY_CREATE: 'expense:entry_create',
  EXPENSE_DEPT_APPROVE: 'expense:dept_approve',
  EXPENSE_ACCOUNTS_APPROVE: 'expense:accounts_approve',
  EXPENSE_PAYMENT_RELEASE: 'expense:payment_release',
  EXPENSE_EXPORT: 'expense:export',
};

export type Permission = typeof Permissions[keyof typeof Permissions];

// Catalog used to seed the Permission table — grouped by module for the
// Permissions management UI, and to derive each action's display label.
export const PERMISSION_CATALOG: { key: string; module: string; action: string; label: string }[] = [
  { key: Permissions.USERS_VIEW, module: 'USERS', action: 'VIEW', label: 'View Users' },
  { key: Permissions.USERS_CREATE, module: 'USERS', action: 'CREATE', label: 'Create Users' },
  { key: Permissions.USERS_EDIT, module: 'USERS', action: 'EDIT', label: 'Edit Users' },
  { key: Permissions.USERS_DELETE, module: 'USERS', action: 'DELETE', label: 'Delete Users' },

  { key: Permissions.ROLES_VIEW, module: 'ROLES', action: 'VIEW', label: 'View Roles' },
  { key: Permissions.ROLES_CREATE, module: 'ROLES', action: 'CREATE', label: 'Create Roles' },
  { key: Permissions.ROLES_EDIT, module: 'ROLES', action: 'EDIT', label: 'Edit Roles' },
  { key: Permissions.ROLES_DELETE, module: 'ROLES', action: 'DELETE', label: 'Delete Roles' },

  { key: Permissions.FRANCHISE_VIEW, module: 'FRANCHISE', action: 'VIEW', label: 'View Franchises' },
  { key: Permissions.FRANCHISE_MANAGE, module: 'FRANCHISE', action: 'MANAGE', label: 'Manage Franchises' },

  { key: Permissions.INVENTORY_VIEW, module: 'INVENTORY', action: 'VIEW', label: 'View Inventory' },
  { key: Permissions.INVENTORY_MANAGE, module: 'INVENTORY', action: 'MANAGE', label: 'Manage Inventory' },

  { key: Permissions.POS_ACCESS, module: 'POS', action: 'MANAGE', label: 'Access POS' },
  { key: Permissions.POS_REFUND, module: 'POS', action: 'APPROVE', label: 'Approve POS Refunds' },

  { key: Permissions.FINANCE_REPORTS, module: 'FINANCE', action: 'VIEW', label: 'View Finance Reports' },
  { key: Permissions.FINANCE_EXPENSES, module: 'FINANCE', action: 'MANAGE', label: 'Manage Expenses' },

  { key: Permissions.PRODUCTION_MANAGE, module: 'PRODUCTION', action: 'MANAGE', label: 'Manage Production' },
  { key: Permissions.RECIPES_MANAGE, module: 'PRODUCTION', action: 'MANAGE', label: 'Manage Recipes' },

  { key: Permissions.PAYROLL_MANAGE, module: 'HR', action: 'MANAGE', label: 'Manage Payroll' },

  { key: Permissions.PURCHASE_VIEW, module: 'PURCHASE', action: 'VIEW', label: 'View Purchase Requests' },
  { key: Permissions.PURCHASE_CREATE, module: 'PURCHASE', action: 'CREATE', label: 'Create Purchase Requests' },
  { key: Permissions.PURCHASE_MANAGER_APPROVE, module: 'PURCHASE', action: 'APPROVE', label: 'Manager Approval' },
  { key: Permissions.PURCHASE_ORDER_DISPATCH, module: 'PURCHASE', action: 'APPROVE', label: 'Dispatch Purchase Order' },
  { key: Permissions.PURCHASE_GRN_APPROVE, module: 'PURCHASE', action: 'APPROVE', label: 'Approve GRN Receipt' },
  { key: Permissions.PURCHASE_ACCOUNTS_VERIFY, module: 'PURCHASE', action: 'APPROVE', label: 'Accounts Review' },
  { key: Permissions.PURCHASE_PAYMENT_RELEASE, module: 'PURCHASE', action: 'APPROVE', label: 'Release Vendor Payment' },
  { key: Permissions.PURCHASE_EXPORT, module: 'PURCHASE', action: 'EXPORT', label: 'Export Purchase Data' },
  { key: Permissions.PURCHASE_PRINT, module: 'PURCHASE', action: 'PRINT', label: 'Print Purchase Documents' },

  { key: Permissions.PRODUCTION_VIEW, module: 'PRODUCTION', action: 'VIEW', label: 'View Production Requests' },
  { key: Permissions.PRODUCTION_PLAN_CREATE, module: 'PRODUCTION', action: 'CREATE', label: 'Create Production Plan' },
  { key: Permissions.PRODUCTION_FACTORY_APPROVE, module: 'PRODUCTION', action: 'APPROVE', label: 'Factory Approval' },
  { key: Permissions.PRODUCTION_EXECUTION, module: 'PRODUCTION', action: 'APPROVE', label: 'Mark Execution Complete' },
  { key: Permissions.PRODUCTION_QC_VERIFY, module: 'PRODUCTION', action: 'APPROVE', label: 'QC Verification' },
  { key: Permissions.PRODUCTION_FINISHED_ENTRY, module: 'PRODUCTION', action: 'APPROVE', label: 'Finished Goods Entry' },
  { key: Permissions.PRODUCTION_EXPORT, module: 'PRODUCTION', action: 'EXPORT', label: 'Export Production Data' },

  { key: Permissions.EXPENSE_VIEW, module: 'EXPENSE', action: 'VIEW', label: 'View Expense Requests' },
  { key: Permissions.EXPENSE_ENTRY_CREATE, module: 'EXPENSE', action: 'CREATE', label: 'Create Expense Entry' },
  { key: Permissions.EXPENSE_DEPT_APPROVE, module: 'EXPENSE', action: 'APPROVE', label: 'Department Approval' },
  { key: Permissions.EXPENSE_ACCOUNTS_APPROVE, module: 'EXPENSE', action: 'APPROVE', label: 'Accounts Approval' },
  { key: Permissions.EXPENSE_PAYMENT_RELEASE, module: 'EXPENSE', action: 'APPROVE', label: 'Release Payment' },
  { key: Permissions.EXPENSE_EXPORT, module: 'EXPENSE', action: 'EXPORT', label: 'Export Expense Data' },
];
