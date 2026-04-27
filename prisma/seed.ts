import prisma from '../src/lib/prisma';
import bcrypt from 'bcryptjs';

async function main() {
  console.log('🌱 Starting comprehensive database seeding for New ERP Workflow...');

  // 1. Create Franchises
  const rootFranchise = await prisma.franchise.upsert({
    where: { id: 'hq-001' },
    update: {},
    create: {
      id: 'hq-001',
      name: 'Kiddos Food Headquarters',
      location: 'Corporate Office, Mumbai',
      ownerName: 'Super Admin',
      contactNum: '9999999999',
    },
  });

  const jaipurBranch = await prisma.franchise.upsert({
    where: { id: 'branch-001' },
    update: {},
    create: {
      id: 'branch-001',
      name: 'Kiddos Food - Jaipur Branch',
      location: 'Malviya Nagar, Jaipur',
      ownerName: 'Branch Manager',
      contactNum: '8888888888',
    },
  });

  const delhiBranch = await prisma.franchise.upsert({
    where: { id: 'branch-002' },
    update: {},
    create: {
      id: 'branch-002',
      name: 'Kiddos Food - Delhi Branch',
      location: 'Connaught Place, Delhi',
      ownerName: 'Delhi Manager',
      contactNum: '7777777777',
    },
  });

  // 2. Permissions
  const permissionKeys = [
    '*', 'crm:view', 'crm:manage', 'sales:view', 'sales:manage',
    'purchase:view', 'purchase:manage', 'inventory:view', 'inventory:manage',
    'accounts:view', 'accounts:manage', 'hr:view', 'hr:manage',
    'service:view', 'service:manage', 'pos:access'
  ];

  for (const key of permissionKeys) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key }
    });
  }

  // 3. Roles
  const rolesData = [
    { name: 'SUPER_ADMIN', desc: 'Full access across all modules.', perms: ['*'] },
    { name: 'ADMIN', desc: 'High-level management.', perms: ['crm:manage', 'sales:manage', 'inventory:manage', 'hr:manage', 'accounts:manage'] },
    { name: 'MANAGER', desc: 'Branch level management.', perms: ['sales:manage', 'inventory:manage', 'pos:access', 'crm:view'] },
    { name: 'STAFF', desc: 'Operational access.', perms: ['pos:access', 'inventory:view', 'sales:view'] },
  ];

  const roles: Record<string, any> = {};
  for (const r of rolesData) {
    roles[r.name] = await prisma.role.upsert({
      where: { name: r.name },
      update: { description: r.desc },
      create: {
        name: r.name,
        description: r.desc,
      },
    });

    // Connect permissions
    for (const pKey of r.perms) {
      const permission = await prisma.permission.findUnique({ where: { key: pKey } });
      if (permission) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: roles[r.name].id, permissionId: permission.id } },
          update: {},
          create: { roleId: roles[r.name].id, permissionId: permission.id },
        });
      }
    }
  }

  // 4. Users & Employees
  const defaultPassword = await bcrypt.hash('admin123', 10);
  
  const usersToCreate = [
    { email: 'admin@kiddosfood.com', name: 'Super Admin', role: 'SUPER_ADMIN', franchise: 'hq-001', code: 'EMP001' },
    { email: 'manager.jaipur@kiddosfood.com', name: 'Jaipur Manager', role: 'MANAGER', franchise: 'branch-001', code: 'EMP002' },
    { email: 'staff.jaipur@kiddosfood.com', name: 'Jaipur Staff', role: 'STAFF', franchise: 'branch-001', code: 'EMP003' },
    { email: 'manager.delhi@kiddosfood.com', name: 'Delhi Manager', role: 'MANAGER', franchise: 'branch-002', code: 'EMP004' },
  ];

  for (const u of usersToCreate) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { fullName: u.name, roleId: roles[u.role].id, franchiseId: u.franchise },
      create: {
        email: u.email,
        fullName: u.name,
        passwordHash: defaultPassword,
        roleId: roles[u.role].id,
        franchiseId: u.franchise,
        is_active: true,
      },
    });

    await prisma.employee.upsert({
      where: { userId: user.id },
      update: { employeeCode: u.code },
      create: {
        userId: user.id,
        employeeCode: u.code,
        department: u.role === 'STAFF' ? 'Kitchen' : 'Management',
        designation: u.role,
        dateOfJoining: new Date(),
      }
    });
  }

  // 5. Customers & Vendors
  const customers = [
    { name: 'Amit Sharma', phone: '9829012345', email: 'amit@example.com' },
    { name: 'Sonal Verma', phone: '9829054321', email: 'sonal@example.com' },
    { name: 'Rajesh Gupta', phone: '9829099999', email: 'rajesh@example.com' },
  ];

  for (const c of customers) {
    await prisma.customer.upsert({
      where: { phone: c.phone },
      update: { name: c.name, email: c.email },
      create: c,
    });
  }

  const vendors = [
    { id: 'vendor-001', name: 'Jaipur Dairy', contact: '0141-223344', email: 'sales@jaipurdairy.com' },
    { id: 'vendor-002', name: 'Global Grains', contact: '011-445566', email: 'info@globalgrains.com' },
  ];

  const createdVendors = [];
  for (const v of vendors) {
    const vendor = await prisma.vendor.upsert({
      where: { id: v.id },
      update: { name: v.name, contact: v.contact, email: v.email },
      create: v,
    });
    createdVendors.push(vendor);
  }

  // 6. Inventory Items (Raw Materials)
  const rawMaterials = [
    { name: 'Premium Flour', sku: 'RM-FLR-001', category: 'RAW_MATERIAL' as const, stock: 1000, unit: 'kg', vendor: 'vendor-002' },
    { name: 'Granulated Sugar', sku: 'RM-SGR-001', category: 'RAW_MATERIAL' as const, stock: 500, unit: 'kg', vendor: 'vendor-002' },
    { name: 'Full Cream Milk', sku: 'RM-MLK-001', category: 'RAW_MATERIAL' as const, stock: 200, unit: 'ltr', vendor: 'vendor-001' },
    { name: 'Cocoa Powder', sku: 'RM-COA-001', category: 'RAW_MATERIAL' as const, stock: 50, unit: 'kg', vendor: 'vendor-002' },
  ];

  const inventoryItems: Record<string, any> = {};
  for (const rm of rawMaterials) {
    inventoryItems[rm.sku] = await prisma.inventoryItem.upsert({
      where: { sku_franchiseId: { sku: rm.sku, franchiseId: jaipurBranch.id } },
      update: { currentStock: rm.stock },
      create: {
        name: rm.name,
        sku: rm.sku,
        category: rm.category,
        currentStock: rm.stock,
        unit: rm.unit,
        franchiseId: jaipurBranch.id,
        vendorId: rm.vendor,
      },
    });
  }

  // 7. Products & Recipes
  const productsData = [
    { 
      name: 'Vanilla Muffin', sku: 'FG-VNL-MUF', price: 60, emoji: '🧁',
      recipe: [
        { sku: 'RM-FLR-001', qty: 0.1 },
        { sku: 'RM-SGR-001', qty: 0.05 },
        { sku: 'RM-MLK-001', qty: 0.02 },
      ]
    },
    { 
      name: 'Double Choco Brownie', sku: 'FG-CHOC-BRW', price: 95, emoji: '🍫',
      recipe: [
        { sku: 'RM-FLR-001', qty: 0.08 },
        { sku: 'RM-SGR-001', qty: 0.06 },
        { sku: 'RM-COA-001', qty: 0.03 },
      ]
    },
    { name: 'Cold Coffee', sku: 'FG-CLD-COF', price: 120, emoji: '🥤', recipe: [] },
  ];

  for (const pd of productsData) {
    const product = await prisma.product.upsert({
      where: { sku: pd.sku },
      update: { basePrice: pd.price, emoji: pd.emoji },
      create: {
        name: pd.name,
        sku: pd.sku,
        basePrice: pd.price,
        emoji: pd.emoji,
        category: 'Bakery',
      },
    });

    if (pd.recipe.length > 0) {
      const recipe = await prisma.recipe.upsert({
        where: { productId: product.id },
        update: { name: `${pd.name} Standard Recipe` },
        create: {
          productId: product.id,
          name: `${pd.name} Standard Recipe`,
          yieldQty: 1,
          instructions: 'Standard baking procedure.',
        },
      });

      // Clear existing recipe items for fresh seed
      await prisma.recipeItem.deleteMany({ where: { recipeId: recipe.id } });

      for (const ri of pd.recipe) {
        const invItem = inventoryItems[ri.sku];
        if (invItem) {
          await prisma.recipeItem.create({
            data: {
              recipeId: recipe.id,
              inventoryItemId: invItem.id,
              quantityRequired: ri.qty,
              unit: invItem.unit,
            }
          });
        }
      }
    }
  }

  // 8. Transactions (Sample Orders)
  console.log('🛒 Seeding sample transactions...');
  const sampleProducts = await prisma.product.findMany({ take: 3 });
  const sampleCustomer = await prisma.customer.findFirst();

  if (sampleProducts.length > 0) {
    for (let i = 1; i <= 5; i++) {
      const subTotal = sampleProducts[0].basePrice * 2;
      const tax = subTotal * 0.05;
      const invoiceNum = `INV-2024-${1000 + i}`;
      
      const existingOrder = await prisma.order.findUnique({ where: { invoiceNum } });
      if (!existingOrder) {
        await prisma.order.create({
          data: {
            invoiceNum: invoiceNum,
            customerId: sampleCustomer?.id,
            franchiseId: jaipurBranch.id,
            orderType: 'DINE_IN',
            status: 'COMPLETED',
            subTotal: subTotal,
            taxAmount: tax,
            totalAmount: subTotal + tax,
            paymentStatus: 'PAID',
            orderItems: {
              create: [
                { 
                  productId: sampleProducts[0].id, 
                  quantity: 2, 
                  price: sampleProducts[0].basePrice,
                  taxAmount: tax,
                  totalAmount: subTotal + tax
                }
              ]
            }
          }
        });
      }
    }
  }

  // 9. CRM Pipeline & Leads
  const pipeline = await prisma.pipeline.upsert({
    where: { id: 'pipe-001' },
    update: { name: 'Corporate Sales' },
    create: {
      id: 'pipe-001',
      name: 'Corporate Sales',
      description: 'Pipeline for B2B bulk orders.',
    }
  });

  const leads = [
    { contactName: 'Vijay Mallya', orgName: 'Kingfisher Corp', phone: '9000000001', subject: 'Party Catering' },
    { contactName: 'Elon Musk', orgName: 'Tesla Jaipur', phone: '9000000002', subject: 'Factory Lunch' },
  ];

  for (const l of leads) {
    // Check if lead already exists by phone to avoid duplicates if clear failed
    const existingLead = await prisma.lead.findFirst({ where: { phone: l.phone } });
    if (!existingLead) {
      await prisma.lead.create({
        data: {
          pipelineId: pipeline.id,
          contactName: l.contactName,
          orgName: l.orgName,
          phone: l.phone,
          subject: l.subject,
          status: 'NEW',
        }
      });
    }
  }

  // 10. HR Leave Types
  const leaveTypes = [
    { id: 'lt-sick', name: 'Sick Leave', days: 12 },
    { id: 'lt-casual', name: 'Casual Leave', days: 10 },
    { id: 'lt-paid', name: 'Paid Leave', days: 15 },
  ];

  for (const lt of leaveTypes) {
    await prisma.leaveType.upsert({
      where: { id: lt.id },
      update: { name: lt.name, maxDays: lt.days },
      create: {
        id: lt.id,
        name: lt.name,
        maxDays: lt.days,
        isPaid: true,
      }
    });
  }

  console.log('✅ Comprehensive sample data seeded successfully.');
  console.log('   Admin: admin@kiddosfood.com / admin123');
  console.log('   Jaipur Manager: manager.jaipur@kiddosfood.com / admin123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
