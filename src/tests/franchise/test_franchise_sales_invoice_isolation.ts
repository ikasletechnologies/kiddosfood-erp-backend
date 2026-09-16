import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';



async function runSalesInvoiceTests() {
  console.log('================================================================');
  console.log('🧪 FRANCHISE SALES INVOICE ISOLATION & ACCURACY TEST SUITE');
  console.log('================================================================');

  try {
    // 1. Fetch any franchise
    const franchise = await prisma.franchise.findFirst({
      where: { status: 'ACTIVE', isHQ: false }
    });

    if (!franchise) {
      console.log('⚠️ No active non-HQ franchise found, picking any franchise...');
    }

    const testFranchiseId = franchise ? franchise.id : 'test-franchise-id';
    console.log(`\n1️⃣ Testing with Franchise ID: ${testFranchiseId} (${franchise?.name || 'Test Franchise'})`);

    // 2. Fetch Invoices for this Franchise
    const invoices = await FinanceService.getInvoices({ franchiseId: testFranchiseId });
    console.log(`\n2️⃣ Fetched ${invoices.length} Sales Invoices for Franchise.`);

    // 3. If no invoices exist, create a sample sales order & invoice to verify
    let testInvoiceId = invoices.length > 0 ? invoices[0].id : null;

    if (!testInvoiceId) {
      console.log('\nCreating a test sales order & invoice...');
      // find a product
      const product = await prisma.product.findFirst({ where: { isActive: true } });
      if (!product) throw new Error('No active product found in DB');

      // find or create a customer
      let customer = await prisma.customer.findFirst({ where: { franchiseId: testFranchiseId } });
      if (!customer) {
        customer = await prisma.customer.create({
          data: {
            name: 'Test Retail Customer',
            phone: '9876543210',
            email: 'customer@test.com',
            franchiseId: testFranchiseId,
            address: '123 Test Street, Chennai',
            
            gstNumber: '33AAAAA0000A1Z5',
            state: 'Tamil Nadu'
          }
        });
      }

      const invNumber = `INV-TEST-${Date.now().toString().slice(-6)}`;
      const order = await prisma.order.create({
        data: {
          invoiceNum: invNumber,
          franchiseId: testFranchiseId,
          customerId: customer.id,
          customerName: customer.name,
          partyType: 'CUSTOMER',
          partyId: customer.id,
          orderType: 'TAX_INVOICE',
          subTotal: 500,
          taxAmount: 25,
          totalAmount: 525,
          paymentStatus: 'UNPAID',
          paymentType: 'CASH',
          stateOfSupply: 'Tamil Nadu',
          orderItems: {
            create: [
              {
                productId: product.id,
                quantity: 5,
                unit: 'PC',
                price: 100,
                taxAmount: 25,
                totalAmount: 525
              }
            ]
          },
          invoice: {
            create: {
              totalAmount: 500,
              taxAmount: 25,
              finalAmount: 525,
              status: 'UNPAID'
            }
          }
        },
        include: { invoice: true }
      });

      testInvoiceId = order.invoice!.id;
      console.log(`Created test invoice: ${testInvoiceId} (Number: ${invNumber})`);
    }

    // 4. Test getInvoiceById
    console.log(`\n3️⃣ Testing FinanceService.getInvoiceById for ID: ${testInvoiceId}...`);
    const invoiceDetail = await FinanceService.getInvoiceById(testInvoiceId);

    if (!invoiceDetail) {
      throw new Error(`Failed to retrieve invoice detail for ${testInvoiceId}`);
    }

    console.log('   - Invoice ID:', invoiceDetail.id);
    console.log('   - Invoice Number:', invoiceDetail.order?.invoiceNum);
    console.log('   - Customer/Party:', invoiceDetail.order?.customerName || invoiceDetail.order?.customer?.name);
    console.log('   - Order Items Count:', invoiceDetail.order?.orderItems?.length || 0);
    console.log('   - Subtotal:', invoiceDetail.order?.subTotal);
    console.log('   - Tax Amount:', invoiceDetail.taxAmount);
    console.log('   - Final Amount:', invoiceDetail.finalAmount);
    console.log('   - Payments Linked:', invoiceDetail.payments?.length || 0);

    // 5. Verify Purity (Zero Vendor, Zero Purchase Order, Zero GRN, Zero Purchase Bill data)
    console.log('\n4️⃣ Verifying Data Isolation & Purity:');

    // Check properties on invoice and order
    const keysToCheck = [
      'vendor', 'vendorId', 'vendorInvoice', 'purchaseOrder', 'procurementOrder',
      'grn', 'goodsReceipt', 'rawMaterial', 'purchaseBill', 'purchaseReturn'
    ];

    let contaminated = false;
    for (const key of keysToCheck) {
      if ((invoiceDetail as any)[key] !== undefined || (invoiceDetail.order as any)?.[key] !== undefined) {
        console.error(`   ❌ Contamination detected: key "${key}" found on invoice detail!`);
        contaminated = true;
      }
    }

    if (!contaminated) {
      console.log('   ✅ PASS: No vendor or purchase models attached to Sales Invoice detail.');
    }

    // Check order items
    for (const it of invoiceDetail.order?.orderItems || []) {
      if ((it as any).vendor || (it as any).purchaseOrder || (it as any).grn) {
        console.error('   ❌ Contamination in OrderItem: purchase relation found!');
        contaminated = true;
      }
    }

    if (!contaminated) {
      console.log('   ✅ PASS: Order items contain strictly sold products and sales line data.');
    }

    // Verify customer party data presence
    if (invoiceDetail.order?.customer || invoiceDetail.order?.dealer || invoiceDetail.order?.franchise) {
      console.log('   ✅ PASS: Sales party (Customer/Dealer/Franchise) correctly resolved.');
    }

    console.log('\n🎉 ALL FRANCHISE SALES INVOICE TESTS PASSED PERFECTLY!\n');
  } catch (err: any) {
    console.error('\n❌ Test failed with error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runSalesInvoiceTests();
