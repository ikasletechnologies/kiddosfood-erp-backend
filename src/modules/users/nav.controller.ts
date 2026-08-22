import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../../types/request';

interface MenuItem {
  title: string;
  icon?: string;
  path?: string;
  children?: MenuItem[];
}

export class NavController {
  static async getNavigation(req: Request, res: Response) {
    try {
      const user = (req as AuthenticatedRequest).user;
      const role = user?.role;

      const menu: MenuItem[] = [
        { title: 'Dashboard', icon: 'LayoutDashboard', path: '/dashboard' }
      ];

      // 1. Sales (POS, Orders)
      menu.push({
        title: 'Sales',
        icon: 'ShoppingCart',
        children: [
          { title: 'POS (Billing)', path: '/sales/pos' },
          { title: 'Orders', path: '/sales/orders' }
        ]
      });

      // 2. Kitchen (KDS)
      menu.push({
        title: 'Kitchen',
        icon: 'CookingPot',
        path: '/kitchen/kds'
      });

      // 3. Products & Inventory
      const inventory = {
        title: 'Products & Inventory',
        icon: 'Package',
        children: [
          { title: 'Menu Management', path: '/inventory/menu' },
          { title: 'Raw Materials', path: '/inventory/materials' },
          { title: 'Stock History', path: '/inventory/history' }
        ]
      };
      menu.push(inventory);

      // 4. Purchase
      menu.push({
        title: 'Purchase',
        icon: 'ShoppingBag',
        children: [
          { title: 'Suppliers', path: '/purchase/suppliers' },
          { title: 'Purchase Orders', path: '/purchase/orders' }
        ]
      });

      // 5. Customers (CRM)
      menu.push({
        title: 'Customers',
        icon: 'Users',
        children: [
          { title: 'Customer Database', path: '/crm/customers' },
          { title: 'Loyalty', path: '/crm/loyalty' }
        ]
      });

      // 6. Reports
      menu.push({
        title: 'Reports',
        icon: 'BarChart3',
        children: [
          {
            title: 'Production',
            path: '/reports/production',
            children: [
              { title: 'Production Batches', path: '/reports/production/batches' },
              { title: 'Production History', path: '/reports/production/history' },
              { title: 'Yield & Summary', path: '/reports/production' }
            ]
          },
          {
            title: 'Inventory',
            path: '/reports/inventory',
            children: [
              { title: 'Stock Summary', path: '/reports/stock-summary' },
              { title: 'Item Report By Party', path: '/reports/item-by-party' },
              { title: 'Item Wise Profit & Loss', path: '/reports/item-profit-loss' },
              { title: 'Item Category Wise Profit', path: '/reports/item-category-profit-loss' },
              { title: 'Low Stock Summary', path: '/reports/low-stock-summary' },
              { title: 'Stock Detail', path: '/reports/stock-detail' },
              { title: 'Item Detail', path: '/reports/item-detail' },
              { title: 'Sale / Purchase Report By Item', path: '/reports/sale-purchase-by-item' },
              { title: 'Stock Summary Report By Item', path: '/reports/stock-summary-by-item' },
              { title: 'Item Wise Discount', path: '/reports/item-discount' },
              { title: 'Inventory Valuation', path: '/reports/inventory-value' }
            ]
          },
          {
            title: 'Inventory Ledger',
            path: '/reports/inventory-ledger',
            children: [
              { title: 'Stock Movement Ledger', path: '/reports/inventory-ledger' },
              { title: 'Raw Material Summary', path: '/inventory/materials' },
              { title: 'Stock Movement History', path: '/inventory/history' }
            ]
          },
          {
            title: 'Financial',
            children: [
              {
                title: 'Transaction Report',
                children: [
                  { title: 'Sale', path: '/reports/sales' },
                  { title: 'Purchase', path: '/reports/purchases' },
                  { title: 'Day Book', path: '/reports/daybook' },
                  { title: 'All Transactions', path: '/reports/transactions' },
                  { title: 'Profit And Loss', path: '/reports/profit' },
                  { title: 'Bill Wise Profit', path: '/reports/bill-wise-profit' },
                  { title: 'Cash Flow', path: '/reports/cash-flow' },
                  { title: 'Trial Balance Report', path: '/reports/trial-balance' },
                  { title: 'Balance Sheet', path: '/reports/balance-sheet' }
                ]
              },
              {
                title: 'Party Report',
                children: [
                  { title: 'Party Statement', path: '/reports/party-statement' },
                  { title: 'Party Wise Profit & Loss', path: '/reports/party-profit-loss' },
                  { title: 'All Parties', path: '/reports/all-parties' },
                  { title: 'Party Report By Item', path: '/reports/party-by-item' },
                  { title: 'Sale Purchase By Party', path: '/reports/sale-purchase-by-party' },
                  { title: 'Sale Purchase By Party Group', path: '/reports/sale-purchase-by-party-group' }
                ]
              },
              {
                title: 'GST Reports',
                children: [
                  { title: 'GSTR 1', path: '/reports/gstr1' },
                  { title: 'GSTR 2', path: '/reports/gstr2' },
                  { title: 'GSTR 3 B', path: '/reports/gstr3b' },
                  { title: 'GSTR 9', path: '/reports/gstr9' },
                  { title: 'Sale Summary By HSN', path: '/reports/hsn-summary' },
                  { title: 'SAC Report', path: '/reports/sac' }
                ]
              },
              {
                title: 'Business Status',
                children: [
                  { title: 'Bank Statement', path: '/reports/bank-statement' },
                  { title: 'Discount Report', path: '/reports/discount-report' }
                ]
              },
              {
                title: 'Taxes',
                children: [
                  { title: 'GST Report', path: '/reports/gst' },
                  { title: 'GST Rate Report', path: '/reports/gst-rate' },
                  { title: 'Form No. 27EQ', path: '/reports/form-27eq' },
                  { title: 'TCS Receivable', path: '/reports/tcs-receivable' },
                  { title: 'TDS Payable', path: '/reports/tds-payable' },
                  { title: 'TDS Receivable', path: '/reports/tds-receivable' }
                ]
              },
              {
                title: 'Expense Report',
                children: [
                  { title: 'Expense', path: '/reports/expenses' },
                  { title: 'Expense Category Report', path: '/reports/expense-category' },
                  { title: 'Expense Item Report', path: '/reports/expense-item' }
                ]
              },
              {
                title: 'Sale Order Report',
                children: [
                  { title: 'Sale Orders', path: '/reports/sale-orders' },
                  { title: 'Sale Order Item', path: '/reports/sale-order-items' }
                ]
              },
              {
                title: 'Loan Accounts',
                children: [
                  { title: 'Loan Statement', path: '/reports/loan-statement' }
                ]
              }
            ]
          },
          {
            title: 'Franchise',
            path: '/reports/franchise',
            children: [
              { title: 'Franchise Overview', path: '/reports/franchise' },
              { title: 'Branch Performance', path: '/reports/franchise/performance' }
            ]
          }
        ]
      });

      // 7. Staff (HR)
      if (role === 'SUPER_ADMIN' || role === 'FRANCHISE_ADMIN') {
        menu.push({
          title: 'Staff',
          icon: 'UserCog',
          children: [
            { title: 'Employees', path: '/hr/employees' },

          ]
        });
      }

      // 8. Franchise / Branch Management (Super Admin Only)
      if (role === 'SUPER_ADMIN') {
        menu.push({
          title: 'Branch Management',
          icon: 'Building2',
          path: '/franchise'
        });
      }

      // 9. Settings
      const settings: MenuItem = {
        title: 'Settings',
        icon: 'Settings',
        children: [
          { title: 'Company Settings', path: '/settings/company' }
        ]
      };

      if (role === 'SUPER_ADMIN') {
        settings.children?.unshift({ title: 'Users & Roles', path: '/settings/users' });
      }

      menu.push(settings);

      res.json(menu);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
