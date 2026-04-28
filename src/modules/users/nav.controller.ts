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
          { title: 'Sales Report', path: '/reports/sales' },
          { title: 'Profit & Loss', path: '/reports/profit' }
        ]
      });

      // 7. Staff (HR)
      if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
        menu.push({
          title: 'Staff',
          icon: 'UserCog',
          children: [
            { title: 'Employees', path: '/hr/employees' },
            { title: 'Attendance', path: '/hr/attendance' }
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
      menu.push({
        title: 'Settings',
        icon: 'Settings',
        children: [
          { title: 'Users & Roles', path: '/settings/users' },
          { title: 'Company Settings', path: '/settings/company' }
        ]
      });

      res.json(menu);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  }
}
