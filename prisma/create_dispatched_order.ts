import prisma from '../src/lib/prisma';
import { FranchiseOrderStatus, ProductType, PaymentType } from '@prisma/client';

async function main() {
  console.log('🚀 Seeding a DISPATCHED Franchise Order...');

  // 1. Ensure Product "Test Idli" exists
  let product = await prisma.product.findUnique({
    where: { sku: 'IDLI-001' }
  });

  if (!product) {
    product = await prisma.product.create({
      data: {
        name: 'Test Idli',
        sku: 'IDLI-001',
        basePrice: 50,
        isVeg: true,
        is_menu_item: true,
        productType: ProductType.FINISHED_GOOD,
        taxPercent: 5,
        isActive: true
      }
    });
    console.log('✅ Created product Test Idli:', product.id);
  } else {
    console.log('ℹ️ Found existing product:', product.name);
  }

  // 2. Ensure Franchise "fran-downtown" exists
  const franchise = await prisma.franchise.findUnique({
    where: { id: 'fran-downtown' }
  });

  if (!franchise) {
    throw new Error('Franchise fran-downtown not found. Please run main seed first.');
  }
  console.log('ℹ️ Found franchise:', franchise.name);

  // 3. Create a unique order number
  const orderNumber = 'FO-' + Math.random().toString(36).substring(2, 10).toUpperCase();

  // 4. Create DISPATCHED order
  const subtotal = 500; // 10 units * 50
  const taxAmount = 25;  // 5% of 500
  const deliveryCharges = 50;
  const totalAmount = subtotal + taxAmount + deliveryCharges;

  const order = await prisma.franchiseOrder.create({
    data: {
      orderNumber,
      franchiseId: franchise.id,
      status: FranchiseOrderStatus.DISPATCHED,
      paymentType: PaymentType.CREDIT,
      paymentStatus: 'UNPAID',
      subtotal,
      taxAmount,
      deliveryCharges,
      totalAmount,
      priority: 'NORMAL',
      notes: 'Simulated dispatch order for scanner testing',
      expectedDispatchDate: new Date(),
      actualDispatchDate: new Date(),
      items: {
        create: {
          productId: product.id,
          quantity: 10,
          unitPrice: 50,
          totalAmount: 500,
          productType: ProductType.FINISHED_GOOD
        }
      }
    },
    include: {
      items: true
    }
  });

  console.log(`🎉 Successfully created DISPATCHED order: ${order.orderNumber}`);
  console.log(`👉 Order ID: ${order.id}`);
  console.log(`👉 Total Amount: ₹${order.totalAmount}`);
}

main()
  .catch(e => {
    console.error('❌ Error seeding order:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
