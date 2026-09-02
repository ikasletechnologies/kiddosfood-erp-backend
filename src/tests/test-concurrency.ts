import prisma from '../lib/prisma';
import axios from 'axios';

async function runTest() {
  console.log('--- STARTING CONCURRENCY TEST ---');
  try {
    const customer = await prisma.customer.findFirst();
    const franchise = await prisma.franchise.findFirst();
    const product = await prisma.product.findFirst();

    if (!customer || !franchise || !product) {
       console.log('Need test data (customer, franchise, product) to run this test.');
       return;
    }

    // 1. Create a fresh CLOSED Delivery Challan
    const challan = await prisma.deliveryChallan.create({
      data: {
        challanNumber: 'DC-TEST-CONC-' + Date.now(),
        customerId: customer.id,
        franchiseId: franchise.id,
        status: 'CLOSED',
        items: {
          create: [{
            productName: product.name,
            productId: product.id,
            quantity: 10,
            rate: 50,
            totalAmount: 500
          }]
        }
      }
    });
    console.log('Created CLOSED Challan:', challan.id);

    // 2. Fire two concurrent requests
    console.log('Firing concurrent conversion requests...');
    const url = `http://localhost:5000/api/sales/delivery-challans/${challan.id}/convert-to-sale`;
    
    // Using axios with promise.all to fire identically at the same time
    const { JwtUtil } = require('../lib/jwt.util');
    const token = JwtUtil.generateAccessToken({ userId: 'system', role: 'SUPER_ADMIN', franchiseId: franchise.id });
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    
    const req1 = axios.post(url, {}, { headers, validateStatus: () => true });
    const req2 = axios.post(url, {}, { headers, validateStatus: () => true });

    const [res1, res2] = await Promise.all([req1, req2]);

    console.log('Request 1 status:', res1.status, res1.data?.error || 'Success');
    console.log('Request 2 status:', res2.status, res2.data?.error || 'Success');

    // 3. Verify DB state
    const afterChallan = await prisma.deliveryChallan.findUnique({
      where: { id: challan.id }
    });

    const orders = await prisma.order.findMany({
      where: { customerId: customer.id, totalAmount: 500 }
    });

    const relatedOrders = await prisma.order.findMany({
      where: { customerId: customer.id, totalAmount: 500 }
    });

    const totalInvoices = await prisma.invoice.findMany({
      where: { orderId: relatedOrders[0]?.id || 'missing' }
    });

    console.log('\n--- TEST RESULTS ---');
    console.log(`Expected EXACTLY 1 SUCCESS and 1 FAILURE.`);
    const successes = (res1.status === 200 ? 1 : 0) + (res2.status === 200 ? 1 : 0);
    const errors = (res1.status !== 200 ? 1 : 0) + (res2.status !== 200 ? 1 : 0);
    
    if (successes === 1 && errors === 1) {
      console.log('✅ API Concurrency Protection: PASS');
    } else {
      console.log('❌ API Concurrency Protection: FAIL');
    }

    console.log(`\nDatabase verification:`);
    console.log(`Related Orders found: ${relatedOrders.length} (Expected 1)`);
    console.log(`Related Invoices found: ${totalInvoices.length} (Expected 1)`);
    
  } catch (error) {
    console.error('Test failed to run:', error);
  } finally {
    await prisma.$disconnect();
  }
}

runTest();
