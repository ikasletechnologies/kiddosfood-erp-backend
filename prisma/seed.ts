import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';
import { PERMISSION_CATALOG, Permissions } from '../src/rbac/permissions';

const SYSTEM_ROLES: { name: string; description: string; permissions: string[] }[] = [
  {
    name: 'Purchase Manager',
    description: 'Approves purchase requests and dispatches purchase orders.',
    permissions: [
      Permissions.PURCHASE_VIEW,
      Permissions.PURCHASE_MANAGER_APPROVE,
      Permissions.PURCHASE_ORDER_DISPATCH,
      Permissions.PURCHASE_EXPORT,
      Permissions.PURCHASE_PRINT,
    ],
  },
  {
    name: 'Factory Manager',
    description: 'Approves production plans, GRN receipts, and department expense claims.',
    permissions: [
      Permissions.PURCHASE_GRN_APPROVE,
      Permissions.PRODUCTION_VIEW,
      Permissions.PRODUCTION_FACTORY_APPROVE,
      Permissions.PRODUCTION_EXECUTION,
      Permissions.PRODUCTION_EXPORT,
      Permissions.EXPENSE_DEPT_APPROVE,
    ],
  },
  {
    name: 'QC Auditor',
    description: 'Performs batch quality inspections and release verification.',
    permissions: [
      Permissions.PRODUCTION_VIEW,
      Permissions.PRODUCTION_QC_VERIFY,
    ],
  },
  {
    name: 'Accounts Reviewer',
    description: 'Verifies GRN invoices, logs expense approvals, and releases payments.',
    permissions: [
      Permissions.PURCHASE_ACCOUNTS_VERIFY,
      Permissions.PURCHASE_PAYMENT_RELEASE,
      Permissions.EXPENSE_VIEW,
      Permissions.EXPENSE_ACCOUNTS_APPROVE,
      Permissions.EXPENSE_PAYMENT_RELEASE,
      Permissions.FINANCE_REPORTS,
    ],
  },
];

const SAMPLE_WORKFLOW_REQUESTS: {
  displayId: string;
  category: 'PURCHASE' | 'PRODUCTION' | 'EXPENSE';
  title: string;
  amount?: number;
  currentStage: string;
  initiatedBy: string;
  details: Record<string, string>;
  history: { stage: string; userLabel: string; notes: string }[];
}[] = [
  {
    displayId: 'WF-PUR-101',
    category: 'PURCHASE',
    title: 'Raw Sugar - 5 Tons Procurement',
    amount: 180000,
    currentStage: 'MANAGER_APPROVE',
    initiatedBy: 'Nikhil Sharma (Procurement Lead)',
    details: {
      'Target Vendor': 'Madhur Sugar Refineries Ltd',
      'Urgency': 'High (Stock depletion in 8 days)',
      'Linked Recipe': 'ChocoDelight Bars, Milk Chocolate slabs',
      'Warehouse Destination': 'HQ Central Silo 2',
    },
    history: [
      { stage: 'REQUEST', userLabel: 'Nikhil Sharma', notes: 'Raw Sugar reorder level crossed. Requesting 5 metric tons.' },
    ],
  },
  {
    displayId: 'WF-PUR-102',
    category: 'PURCHASE',
    title: 'Organic Cocoa Butter - 500 KG',
    amount: 350000,
    currentStage: 'ACCOUNTS_VERIFY',
    initiatedBy: 'Rajesh Patil (Procurement Specialist)',
    details: {
      'Target Vendor': 'West African Cocoa Exporters',
      'GRN Ref': 'GRN-2026-0492',
      'Warehouse Location': 'Cold Storage Unit A',
      'Invoice Amount Match': 'Verified: ₹3,50,000',
    },
    history: [
      { stage: 'REQUEST', userLabel: 'Rajesh Patil', notes: 'Premium cocoa butter restocking request.' },
      { stage: 'MANAGER_APPROVE', userLabel: 'Ananya Roy (Purchasing Mgr)', notes: 'Price matches contract. Approved purchase order.' },
      { stage: 'ORDER', userLabel: 'Ananya Roy', notes: 'PO-0994 dispatched to vendor.' },
      { stage: 'GRN', userLabel: 'Harish Gupta (WH Manager)', notes: 'Goods arrived. Quality inspection cleared. Stored in cold unit.' },
    ],
  },
  {
    displayId: 'WF-PROD-201',
    category: 'PRODUCTION',
    title: 'ChocoDelight Bar Batch #902',
    currentStage: 'FACTORY_APPROVE',
    initiatedBy: 'Amit Deshmukh (Production Planner)',
    details: {
      'Planned Quantity': '10,000 Bars (Yield target)',
      'Recipe Name': 'ChocoDelight Standard Recipe v2',
      'Target Location': 'Main Packaging Line 3',
      'Required Ingredients': 'Sugar (250KG), Milk Solids (120KG), Cocoa (400KG)',
    },
    history: [
      { stage: 'PLAN', userLabel: 'Amit Deshmukh', notes: 'Created production plan based on sales demand forecasting.' },
    ],
  },
  {
    displayId: 'WF-PROD-202',
    category: 'PRODUCTION',
    title: 'Milk Chocolate Slab Batch #894',
    currentStage: 'QC',
    initiatedBy: 'Amit Deshmukh (Production Planner)',
    details: {
      'Output Units': '4,200 Slabs',
      'Execution Date': '2026-06-24',
      'Actual Yield %': '98.5%',
      'Wastage Logs': 'Scrap chocolate: 1.5% re-processed',
    },
    history: [
      { stage: 'PLAN', userLabel: 'Amit Deshmukh', notes: 'Weekly slab plan.' },
      { stage: 'FACTORY_APPROVE', userLabel: 'Vipul Shah (Factory Mgr)', notes: 'All ingredients reserved. Line capacity confirmed.' },
      { stage: 'EXECUTION', userLabel: 'Rohan Patil (Floor Supervisor)', notes: 'Batch manufacturing finished. Packed into boxes. Sent to QC bay.' },
    ],
  },
  {
    displayId: 'WF-EXP-301',
    category: 'EXPENSE',
    title: 'Boiler Maintenance & Spares Replacement',
    amount: 82000,
    currentStage: 'DEPT_APPROVE',
    initiatedBy: 'Vikram Sen (Maintenance Engineer)',
    details: {
      'Expense Department': 'Engineering & Utilities',
      'GL Category': 'Repairs & Maintenance',
      'Description': 'Replacement of steam valve actuators & boiler safety valve gasket calibration.',
    },
    history: [
      { stage: 'ENTRY', userLabel: 'Vikram Sen', notes: 'Safety audit recommended actuator swap immediately.' },
    ],
  },
  {
    displayId: 'WF-EXP-302',
    category: 'EXPENSE',
    title: 'July Production Floor Electricity Bill',
    amount: 145000,
    currentStage: 'ACCOUNTS_APPROVE',
    initiatedBy: 'Priya Nair (Admin Exec)',
    details: {
      'Expense Department': 'Operations',
      'GL Category': 'Power & Fuel',
      'Billing Cycle': 'May 15 - June 15',
    },
    history: [
      { stage: 'ENTRY', userLabel: 'Priya Nair', notes: 'State electricity utility bill received.' },
      { stage: 'DEPT_APPROVE', userLabel: 'Vipul Shah (Factory Mgr)', notes: 'Bill verified against plant meter logs.' },
    ],
  },
];

async function main() {
  console.log('🌱 Starting Clean Production Seeding...');

  // Default Super Admin User
  const password = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);

  await prisma.user.upsert({
    where: { email: 'admin@kiddosfood.com' },
    update: {
      passwordHash: password,
      role: 'SUPER_ADMIN',
      franchiseId: null
    },
    create: {
      email: 'admin@kiddosfood.com',
      passwordHash: password,
      fullName: 'System Super Admin',
      role: 'SUPER_ADMIN',
      franchiseId: null,
      is_active: true,
    },
  });

  // Permission catalog
  for (const p of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { module: p.module, action: p.action, label: p.label },
      create: p,
    });
  }
  console.log(`✅ Seeded ${PERMISSION_CATALOG.length} permissions.`);

  // System roles (Purchase Manager, Factory Manager, QC Auditor, Accounts Reviewer)
  for (const r of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.description, isSystem: true },
      create: { name: r.name, description: r.description, isSystem: true },
    });
    const permissionRows = await prisma.permission.findMany({ where: { key: { in: r.permissions } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissionRows.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
  console.log(`✅ Seeded ${SYSTEM_ROLES.length} system roles.`);

  // Sample workflow-approval requests (mirrors the previous frontend-only mock data)
  for (const wf of SAMPLE_WORKFLOW_REQUESTS) {
    const existing = await prisma.workflowRequest.findUnique({ where: { displayId: wf.displayId } });
    if (existing) continue;
    await prisma.workflowRequest.create({
      data: {
        displayId: wf.displayId,
        category: wf.category,
        title: wf.title,
        amount: wf.amount,
        currentStage: wf.currentStage,
        initiatedBy: wf.initiatedBy,
        details: wf.details,
        history: {
          create: wf.history.map((h) => ({ stage: h.stage, userLabel: h.userLabel, notes: h.notes })),
        },
      },
    });
  }
  console.log(`✅ Seeded ${SAMPLE_WORKFLOW_REQUESTS.length} sample workflow-approval requests.`);

  console.log('✅ Seeding complete: Super Admin created. All other entities (Franchises, Warehouses, Accounts) can be created manually.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
