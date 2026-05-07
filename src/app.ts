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
import { ProcurementController } from './modules/procurement/procurement.controller';
import { FranchiseController } from './modules/franchise/franchise.controller';
import { NavController } from './modules/users/nav.controller';
import { RoleController } from './modules/roles/role.controller';
import { SettingsController } from './modules/settings/settings.controller';
import { AuditController } from './modules/audit/audit.controller';
import { DashboardController } from './modules/dashboard/dashboard.controller';
import { OrderController } from './modules/pos/order.controller';
import { RecipeController } from './modules/recipes/recipe.controller';
import { LogisticsController } from './modules/logistics/logistics.controller';
import { KDSController } from './modules/kds/kds.controller';
import { CustomerController } from './modules/customers/customer.controller';
import { LoyaltyController } from './modules/loyalty/loyalty.controller';
import { MenuController } from './modules/menu/menu.controller';
import { WasteController } from './modules/waste/waste.controller';
import { CRMController } from './modules/crm/crm.controller';
import { ServiceCRMController } from './modules/service-crm/service-crm.controller';
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

const app: Express = express();

app.use(cors());
app.use(express.json());

// Advanced API Flow Logger
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
    const safeBody = { ...req.body };
    if (safeBody.password) safeBody.password = '********';
    console.log(`   🔸 Body:`, safeBody);
  }

  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusIcon = res.statusCode >= 400 ? '❌' : '✅';
    console.log(`${statusIcon} [RESPONSE] ${res.statusCode} - ${duration}ms (ID: ${requestId})`);
  });
  
  next();
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Food ERP API is running' });
});

// Auth Routes (Production Flow)
app.post('/api/auth/register', validate(registerSchema), AuthController.register);
app.post('/api/auth/login', validate(loginSchema), AuthController.login);
app.post('/api/auth/refresh', AuthController.refresh);
app.post('/api/auth/logout', AuthController.logout);
app.get('/api/me', authenticate, UserController.getMe);
app.get('/api/me/navigation', authenticate, NavController.getNavigation);

// Dashboard Metrics
app.get('/api/dashboard/summary', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER']), DashboardController.getSummary);

// API Routes (Protected)
// Admin Only: User & Role Management
app.get('/api/users', authenticate, authorizeRole(['ADMIN']), UserController.getAll);
app.get('/api/users/:id', authenticate, authorizeRole(['ADMIN']), UserController.getOne);
app.post('/api/users', authenticate, authorizeRole(['ADMIN']), UserController.create);
app.patch('/api/users/:id', authenticate, authorizeRole(['ADMIN']), UserController.update);
app.delete('/api/users/:id', authenticate, authorizeRole(['ADMIN']), UserController.delete);

app.get('/api/roles', authenticate, authorizeRole(['ADMIN']), RoleController.getAll);
app.get('/api/roles/:id', authenticate, authorizeRole(['ADMIN']), RoleController.getOne);
app.post('/api/roles', authenticate, authorizeRole(['ADMIN']), RoleController.create);
app.put('/api/roles/:id', authenticate, authorizeRole(['ADMIN']), RoleController.update);
app.delete('/api/roles/:id', authenticate, authorizeRole(['ADMIN']), RoleController.delete);

// Other Business Modules
// Inventory & Stock Management
app.get('/api/inventory', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']), InventoryController.getInventory);
app.get('/api/inventory/items/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']), InventoryController.getItem);
app.post('/api/inventory/items', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), InventoryController.createItem);
app.post('/api/inventory/stock-in', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), InventoryController.stockIn);
app.post('/api/inventory/stock-out', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), InventoryController.stockOut);
app.post('/api/inventory/adjustment', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER']), InventoryController.adjustment);
app.get('/api/inventory/movements', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER']), InventoryController.getMovements);

// Raw Materials (Phase 3 requested endpoints)
app.get('/api/raw-materials', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']), RawMaterialsController.getAll);
app.get('/api/raw-materials/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF']), RawMaterialsController.getById);
app.post('/api/raw-materials', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), RawMaterialsController.create);
app.patch('/api/raw-materials/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), RawMaterialsController.update);
app.delete('/api/raw-materials/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), RawMaterialsController.delete);
app.patch('/api/raw-materials/:id/deactivate', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), RawMaterialsController.deactivate);
app.patch('/api/raw-materials/:id/activate', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), RawMaterialsController.activate);

// POS & Orders - Multi-Step Strict POS Flow
app.post('/api/orders', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.createOrder);
app.post('/api/orders/:id/items', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.addItems);
app.patch('/api/orders/:id/status', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), OrderController.updateStatus);
app.post('/api/orders/:id/pay', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.addPayment);
app.post('/api/orders/checkout', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.checkout); // Legacy compatibility fallback

// Queries
app.get('/api/orders', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.getAll);
app.get('/api/orders/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.getOne);
app.get('/api/invoices/:orderId', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), OrderController.getInvoice);

// Products & Recipes
app.get('/api/products', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'KITCHEN']), ProductController.getAll);
app.post('/api/products', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ProductController.create);
app.get('/api/products/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'KITCHEN']), ProductController.getOne);
app.patch('/api/products/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ProductController.update);
app.delete('/api/products/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ProductController.delete);
app.get('/api/recipes', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), RecipeController.getAll);
app.post('/api/recipes', authenticate, authorizeRole(['ADMIN', 'MANAGER']), RecipeController.upsert);
app.get('/api/recipes/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), RecipeController.getOne);
app.delete('/api/recipes/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), RecipeController.delete);
app.get('/api/recipes/product/:productId', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), RecipeController.getByProduct);
app.post('/api/recipes/:id/cost', authenticate, authorizeRole(['ADMIN', 'MANAGER']), RecipeController.calculateCost);

// Production Workflow
app.get('/api/production/history', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'KITCHEN']), ProductionController.getHistory);
app.post('/api/production/batch', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'KITCHEN']), ProductionController.startBatch);
app.post('/api/production/:id/stop', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'KITCHEN']), ProductionController.stopBatch);
app.post('/api/production/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProductionController.approveBatch);
app.get('/api/production/batches', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER']), async (req, res) => {
  try {
    const { ProductionService } = await import('./modules/production/production.service');
    const batches = await ProductionService.getProductBatches(req.query.productId as string | undefined);
    res.json(batches);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
app.get('/api/production/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN', 'MANAGER', 'KITCHEN']), ProductionController.getOne);
app.patch('/api/production/:id/status', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'KITCHEN']), ProductionController.updateStatus);

// Logistics (Stock Requests & Transfers)
app.get('/api/logistics/requests', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE']), LogisticsController.getRequests);
app.post('/api/logistics/requests', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE']), LogisticsController.createRequest);
app.patch('/api/logistics/requests/:id/approve', authenticate, authorizeRole(['ADMIN', 'MANAGER']), LogisticsController.approveRequest);

app.get('/api/logistics/transfers', authenticate, authorizeRole(['ADMIN', 'MANAGER']), LogisticsController.getTransfers);
app.post('/api/logistics/transfers', authenticate, authorizeRole(['ADMIN', 'MANAGER']), LogisticsController.initiateTransfer);
app.patch('/api/logistics/transfers/:id/complete', authenticate, authorizeRole(['ADMIN', 'MANAGER']), LogisticsController.completeTransfer);

// Delivery & Logistics
app.get('/api/delivery/active', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'DELIVERY']), DeliveryController.getActive);
app.post('/api/delivery/update', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'DELIVERY']), DeliveryController.update);
app.post('/api/delivery/verify', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'DELIVERY']), DeliveryController.verify);



// Financials & Reports
app.get('/api/finance/pl', authenticate, authorizeRole(['ADMIN', 'FRANCHISEE']), FinanceController.getPL);
app.post('/api/finance/expense', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE']), FinanceController.addExpense);
app.get('/api/finance/invoices', authenticate, authorizeRole(['ADMIN', 'MANAGER']), FinanceController.getInvoices);
app.get('/api/finance/cash-flow', authenticate, authorizeRole(['ADMIN', 'FRANCHISE_ADMIN']), FinanceController.getCashFlow);

// Accounting (New Frontend mapping)
app.get('/api/accounting/expenses', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE', 'STAFF']), FinanceController.getExpenses);
app.post('/api/accounting/expenses', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE']), FinanceController.addExpense);
app.get('/api/accounting/payments', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE', 'STAFF']), FinanceController.getPayments);
app.post('/api/accounting/payments', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'FRANCHISEE']), FinanceController.recordPayment);

// Accounts management
app.get('/api/accounts', authenticate, authorizeRole(['ADMIN', 'FRANCHISE_ADMIN']), AccountController.getAll);
app.get('/api/accounts/:id', authenticate, authorizeRole(['ADMIN', 'FRANCHISE_ADMIN']), AccountController.getById);

// Phase 5 & 7 Reports (Consolidated)
app.get('/api/reports/sales', authenticate, authorizeRole(['ADMIN', 'MANAGER']), FinanceController.getSalesReport);
app.get('/api/reports/expenses', authenticate, authorizeRole(['ADMIN', 'MANAGER']), FinanceController.getExpensesReport);
app.get('/api/reports/profit', authenticate, authorizeRole(['ADMIN', 'MANAGER']), FinanceController.getPL);
app.get('/api/reports/invoices', authenticate, authorizeRole(['ADMIN', 'MANAGER']), FinanceController.getInvoices);

// Phase 7 Analytics
app.get('/api/analytics/product-performance', authenticate, authorizeRole(['ADMIN', 'MANAGER']), AnalyticsController.getProductPerformance);
app.get('/api/analytics/payment-distribution', authenticate, authorizeRole(['ADMIN', 'MANAGER']), AnalyticsController.getPaymentDistribution);
app.get('/api/analytics/wastage-summary', authenticate, authorizeRole(['ADMIN', 'MANAGER']), AnalyticsController.getWastageSummary);
app.get('/api/analytics/daily-sales', authenticate, authorizeRole(['ADMIN', 'MANAGER']), AnalyticsController.getDailySalesSummary);

// Procurement & Vendors
app.get('/api/vendors', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getAllVendors);
app.post('/api/vendors', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.createVendor);
app.get('/api/vendors/summary', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getVendorSummary);
app.get('/api/vendors/filter', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.filterVendors);
app.get('/api/vendors/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getVendorById);
app.patch('/api/vendors/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.updateVendor);
app.delete('/api/vendors/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.deleteVendor);
app.post('/api/vendors/link-material', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.linkMaterial);
app.get('/api/vendors/:id/ledger', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getVendorLedger);
app.post('/api/vendors/:id/payment', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.recordPayment);
app.post('/api/vendors/:id/adjustment', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.recordAdjustment);
app.get('/api/suppliers', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getAllVendors); // Alias
app.post('/api/suppliers', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.createVendor); // Alias

app.get('/api/procurement/orders', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getPOs);
app.get('/api/procurement/orders/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getOne);
app.post('/api/procurement/po', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.createPO);

// Purchase Orders
app.get('/api/purchase-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getPOs);
app.post('/api/purchase-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.createPO);
app.get('/api/purchase-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.getOne);
app.patch('/api/purchase-orders/:id/approve', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.approvePO);
app.patch('/api/purchase-orders/:id/advance', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.recordAdvance);
app.patch('/api/purchase-orders/:id/cancel', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.cancelPO);
app.delete('/api/purchase-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.deletePO);
// Manual reconciliation: Pay this PO using existing vendor advance balance
app.post('/api/purchase-orders/:id/apply-advance', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.applyAdvance);
// Legacy receive endpoint (kept for backward compat; prefer GRN flow)
app.post('/api/purchase-orders/:id/receive', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), ProcurementController.receiveGoods);

// GRN (Goods Receipt Notes)
app.get('/api/grn', authenticate, authorizeRole(['ADMIN', 'MANAGER']), GRNController.getAll);
app.get('/api/grn/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), GRNController.getById);
app.post('/api/grn/from-po/:poId', authenticate, authorizeRole(['ADMIN', 'MANAGER']), GRNController.createFromPO);
app.patch('/api/grn/:id/approve', authenticate, authorizeRole(['ADMIN', 'MANAGER']), GRNController.approve);
app.patch('/api/grn/:id/cancel', authenticate, authorizeRole(['ADMIN', 'MANAGER']), GRNController.cancel);

// Vendor Invoices (3-way matching)
app.get('/api/vendor-invoices', authenticate, authorizeRole(['ADMIN', 'MANAGER']), VendorInvoiceController.getAll);
app.post('/api/vendor-invoices', authenticate, authorizeRole(['ADMIN', 'MANAGER']), VendorInvoiceController.create);
app.post('/api/vendor-invoices/:id/match', authenticate, authorizeRole(['ADMIN', 'MANAGER']), VendorInvoiceController.match);
app.patch('/api/vendor-invoices/:id/status', authenticate, authorizeRole(['ADMIN', 'MANAGER']), VendorInvoiceController.updateStatus);

// Franchise Management & Logistics
app.get('/api/franchise', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.getAll);
app.post('/api/franchise', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.create);
app.get('/api/franchise/requests', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.getRequests);
app.post('/api/franchise/requests', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.createRequest);
app.post('/api/franchise/fulfill', authenticate, authorizeRole(['SUPER_ADMIN']), FranchiseController.fulfillRequest);
app.get('/api/franchise/transfers', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.getAllTransfers);
app.patch('/api/franchise/transfers/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.updateTransferStatus);
app.get('/api/franchise/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.getOne);
app.patch('/api/franchise/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.update);
app.delete('/api/franchise/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.deleteFranchise);

// Franchise Product Requests (franchise → home house)
app.get('/api/franchise/product-requests', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'FRANCHISEE']), FranchiseController.getProductRequests);
app.post('/api/franchise/product-requests', authenticate, authorizeRole(['FRANCHISEE', 'ADMIN', 'MANAGER']), FranchiseController.createProductRequest);
app.patch('/api/franchise/product-requests/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseController.updateProductRequest);
app.delete('/api/franchise/product-requests/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'FRANCHISEE']), FranchiseController.deleteProductRequest);

// User Governance (SUPER_ADMIN only)
app.get('/api/users', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.getAll);
app.post('/api/users', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.create);
app.get('/api/franchise/:id/users', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.getByFranchise);
app.patch('/api/users/:id', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.update);
app.patch('/api/users/:id/reset-password', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), UserController.resetPassword);
app.delete('/api/users/:id', authenticate, authorizeRole(['SUPER_ADMIN']), UserController.delete);

// Governance & Settings
app.get('/api/settings', authenticate, authorizeRole(['SUPER_ADMIN']), SettingsController.getAll);
app.post('/api/settings', authenticate, authorizeRole(['SUPER_ADMIN']), SettingsController.setSetting);
app.get('/api/settings/company', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), SettingsController.getCompanyProfile);
app.patch('/api/settings/company', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), SettingsController.updateCompanyProfile);
app.get('/api/audit/logs', authenticate, authorizeRole(['SUPER_ADMIN']), AuditController.getLogs);

// POS (frontend-facing aliases with recipeId→productId resolution + auto loyalty)
app.post('/api/pos/checkout', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), POSController.checkout);
app.get('/api/pos/orders', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF', 'KITCHEN']), POSController.getOrders);

// KDS — Kitchen Display System
app.get('/api/kds/orders', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN', 'STAFF']), KDSController.getOrders);
app.patch('/api/kds/orders/:id/status', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), KDSController.updateStatus);

// Menu Management (wraps Products with category + toggle support)
app.get('/api/menu/categories', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF', 'KITCHEN']), MenuController.getCategories);
app.post('/api/menu/categories', authenticate, authorizeRole(['ADMIN', 'MANAGER']), MenuController.createCategory);
app.get('/api/menu/items', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF', 'KITCHEN']), MenuController.getItems);
app.post('/api/menu/items', authenticate, authorizeRole(['ADMIN', 'MANAGER']), MenuController.createItem);
app.patch('/api/menu/items/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), MenuController.updateItem);
app.delete('/api/menu/items/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), MenuController.deleteItem);

// Customers
app.get('/api/customers', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CustomerController.getAll);
app.post('/api/customers', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CustomerController.create);
app.get('/api/customers/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CustomerController.getOne);
app.patch('/api/customers/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CustomerController.update);
app.get('/api/customers/:id/history', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CustomerController.getHistory);
app.delete('/api/customers/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CustomerController.delete);

// Loyalty & Rewards
app.get('/api/loyalty/:customerId', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), LoyaltyController.getLoyalty);
app.post('/api/loyalty/add-points', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), LoyaltyController.addPoints);
app.post('/api/loyalty/redeem', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), LoyaltyController.redeem);

// Waste & Loss
app.get('/api/waste', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), WasteController.getAll);
app.get('/api/waste/summary', authenticate, authorizeRole(['ADMIN', 'MANAGER']), WasteController.getSummary);
app.get('/api/waste/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), WasteController.getOne);
app.post('/api/waste', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'KITCHEN']), WasteController.create);

// Stock Alerts
app.get('/api/inventory/alerts', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), InventoryController.getAlerts);

// CRM — Pipelines
app.get('/api/crm/pipelines', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CRMController.getPipelines);
app.post('/api/crm/pipelines', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.createPipeline);
app.patch('/api/crm/pipelines/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.updatePipeline);
app.delete('/api/crm/pipelines/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.deletePipeline);

// CRM — Leads
app.get('/api/crm/leads', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CRMController.getLeads);
app.post('/api/crm/leads', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CRMController.createLead);
app.get('/api/crm/leads/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CRMController.getLead);
app.patch('/api/crm/leads/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.updateLead);
app.delete('/api/crm/leads/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.deleteLead);

// CRM — Forms
app.get('/api/crm/forms', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), CRMController.getForms);
app.post('/api/crm/forms', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.createForm);
app.patch('/api/crm/forms/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.updateForm);
app.delete('/api/crm/forms/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.deleteForm);

// CRM — Reports
app.get('/api/crm/reports/lead-source', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.getLeadSourceReport);
app.get('/api/crm/reports/team-sales', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.getTeamSalesReport);
app.get('/api/crm/reports/client-performance', authenticate, authorizeRole(['ADMIN', 'MANAGER']), CRMController.getClientPerformanceReport);

// ─── Service CRM ─────────────────────────────────────────────────────────────
app.get('/api/service/tickets', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), ServiceCRMController.getTickets);
app.post('/api/service/tickets', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), ServiceCRMController.createTicket);
app.get('/api/service/tickets/stats', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ServiceCRMController.getStats);
app.get('/api/service/tickets/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), ServiceCRMController.getTicket);
app.patch('/api/service/tickets/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), ServiceCRMController.updateTicket);
app.delete('/api/service/tickets/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ServiceCRMController.deleteTicket);

app.get('/api/service/field-visits', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), ServiceCRMController.getFieldVisits);
app.post('/api/service/field-visits', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ServiceCRMController.createFieldVisit);
app.post('/api/service/field-visits/:id/check-in', authenticate, ServiceCRMController.checkIn);
app.post('/api/service/field-visits/:id/check-out', authenticate, ServiceCRMController.checkOut);
app.post('/api/service/field-visits/:id/location', authenticate, ServiceCRMController.logLocation);
app.patch('/api/service/field-visits/:id/status', authenticate, authorizeRole(['ADMIN', 'MANAGER']), ServiceCRMController.updateVisitStatus);

// ─── Employee Management ──────────────────────────────────────────────────────
app.get('/api/employees', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.getAll);
app.post('/api/employees', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.create);
app.get('/api/employees/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.getOne);
app.patch('/api/employees/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.update);

app.get('/api/employees/:id/shifts', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.getEmployeeShifts);

app.get('/api/leave-types', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), EmployeeController.getLeaveTypes);
app.post('/api/leave-types', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.createLeaveType);
app.patch('/api/leave-types/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.updateLeaveType);

app.get('/api/leaves', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), EmployeeController.getLeaves);
app.post('/api/leaves', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), EmployeeController.applyLeave);
app.patch('/api/leaves/:id/approve', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.approveLeave);

app.get('/api/shifts', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.getShifts);
app.post('/api/shifts', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.createShift);
app.post('/api/shifts/assign', authenticate, authorizeRole(['ADMIN', 'MANAGER']), EmployeeController.assignShift);

// ─── Payroll ──────────────────────────────────────────────────────────────────
app.get('/api/payroll/components', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PayrollController.getComponents);
app.post('/api/payroll/components', authenticate, authorizeRole(['ADMIN']), PayrollController.createComponent);
app.patch('/api/payroll/components/:id', authenticate, authorizeRole(['ADMIN']), PayrollController.updateComponent);

app.get('/api/payroll/structures', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PayrollController.getStructures);
app.post('/api/payroll/structures', authenticate, authorizeRole(['ADMIN']), PayrollController.createStructure);
app.get('/api/payroll/structures/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PayrollController.getStructure);
app.patch('/api/payroll/structures/:id', authenticate, authorizeRole(['ADMIN']), PayrollController.updateStructure);

app.get('/api/payroll/runs', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PayrollController.getPayrolls);
app.post('/api/payroll/runs', authenticate, authorizeRole(['ADMIN']), PayrollController.createPayroll);
app.post('/api/payroll/runs/:id/process', authenticate, authorizeRole(['ADMIN']), PayrollController.processPayroll);

app.get('/api/payroll/payslips', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PayrollController.getPayslips);
app.post('/api/payroll/payslips', authenticate, authorizeRole(['ADMIN']), PayrollController.createManualPayslip);
app.get('/api/payroll/payslips/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), PayrollController.getPayslip);
app.patch('/api/payroll/payslips/:id/mark-paid', authenticate, authorizeRole(['ADMIN']), PayrollController.markPaid);

// ─── Sales Module ─────────────────────────────────────────────────────────────
app.get('/api/sales/quotations', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.getQuotations);
app.post('/api/sales/quotations', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.createQuotation);
app.get('/api/sales/quotations/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.getQuotation);
app.patch('/api/sales/quotations/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), SalesController.updateQuotation);
app.post('/api/sales/quotations/:id/convert', authenticate, authorizeRole(['ADMIN', 'MANAGER']), SalesController.convertQuotation);

app.get('/api/sales/orders', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.getSalesOrders);
app.post('/api/sales/orders', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.createSalesOrder);
app.get('/api/sales/orders/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.getSalesOrder);
app.patch('/api/sales/orders/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), SalesController.updateSalesOrder);

app.get('/api/sales/returns', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.getReturnOrders);
app.post('/api/sales/returns', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), SalesController.createReturnOrder);
app.patch('/api/sales/returns/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), SalesController.updateReturnOrder);

app.get('/api/sales/analytics', authenticate, authorizeRole(['ADMIN', 'MANAGER']), SalesController.getAnalytics);

// ─── Purchase Module (RFQ & Returns) ─────────────────────────────────────────
app.get('/api/purchase/rfqs', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.getRFQs);
app.post('/api/purchase/rfqs', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.createRFQ);
app.get('/api/purchase/rfqs/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.getRFQ);
app.patch('/api/purchase/rfqs/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.updateRFQ);
app.post('/api/purchase/rfqs/:id/convert-to-po', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.convertRFQtoPO);

app.get('/api/purchase/returns', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.getPurchaseReturns);
app.post('/api/purchase/returns', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.createPurchaseReturn);
app.patch('/api/purchase/returns/:id', authenticate, authorizeRole(['ADMIN', 'MANAGER']), PurchaseController.updatePurchaseReturn);

app.post('/api/purchase/requisitions', authenticate, authorizeRole(['ADMIN', 'MANAGER', 'STAFF']), PurchaseController.createRequisition);

// ─── Franchise Orders (Phase 7) ───────────────────────────────────────────────
app.get('/api/franchise-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN']), FranchiseOrderController.getAll);
app.post('/api/franchise-orders', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN']), FranchiseOrderController.create);
app.get('/api/franchise-orders/:id', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN']), FranchiseOrderController.getById);
app.patch('/api/franchise-orders/:id/status', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseOrderController.updateStatus);
app.post('/api/franchise-orders/:id/payment', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN']), FranchiseOrderController.recordPayment);

// ─── GST Invoice (Phase 10) ────────────────────────────────────────────────────
app.get('/api/franchise-orders/:id/invoice', authenticate, authorizeRole(['SUPER_ADMIN', 'FRANCHISE_ADMIN', 'ADMIN']), async (req, res) => {
  try {
    const isInterState = req.query.interState === 'true';
    const invoice = await GSTInvoiceService.generateFranchiseInvoice(req.params.id, isInterState);
    res.json(invoice);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─── Vendor Ledger Balance ─────────────────────────────────────────────────────
app.get('/api/vendors/:id/balance', authenticate, authorizeRole(['SUPER_ADMIN', 'ADMIN', 'MANAGER']), async (req, res) => {
  try {
    const balance = await GSTInvoiceService.getVendorBalance(req.params.id);
    res.json(balance);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Centralized Error Handling
app.use(errorHandler);

export default app;
