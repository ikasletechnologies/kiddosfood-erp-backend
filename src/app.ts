import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import { InventoryController } from './modules/inventory/inventory.controller';
import { POSController } from './modules/pos/pos.controller';
import { ProductController } from './modules/product/product.controller';
import { AuthController } from './modules/auth/auth.controller';
import { authenticate, authorizeRole } from './middleware/rbac.middleware';
import { validate } from './middleware/validate.middleware';
import { loginSchema, registerSchema } from './modules/auth/auth.validation';
import { errorHandler } from './middleware/error.middleware';
import { DeliveryController } from './modules/delivery/delivery.controller';
import { FinanceController } from './modules/finance/finance.controller';
import { AnalyticsController } from './modules/analytics/analytics.controller';
import { ProductionController } from './modules/production/production.controller';
import { CartonController } from './modules/production/carton.controller';
import { RecallController } from './modules/production/recall.controller';
import { ProcurementController } from './modules/procurement/procurement.controller';
import { FranchiseController } from './modules/franchise/franchise.controller';
import { FranchiseService } from './modules/franchise/franchise.service';
import { NavController } from './modules/users/nav.controller';
import { SettingsController } from './modules/settings/settings.controller';
import { AuditController } from './modules/audit/audit.controller';
import { OrderController } from './modules/pos/order.controller';
import { RecipeController } from './modules/recipes/recipe.controller';
import { LogisticsController } from './modules/logistics/logistics.controller';
import { KDSController } from './modules/kds/kds.controller';
import { CustomerController } from './modules/customers/customer.controller';
import { LoyaltyController } from './modules/loyalty/loyalty.controller';
import { WasteController } from './modules/waste/waste.controller';
import { CRMController } from './modules/crm/crm.controller';
import { EmployeeController } from './modules/employee/employee.controller';
import { PayrollController } from './modules/payroll/payroll.controller';
import { SalesController } from './modules/sales/sales.controller';
import { PurchaseController } from './modules/purchase/purchase.controller';
import { RawMaterialsController } from './modules/inventory/raw-materials.controller';
import { UserController } from './modules/users/user.controller';
import { GRNController } from './modules/grn/grn.controller';
import { VendorInvoiceController } from './modules/vendor-invoices/vendor-invoices.controller';
import { FranchiseOrderController } from './modules/franchise/franchise-order.controller';
import { GSTInvoiceService } from './modules/finance/gst-invoice.service';
import { AccountController } from './modules/finance/account.controller';
import { ChequeController } from './modules/finance/cheque.controller';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { PurchaseRequestController } from './modules/purchase-requests/purchase-request.controller';
import DealerRoutes from './modules/dealers';
import BusinessPartnerRoutes from './modules/business-partners';
import { DraftsController } from './modules/drafts/drafts.controller';
import { WorkflowApprovalsController } from './modules/workflow-approvals/workflow-approvals.controller';
import WarehouseRoutes from './modules/warehouse/warehouse.routes';
import SetupRoutes from './modules/setup/setup.routes';
import bcrypt from 'bcryptjs';
import prisma from './lib/prisma';

console.log('📦 BACKEND APP INITIALIZING...');

const app: Express = express();

app.use(cors());
app.use(express.json());

// Advanced API Flow Logger
const REDACTED_KEYS = ['password', 'accessToken', 'refreshToken', 'token'];
function redact(obj: any) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy: any = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(copy)) {
    if (REDACTED_KEYS.includes(key)) copy[key] = '********';
  }
  return copy;
}
// Response bodies get logged truncated — full payloads (e.g. big list
// endpoints) would flood the console and make the log unreadable.
const MAX_LOGGED_BODY_CHARS = 2000;
function formatBody(body: any) {
  let str: string;
  try {
    str = JSON.stringify(redact(body));
  } catch {
    return '[unserializable]';
  }
  if (!str) return str;
  return str.length > MAX_LOGGED_BODY_CHARS
    ? `${str.slice(0, MAX_LOGGED_BODY_CHARS)}… (${str.length} chars total)`
    : str;
}

app.use((req, res, next) => {
  const start = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  // Format based on method
  const methodColors: any = {
    GET: '🟢',
    POST: '🔵',
    PUT: '🟡',
    DELETE: '🔴'
  };
  const icon = methodColors[req.method] || '⚪';

  console.log(`\n🚀 [${icon} ${req.method}] ${req.url} (ID: ${requestId})`);
  if (req.query && Object.keys(req.query).length > 0) console.log(`   🔸 Query:`, req.query);
  if (req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
    console.log(`   🔸 Body:`, redact(req.body));
  }

  // Capture whatever gets sent out, whichever of these the route handler calls.
  let responseBody: any;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = (body: any) => { responseBody = body; return originalJson(body); };
  res.send = (body: any) => { if (responseBody === undefined) responseBody = body; return originalSend(body); };

  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusIcon = res.statusCode >= 400 ? '❌' : '✅';
    console.log(`${statusIcon} [RESPONSE] ${res.statusCode} - ${duration}ms (ID: ${requestId})`);
    if (responseBody !== undefined) console.log(`   🔹 Response:`, formatBody(responseBody));
  });

  next();
});

// Root Route
app.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'online',
    name: 'Kiddos Food ERP Backend API',
    message: 'Backend server is running successfully.',
    healthCheck: '/health',
    frontendUrl: 'http://localhost:3000'
  });
});

// Health check. Previously also carried a `?seed=true` branch that
// unauthenticated-ly auto-created an HQ franchise and a "Central Warehouse"
// (unlinked to any franchise) — exactly the silent-auto-creation pattern
// the setup wizard exists to eliminate, reachable by anyone who hit this
// URL, including uptime/health-check pingers. HQ and its warehouse are now
// only ever created through the explicit setup wizard (see src/modules/setup).
app.get('/health', async (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Food ERP API is running' });
});

// Warehouse Management
app.get('/api/warehouses', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.getWarehouses);
app.post('/api/warehouses', (req, res, next) => { console.log('🎯 WAREHOUSE POST ROUTE HIT'); next(); }, authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.createWarehouse);
app.get('/api/warehouses/:id/stock', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.getWarehouseStock);
app.patch('/api/warehouses/:id', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.updateWarehouse);
app.delete('/api/warehouses/:id', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.deleteWarehouse);

// Auth Routes (Production Flow)
app.post('/api/auth/register', validate(registerSchema), AuthController.register);
app.post('/api/auth/login', validate(loginSchema), AuthController.login);
app.post('/api/auth/refresh', AuthController.refresh);
app.post('/api/auth/logout', AuthController.logout);
app.get('/api/me', authenticate, UserController.getMe);
app.get('/api/me/navigation', authenticate, NavController.getNavigation);
app.patch('/api/me/password', authenticate, UserController.changeOwnPassword);
app.patch('/api/me/update', authenticate, UserController.updateMe);
// Profile update route registered correctly.

// Dashboard Metrics

// API Routes (Protected)
// Admin & Manager: User Management
app.get('/api/users', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.getAll);
app.get('/api/users/:id', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.getOne);
app.post('/api/users', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.create);
app.patch('/api/users/:id', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.update);
app.delete('/api/users/:id', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.delete);

// Approval Workflows (Purchase / Production / Expense gatekeeper flows) —
// every stage is handled by a Franchise Admin (scoped to their own
// franchise) or a Super Admin; there's no separate department-role gate.
app.get('/api/workflow-approvals', authenticate, WorkflowApprovalsController.getAll);
app.get('/api/workflow-approvals/:id', authenticate, WorkflowApprovalsController.getOne);
app.post('/api/workflow-approvals', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), WorkflowApprovalsController.create);
app.post('/api/workflow-approvals/:id/approve', authenticate, WorkflowApprovalsController.approve);

// Other Business Modules
// Inventory & Stock Management
app.get('/api/inventory', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.getInventory);
app.get('/api/inventory/raw-materials/summary', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.getRawMaterialStockSummary);
app.get('/api/inventory/raw-materials/consumption', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.getRawMaterialConsumption);
app.get('/api/inventory/raw-materials/ledger', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.getRawMaterialLedger);
app.get('/api/inventory/items/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.getItem);
app.post('/api/inventory/items', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.createItem);
app.post('/api/inventory/stock-in', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.stockIn);
app.post('/api/inventory/stock-out', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.stockOut);
app.post('/api/inventory/adjustment', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.adjustment);
app.get('/api/inventory/reconciliation', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.getReconciliationSheet);
app.post('/api/inventory/reconciliation', authenticate, authorizeRole(['SUPER_ADMIN']), InventoryController.submitReconciliation);
app.get('/api/inventory/movements', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), InventoryController.getMovements);

// Raw Materials (Phase 3 requested endpoints)
app.get('/api/raw-materials', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.getAll);
app.get('/api/raw-materials/:id', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.getById);
app.post('/api/raw-materials', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.create);
app.patch('/api/raw-materials/:id', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.update);
app.delete('/api/raw-materials/:id', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.delete);
app.patch('/api/raw-materials/:id/deactivate', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.deactivate);
app.patch('/api/raw-materials/:id/activate', authenticate, authorizeRole(['SUPER_ADMIN']), RawMaterialsController.activate);

// POS & Orders - Multi-Step Strict POS Flow
app.post('/api/orders', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.createOrder);
app.post('/api/orders/:id/items', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.addItems);
app.patch('/api/orders/:id/status', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.updateStatus);
app.post('/api/orders/:id/pay', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.addPayment);
app.post('/api/orders/checkout', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.checkout); // Legacy compatibility fallback

// Queries
app.get('/api/orders', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.getAll);
app.get('/api/orders/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.getOne);
app.get('/api/invoices/:orderId', authenticate, authorizeRole(['FRANCHISE_ADMIN']), OrderController.getInvoice);

// Products & Recipes (HQ Controlled)
app.get('/api/products', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductController.getAll);
app.post('/api/products', authenticate, authorizeRole(['SUPER_ADMIN']), ProductController.create);
app.post('/api/products/bulk-import', authenticate, authorizeRole(['SUPER_ADMIN']), ProductController.bulkImport);
app.post('/api/products/link', authenticate, authorizeRole(['SUPER_ADMIN']), ProductController.linkExistingProduct);
app.get('/api/products/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductController.getOne);
app.patch('/api/products/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProductController.update);
app.delete('/api/products/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProductController.delete);

app.get('/api/recipes', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.getAll);
app.post('/api/recipes', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.upsert);
app.get('/api/recipe-categories', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.getCategories);
app.post('/api/recipe-categories', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.createCategory);
app.get('/api/recipes/:id', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.getOne);
app.delete('/api/recipes/:id', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.delete);
app.get('/api/recipes/product/:productId', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.getByProduct);
app.post('/api/recipes/:id/cost', authenticate, authorizeRole(['SUPER_ADMIN']), RecipeController.calculateCost);

// Production Workflow
app.get('/api/production/history', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductionController.getHistory);
app.get('/api/production/cartons', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), CartonController.getAll);
app.post('/api/production/cartons', authenticate, authorizeRole(['SUPER_ADMIN']), CartonController.create);
app.post('/api/production/batch', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.startBatch);
app.post('/api/production/:id/stop', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.stopBatch);
app.patch('/api/production/:id/stage', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.advanceStage);
app.get('/api/production/:id/stage-history', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductionController.getStageHistory);
app.post('/api/production/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.approveBatch);
app.get('/api/production/batches', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), async (req, res) => {
  try {
    const { ProductionService } = await import('./modules/production/production.service');
    const user = (req as any).user;
    const targetFranchiseId = user.role === 'SUPER_ADMIN'
      ? (req.query.franchiseId as string || undefined)
      : user.franchiseId;
    const batches = await ProductionService.getProductBatches(
      req.query.productId as string | undefined,
      targetFranchiseId
    );
    res.json(batches);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
app.get('/api/production/batches-all', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductionController.getAllBatches);
app.get('/api/production/batches-pending-qc', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductionController.getPendingQC);
app.post('/api/production/batches/:id/qc', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.inspectBatch);
app.post('/api/production/batches/:id/package', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.startPackaging);
app.post('/api/production/packagings/:id/confirm', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.confirmPackaging);
app.put('/api/production/packagings/:id/verify', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.savePackagingVerification);
app.get('/api/production/packagings', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductionController.getPackagings);
// Batch Recall — eligibility/state are shared source of truth for both the
// registry list and the inspector panel; mutation endpoints are transactional
// and idempotent (see recall.service.ts).
app.get('/api/production/batches/:id/recall/eligibility', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.getEligibility);
app.get('/api/production/batches/:id/recall', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.getState);
app.post('/api/production/batches/:id/recall/initiate', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.initiate);
app.post('/api/production/batches/:id/recall/locate-distribution', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.locateDistribution);
app.post('/api/production/batches/:id/recall/block-sales', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.blockSales);
app.post('/api/production/batches/:id/recall/generate-report', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.generateReport);
app.post('/api/production/batches/:id/recall/collect-return', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.collectReturn);
app.post('/api/production/batches/:id/recall/complete', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.complete);
app.post('/api/production/batches/:id/recall/cancel', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), RecallController.cancel);
app.get('/api/production/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), ProductionController.getOne);
app.patch('/api/production/:id/status', authenticate, authorizeRole(['SUPER_ADMIN']), ProductionController.updateStatus);

// Logistics (Stock Requests & Transfers)
app.get('/api/logistics/requests', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.getRequests);
app.post('/api/logistics/requests', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.createRequest);
app.patch('/api/logistics/requests/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.approveRequest);

app.get('/api/logistics/transfers', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.getTransfers);
app.get('/api/logistics/transfers/in-transit', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.getInTransit);
app.post('/api/logistics/transfers', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.initiateTransfer);
app.patch('/api/logistics/transfers/:id/dispatch', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.dispatchTransfer);
app.patch('/api/logistics/transfers/:id/complete', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), LogisticsController.completeTransfer);

// Delivery & Logistics
app.get('/api/delivery/active', authenticate, authorizeRole(['FRANCHISE_ADMIN']), DeliveryController.getActive);
app.post('/api/delivery/update', authenticate, authorizeRole(['FRANCHISE_ADMIN']), DeliveryController.update);
app.post('/api/delivery/verify', authenticate, authorizeRole(['FRANCHISE_ADMIN']), DeliveryController.verify);



// Financials & Reports
app.get('/api/finance/pl', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getPL);
app.post('/api/finance/expense', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.addExpense);
app.get('/api/finance/invoices', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getInvoices);
app.post('/api/finance/invoices', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.createInvoice);
app.get('/api/finance/cash-flow', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getCashFlow);

// Drafts
app.get('/api/drafts', authenticate, DraftsController.getDrafts);
app.post('/api/drafts', authenticate, DraftsController.saveDraft);
app.delete('/api/drafts/:id', authenticate, DraftsController.deleteDraft);

// Accounting (New Frontend mapping)
app.get('/api/accounting/expenses', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getExpenses);
app.get('/api/accounting/expenses/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getExpenseDetails);
app.post('/api/accounting/expenses', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.addExpense);
app.post('/api/accounting/expenses/:id/payment', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.recordExpensePayment);
app.delete('/api/accounting/expenses/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.cancelExpense);
app.get('/api/accounting/payments', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getPayments);
app.post('/api/accounting/payments', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.recordPayment);
app.post('/api/accounting/payments/:id/cancel', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.cancelPayment);
app.post('/api/accounting/transfers', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.transferFunds);
app.get('/api/accounting/ledger-summary', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getLedgerSummary);

// Accounts management
app.get('/api/accounts', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AccountController.getAll);
app.get('/api/accounts/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AccountController.getById);
app.post('/api/accounts', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AccountController.create);
app.delete('/api/accounts/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AccountController.delete);

// Dashboard
app.get('/api/dashboard/summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), DashboardController.getSummary);

// Cheque Registry
app.get('/api/cheques', authenticate, authorizeRole(['FRANCHISE_ADMIN']), ChequeController.findAll);
app.get('/api/cheques/stats', authenticate, authorizeRole(['FRANCHISE_ADMIN']), ChequeController.getStats);
app.post('/api/cheques', authenticate, authorizeRole(['FRANCHISE_ADMIN']), ChequeController.create);
app.patch('/api/cheques/:id/status', authenticate, authorizeRole(['FRANCHISE_ADMIN']), ChequeController.updateStatus);

// Phase 5 & 7 Reports (Consolidated)
app.get('/api/reports/sales', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSalesReport);
app.get('/api/reports/purchases', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getPurchasesReport);
app.get('/api/reports/daybook', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getDayBookReport);
app.get('/api/reports/transactions', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getTransactionsReport);
app.get('/api/reports/expenses', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getExpensesReport);
app.get('/api/reports/profit', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getPL);
app.get('/api/reports/invoices', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getInvoices);
app.get('/api/reports/inventory-value', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getInventoryValue);
app.get('/api/reports/trial-balance', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getTrialBalance);
app.get('/api/reports/balance-sheet', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getBalanceSheet);
app.get('/api/reports/account-summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getAccountTransactionSummary);
app.get('/api/reports/bill-wise-profit', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getBillWiseProfit);
app.get('/api/reports/cash-flow', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getCashFlow);
app.get('/api/reports/party-statement', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getPartyStatement);
app.get('/api/reports/party-profit-loss', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getPartyProfitLoss);
app.get('/api/reports/party-by-item', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getPartyReportByItem);
app.get('/api/reports/sale-purchase-by-party', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSalePurchaseByParty);
app.get('/api/reports/sale-purchase-by-party-group', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSalePurchaseByPartyGroup);
app.get('/api/reports/all-parties', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getAllPartiesReport);
app.get('/api/reports/party-invoices', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getPartyInvoices);

// Root Level Category Reports
app.get('/api/reports/production', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getProductionReport);
app.get('/api/reports/inventory', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getInventoryValue);
app.get('/api/reports/inventory-ledger', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getInventoryLedgerReport);
app.get('/api/reports/franchise', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getFranchiseReport);

// Item/Stock Reports
app.get('/api/reports/item-by-party', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getItemByPartyReport);
app.get('/api/reports/item-profit-loss', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getItemProfitLossReport);
app.get('/api/reports/item-category-profit-loss', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getItemCategoryProfitLossReport);
app.get('/api/reports/low-stock-summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getLowStockSummaryReport);
app.get('/api/reports/stock-summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getStockSummaryReport);
app.get('/api/reports/item-discount', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getItemDiscountReport);
app.get('/api/reports/sale-purchase-by-category', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSalePurchaseByCategoryReport);
app.get('/api/reports/sale-purchase-by-item', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSalePurchaseByItemReport);
app.get('/api/reports/stock-by-category', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getStockByCategoryReport);
app.get('/api/reports/stock-summary-by-item', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getStockSummaryByItemReport);
app.get('/api/reports/stock-detail', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getStockDetailReport);
app.get('/api/reports/item-detail', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getItemDetailReport);
app.get('/api/reports/bank-statement', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getBankStatement);
app.get('/api/reports/discount-report', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getDiscountReport);

// Expense Reports
app.get('/api/reports/expense-category', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getExpenseCategoryReport);
app.get('/api/reports/expense-item', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getExpenseItemReport);

// Sale Order Reports
app.get('/api/reports/sale-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSaleOrdersReport);
app.get('/api/reports/sale-order-items', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSaleOrderItemsReport);

// Loans
app.get('/api/reports/loans', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getLoans);
app.post('/api/reports/loans', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.addLoan);
app.get('/api/reports/loan-statement', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getLoanStatement);
app.post('/api/reports/loans/:id/transaction', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.addLoanTransaction);

// Tax Reports
app.get('/api/reports/gst', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getGstReport);
app.get('/api/reports/gstr1', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getGSTR1Report);
app.get('/api/reports/gstr2', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getGSTR2Report);
app.get('/api/reports/gstr3b', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getGSTR3BReport);
app.get('/api/reports/gstr9', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getGSTR9Report);
app.get('/api/reports/hsn-summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getHsnSummaryReport);
app.get('/api/reports/sac', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getSacReport);
app.get('/api/reports/gst-rate', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getGstRateReport);
app.get('/api/reports/form-27eq', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getForm27eq);
app.get('/api/reports/tcs-receivable', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getTcsReceivable);
app.get('/api/reports/tds-payable', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getTdsPayable);
app.get('/api/reports/tds-receivable', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getTdsReceivable);

// Phase 7 Analytics
app.get('/api/analytics/product-performance', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AnalyticsController.getProductPerformance);
app.get('/api/analytics/payment-distribution', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AnalyticsController.getPaymentDistribution);
app.get('/api/analytics/wastage-summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AnalyticsController.getWastageSummary);
app.get('/api/analytics/daily-sales', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), AnalyticsController.getDailySalesSummary);

// Procurement & Vendors
app.get('/api/vendors', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getAllVendors);
app.post('/api/vendors', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.createVendor);
app.get('/api/vendors/summary', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getVendorSummary);
app.get('/api/vendors/filter', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.filterVendors);
app.get('/api/vendors/next-payment-number', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getNextPaymentNumber);
app.get('/api/vendors/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getVendorById);
app.patch('/api/vendors/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.updateVendor);
app.delete('/api/vendors/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.deleteVendor);
app.post('/api/vendors/link-material', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.linkMaterial);
app.get('/api/vendors/:id/ledger', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getVendorLedger);
app.get('/api/vendors/:id/aging', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getVendorAging);
app.post('/api/vendors/:id/payment', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.recordPayment);
app.post('/api/vendors/:id/adjustment', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.recordAdjustment);
app.get('/api/suppliers', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getAllVendors); // Alias
app.post('/api/suppliers', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.createVendor); // Alias

app.get('/api/procurement/orders', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getPOs);
app.get('/api/procurement/orders/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getOne);
app.post('/api/procurement/po', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.createPO);

// Purchase Orders (HQ Only)
app.get('/api/purchase-orders', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getPOs);
app.post('/api/purchase-orders', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.createPO);
app.get('/api/purchase-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.getOne);
app.patch('/api/purchase-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.updatePO);
app.patch('/api/purchase-orders/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.approvePO);
app.patch('/api/purchase-orders/:id/advance', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.recordAdvance);
app.patch('/api/purchase-orders/:id/cancel', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.cancelPO);
app.delete('/api/purchase-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.deletePO);
// Manual reconciliation: Pay this PO using existing vendor advance balance
app.post('/api/purchase-orders/:id/apply-advance', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.applyAdvance);
// Legacy receive endpoint (kept for backward compat; prefer GRN flow)
app.post('/api/purchase-orders/:id/receive', authenticate, authorizeRole(['SUPER_ADMIN']), ProcurementController.receiveGoods);

// GRN (Goods Receipt Notes) - Shared flow
app.get('/api/grn', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), GRNController.getAll);
// Must be registered before /api/grn/:id, or Express would route this to
// getById with id="generate-lot-number" instead.
app.get('/api/grn/generate-lot-number', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), GRNController.generateLotNumber);
app.get('/api/grn/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), GRNController.getById);
app.post('/api/grn/from-po/:poId', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), GRNController.createFromPO);
app.patch('/api/grn/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN']), GRNController.approve);
app.patch('/api/grn/:id/cancel', authenticate, authorizeRole(['SUPER_ADMIN']), GRNController.cancel);

// QC Inspection (Enterprise Workflow)
app.get('/api/qc/pending', authenticate, authorizeRole(['SUPER_ADMIN']), GRNController.getPendingInspections);
app.post('/api/qc/inspect', authenticate, authorizeRole(['SUPER_ADMIN']), GRNController.recordInspection);

// Vendor Invoices (3-way matching)
app.get('/api/vendor-invoices', authenticate, authorizeRole(['SUPER_ADMIN']), VendorInvoiceController.getAll);
app.post('/api/vendor-invoices', authenticate, authorizeRole(['SUPER_ADMIN']), VendorInvoiceController.create);
app.post('/api/vendor-invoices/:id/match', authenticate, authorizeRole(['SUPER_ADMIN']), VendorInvoiceController.match);
app.post('/api/vendor-invoices/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN']), VendorInvoiceController.approve);
app.patch('/api/vendor-invoices/:id/status', authenticate, authorizeRole(['SUPER_ADMIN']), VendorInvoiceController.updateStatus);

// Franchise Management & Logistics
app.get('/api/franchise', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.getAll);
app.post('/api/franchise', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.create);
app.get('/api/franchise/requests', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.getRequests);
app.post('/api/franchise/requests', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.createRequest);
app.post('/api/franchise/fulfill', authenticate, authorizeRole(['SUPER_ADMIN']), FranchiseController.fulfillRequest);
app.get('/api/franchise/transfers', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.getAllTransfers);
app.patch('/api/franchise/transfers/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.updateTransferStatus);
app.get('/api/franchise/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.getOne);
app.post('/api/franchise/:id/verify-password', authenticate, authorizeRole(['SUPER_ADMIN']), FranchiseController.verifyDashboardPassword);
app.patch('/api/franchise/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.update);
app.delete('/api/franchise/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.deleteFranchise);

// Franchise Product Requests (franchise → home house)
app.get('/api/franchise/product-requests', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.getProductRequests);
app.post('/api/franchise/product-requests', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FranchiseController.createProductRequest);
app.patch('/api/franchise/product-requests/:id', authenticate, authorizeRole(['SUPER_ADMIN']), FranchiseController.updateProductRequest);
app.delete('/api/franchise/product-requests/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseController.deleteProductRequest);

// User Governance Extensions
app.get('/api/franchise/:id/users', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), UserController.getByFranchise);
app.patch('/api/users/:id/reset-password', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), UserController.resetPassword);

// Governance & Settings
app.get('/api/settings', authenticate, authorizeRole(['SUPER_ADMIN']), SettingsController.getAll);
app.post('/api/settings', authenticate, authorizeRole(['SUPER_ADMIN']), SettingsController.setSetting);
app.get('/api/settings/company', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SettingsController.getCompanyProfile);
app.patch('/api/settings/company', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SettingsController.updateCompanyProfile);
app.get('/api/audit/logs', authenticate, authorizeRole(['SUPER_ADMIN']), AuditController.getLogs);

// POS (frontend-facing aliases with recipeId→productId resolution + auto loyalty)
app.post('/api/pos/checkout', authenticate, authorizeRole(['FRANCHISE_ADMIN']), POSController.checkout);
app.get('/api/pos/orders', authenticate, authorizeRole(['FRANCHISE_ADMIN']), POSController.getOrders);
app.get('/api/pos/settlement/today', authenticate, authorizeRole(['FRANCHISE_ADMIN']), POSController.getTodaySettlement);
app.get('/api/pos/settlement/latest', authenticate, authorizeRole(['FRANCHISE_ADMIN']), POSController.getLatestSettlement);
app.get('/api/pos/settlement/summary', authenticate, authorizeRole(['FRANCHISE_ADMIN']), POSController.getDailySummary);
app.post('/api/pos/settlement/close', authenticate, authorizeRole(['FRANCHISE_ADMIN']), POSController.closeDay);

// KDS — Kitchen Display System
app.get('/api/kds/orders', authenticate, authorizeRole(['FRANCHISE_ADMIN']), KDSController.getOrders);
app.patch('/api/kds/orders/:id/status', authenticate, authorizeRole(['FRANCHISE_ADMIN']), KDSController.updateStatus);


// Customers
app.get('/api/customers', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.getAll);
app.post('/api/customers', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.create);
app.get('/api/customers/ledger-summary', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.getLedgerSummary);
app.get('/api/customers/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.getOne);
app.patch('/api/customers/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.update);
app.get('/api/customers/:id/history', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.getHistory);
app.delete('/api/customers/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CustomerController.delete);

// Dealers & Business Partners
app.use('/api/dealers', DealerRoutes);
app.use('/api/business-partners', BusinessPartnerRoutes);

// Loyalty & Rewards
app.get('/api/loyalty/:customerId', authenticate, authorizeRole(['FRANCHISE_ADMIN']), LoyaltyController.getLoyalty);
app.post('/api/loyalty/add-points', authenticate, authorizeRole(['FRANCHISE_ADMIN']), LoyaltyController.addPoints);
app.post('/api/loyalty/redeem', authenticate, authorizeRole(['FRANCHISE_ADMIN']), LoyaltyController.redeem);

// Waste & Loss
app.get('/api/waste', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), WasteController.getAll);
app.get('/api/waste/summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), WasteController.getSummary);
app.get('/api/waste/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), WasteController.getOne);
app.post('/api/waste', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), WasteController.create);

// Stock Alerts
app.get('/api/inventory/alerts', authenticate, authorizeRole(['FRANCHISE_ADMIN']), InventoryController.getAlerts);

// Warehouse
app.use('/api/warehouse', WarehouseRoutes);

// System Setup — first-run HQ/warehouse setup status
app.use('/api/setup', SetupRoutes);

// CRM — Pipelines
app.get('/api/crm/pipelines', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getPipelines);
app.post('/api/crm/pipelines', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.createPipeline);
app.patch('/api/crm/pipelines/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.updatePipeline);
app.delete('/api/crm/pipelines/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.deletePipeline);

// CRM — Leads
app.get('/api/crm/leads', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getLeads);
app.post('/api/crm/leads', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.createLead);
app.get('/api/crm/leads/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getLead);
app.patch('/api/crm/leads/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.updateLead);
app.delete('/api/crm/leads/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.deleteLead);

// CRM — Forms
app.get('/api/crm/forms', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getForms);
app.post('/api/crm/forms', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.createForm);
app.patch('/api/crm/forms/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.updateForm);
app.delete('/api/crm/forms/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.deleteForm);

// CRM — Reports
app.get('/api/crm/reports/lead-source', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getLeadSourceReport);
app.get('/api/crm/reports/team-sales', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getTeamSalesReport);
app.get('/api/crm/reports/client-performance', authenticate, authorizeRole(['FRANCHISE_ADMIN']), CRMController.getClientPerformanceReport);


// ─── Employee Management ──────────────────────────────────────────────────────
app.get('/api/employees', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getAll);
app.post('/api/employees', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.create);
app.get('/api/employees/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getOne);
app.patch('/api/employees/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.update);

app.get('/api/employees/:id/shifts', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getEmployeeShifts);
app.post('/api/employees/:id/clock-in', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.clockIn);
app.post('/api/employees/:id/clock-out', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.clockOut);
app.get('/api/attendance', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getAttendance);

app.get('/api/leave-types', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getLeaveTypes);
app.post('/api/leave-types', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.createLeaveType);
app.patch('/api/leave-types/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.updateLeaveType);

app.get('/api/leaves', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getLeaves);
app.post('/api/leaves', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.applyLeave);
app.patch('/api/leaves/:id/approve', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.approveLeave);
app.get('/api/employees/:id/leave-balances', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getLeaveBalances);

app.get('/api/shifts', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.getShifts);
app.post('/api/shifts', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.createShift);
app.post('/api/shifts/assign', authenticate, authorizeRole(['FRANCHISE_ADMIN']), EmployeeController.assignShift);

// ─── Payroll ──────────────────────────────────────────────────────────────────
app.get('/api/payroll/components', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.getComponents);
app.post('/api/payroll/components', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.createComponent);
app.patch('/api/payroll/components/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.updateComponent);

app.get('/api/payroll/structures', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.getStructures);
app.post('/api/payroll/structures', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.createStructure);
app.get('/api/payroll/structures/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.getStructure);
app.patch('/api/payroll/structures/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.updateStructure);

app.get('/api/payroll/runs', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.getPayrolls);
app.post('/api/payroll/runs', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.createPayroll);
app.post('/api/payroll/runs/:id/process', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.processPayroll);

app.get('/api/payroll/payslips', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.getPayslips);
app.post('/api/payroll/payslips', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.createManualPayslip);
app.get('/api/payroll/payslips/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.getPayslip);
app.patch('/api/payroll/payslips/:id/mark-paid', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PayrollController.markPaid);

// ─── Sales Module ─────────────────────────────────────────────────────────────
app.get('/api/sales/quotations', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getQuotations);
app.post('/api/sales/quotations', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.createQuotation);
app.get('/api/sales/quotations/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getQuotation);
app.patch('/api/sales/quotations/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateQuotation);
app.put('/api/sales/quotations/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateQuotation);
app.post('/api/sales/quotations/:id/convert', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertQuotation);
app.post('/api/sales/quotations/:id/convert-to-sale', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertQuotationToSale);
app.post('/api/sales/quotations/:id/convert-to-sales-order', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertQuotationToSalesOrder);
app.post('/api/estimates/:id/convert-to-sale', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertQuotationToSale);
app.post('/api/estimates/:id/convert-to-sales-order', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertQuotationToSalesOrder);

app.get('/api/sales/orders', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getSalesOrders);
app.post('/api/sales/orders', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.createSalesOrder);
app.get('/api/sales/orders/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getSalesOrder);
app.patch('/api/sales/orders/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateSalesOrder);
app.put('/api/sales/orders/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateSalesOrder);
app.post('/api/sales/orders/:id/convert', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertSalesOrder);
app.post('/api/sales/orders/:id/convert-to-sale', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertSalesOrderToSale);

app.get('/api/sales/proforma-invoices', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getProformaInvoices);
app.get('/api/sales/proforma-invoices/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getProformaInvoice);
app.post('/api/sales/proforma-invoices', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.createProformaInvoice);
app.put('/api/sales/proforma-invoices/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateProformaInvoice);
app.patch('/api/sales/proforma-invoices/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateProformaInvoice);
app.put('/api/sales/proforma-invoices/:id/status', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateProformaStatus);
app.post('/api/sales/proforma-invoices/:id/convert', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.convertProformaInvoice);

app.get('/api/sales/invoices', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getInvoices);
app.get('/api/sales/invoices/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.getInvoiceById);
app.post('/api/sales/invoices', authenticate, authorizeRole(['FRANCHISE_ADMIN']), FinanceController.createInvoice);

app.get('/api/sales/returns', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getReturnOrders);
app.post('/api/sales/returns', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.createReturnOrder);
app.patch('/api/sales/returns/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.updateReturnOrder);

app.get('/api/sales/analytics', authenticate, authorizeRole(['FRANCHISE_ADMIN']), SalesController.getAnalytics);

app.get('/api/sales/delivery-challans', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.getDeliveryChallans);
app.post('/api/sales/delivery-challans', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.createDeliveryChallan);
app.get('/api/sales/delivery-challans/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.getDeliveryChallan);
app.patch('/api/sales/delivery-challans/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.updateDeliveryChallan);
app.post('/api/sales/delivery-challans/:id/deliver', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.markDeliveryChallanDelivered);

app.get('/api/sales/transit-stock', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.getTransitStock);
app.get('/api/sales/dispatch-tracking', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.getDispatchTracking);

app.get('/api/sales/delivery-challan-returns', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.getDeliveryChallanReturns);
app.post('/api/sales/delivery-challan-returns', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.createDeliveryChallanReturn);
app.post('/api/sales/delivery-challan-returns/:id/receive', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), SalesController.receiveDeliveryChallanReturn);

// ─── Purchase Module (RFQ & Returns) ─────────────────────────────────────────
app.get('/api/purchase/rfqs', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseController.getRFQs);
app.post('/api/purchase/rfqs', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseController.createRFQ);
app.get('/api/purchase/rfqs/:id', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseController.getRFQ);
app.patch('/api/purchase/rfqs/:id', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseController.updateRFQ);
app.post('/api/purchase/rfqs/:id/convert-to-po', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseController.convertQuotationToPO);

app.get('/api/purchase/returns', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PurchaseController.getPurchaseReturns);
app.post('/api/purchase/returns', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PurchaseController.createPurchaseReturn);
app.patch('/api/purchase/returns/:id', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PurchaseController.updatePurchaseReturn);

app.post('/api/purchase/requisitions', authenticate, authorizeRole(['FRANCHISE_ADMIN']), PurchaseController.createRequisition);

// ─── Purchase Requests (HQ Internal) ───────────────────────────────────────────
app.get('/api/purchase-requests', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseRequestController.getAll);
app.get('/api/purchase-requests/:id', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseRequestController.getById);
app.post('/api/purchase-requests', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseRequestController.create);
app.patch('/api/purchase-requests/:id/status', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseRequestController.updateStatus);
app.delete('/api/purchase-requests/:id', authenticate, authorizeRole(['SUPER_ADMIN']), PurchaseRequestController.deleteRequest);
// ─── Franchise Orders (Phase 7) ───────────────────────────────────────────────
app.get('/api/franchise-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseOrderController.getAll);
app.post('/api/franchise-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseOrderController.create);
app.get('/api/franchise-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseOrderController.getById);
app.patch('/api/franchise-orders/:id/status', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseOrderController.updateStatus);
app.post('/api/franchise-orders/:id/payment', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), FranchiseOrderController.recordPayment);

// ─── GST Invoice (Phase 10) ────────────────────────────────────────────────────
app.get('/api/franchise-orders/:id/invoice', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN']), async (req, res) => {
  try {
    const isInterState = req.query.interState === 'true';
    const invoice = await GSTInvoiceService.generateFranchiseInvoice(req.params.id, isInterState);
    res.json(invoice);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Vendor Ledger Balance ─────────────────────────────────────────────────────
app.get('/api/vendors/:id/balance', authenticate, authorizeRole(['SUPER_ADMIN']), async (req, res) => {
  try {
    const balance = await GSTInvoiceService.getVendorBalance(req.params.id);
    res.json(balance);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Centralized Error Handling
app.use(errorHandler);

export default app;
