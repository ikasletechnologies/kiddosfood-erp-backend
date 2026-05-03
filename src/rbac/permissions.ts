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
};

export type Permission = typeof Permissions[keyof typeof Permissions];
