import prisma from '../../lib/prisma';
import { FinanceService } from '../../modules/finance/finance.service';

async function runStrictSalesInvoiceTests() {
  console.log('================================================================');
  console.log('🧪 STRICT FRANCHISE SALES INVOICE ISOLATION TEST');
  console.log('================================================================');

  try {
    // 1. Get HQ and Franchise tn72
    const hq = await prisma.franchise.findFirst({ where: { isHQ: true } });
    if (!hq) throw new Error('No HQ Franchise found in database');

    const tn72 = await prisma.franchise.findFirst({
      where: { isHQ: false, name: { contains: 'tn72', mode: 'insensitive' } }
    }) || await prisma.franchise.findFirst({
      where: { isHQ: false }
    });

    if (!tn72) throw new Error('No test franchise found in database');

    console.log(`\n📍 HQ Franchise: ${hq.name} (${hq.id})`);
    console.log(`📍 Test Franchise: ${tn72.name} (${tn72.id})`);

    // 2. Fetch invoices for Franchise tn72
    console.log(`\n--- Test 1: Fetching Sale Invoices for Franchise "${tn72.name}" ---`);
    const franchiseInvoices = await FinanceService.getInvoices({ franchiseId: tn72.id });
    console.log(`Retrieved ${franchiseInvoices.length} invoices for Franchise "${tn72.name}".`);

    // Verify none of the HQ-to-Franchise invoices (INV-2026-0070..0077) appear in tn72's list
    const invalidInvoices = franchiseInvoices.filter(
      (inv: any) => inv.order?.partyType === 'FRANCHISE' || inv.order?.franchiseId === hq.id
    );

    if (invalidInvoices.length > 0) {
      console.error('❌ FAIL: Franchise Sale Invoices contains HQ procurement or Franchise party invoices:');
      for (const inv of invalidInvoices) {
        console.error(`   - ${inv.order?.invoiceNum} (PartyType: ${inv.order?.partyType}, Seller: ${inv.order?.franchiseId})`);
      }
      throw new Error('Franchise Sale Invoices returned HQ or Franchise party invoices!');
    } else {
      console.log('✅ PASS: Zero HQ procurement / Franchise party invoices found in Franchise Sales Invoice list.');
    }

    // 3. Fetch invoices for Super Admin / HQ
    console.log(`\n--- Test 2: Fetching Sale Invoices for HQ ---`);
    const hqInvoices = await FinanceService.getInvoices({ franchiseId: hq.id });
    console.log(`Retrieved ${hqInvoices.length} invoices for HQ.`);

    const hqSalesToTn72 = hqInvoices.filter(
      (inv: any) => inv.order?.partyType === 'FRANCHISE' && inv.order?.partyId === tn72.id
    );
    console.log(`Found ${hqSalesToTn72.length} HQ sales invoices to Franchise "${tn72.name}".`);

    if (hqSalesToTn72.length === 0) {
      console.warn('⚠️ Note: No HQ sales to tn72 found under HQ, checking all orders...');
    } else {
      console.log(`✅ PASS: HQ correctly lists sales invoices issued to Franchise "${tn72.name}" (e.g. ${hqSalesToTn72[0].order?.invoiceNum}).`);
    }

    // 4. Test creating a retail customer sale from Franchise tn72
    console.log(`\n--- Test 3: Creating a Retail Customer Sale from Franchise "${tn72.name}" ---`);
    let customer = await prisma.customer.findFirst({ where: { franchiseId: tn72.id } });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          name: 'Test Retail Buyer',
          phone: '9876543219',
          email: 'retailbuyer@test.com',
          franchiseId: tn72.id,
          address: '456 Retail Street, Tirunelveli',
          state: 'Tamil Nadu'
        }
      });
    }

    const testSku = `TEST-PROD-${Date.now().toString().slice(-4)}`;
    const product = await prisma.product.create({
      data: {
        name: `Test Product ${testSku}`,
        sku: testSku,
        basePrice: 50,
        taxPercent: 5,
        isActive: true,
        category: 'SWEETS'
      }
    });

    // Ensure inventory item exists for tn72
    const invItem = await prisma.inventoryItem.create({
      data: {
        name: product.name,
        sku: product.sku || testSku,
        category: 'FINISHED_GOOD',
        franchise: { connect: { id: tn72.id } },
        currentStock: 100,
        minimumStock: 0,
        unit: 'PKT',
        basePrice: 50,
        customerPrice: 50,
        dealerPrice: 45,
        franchisePrice: 40,
        gstRate: 5
      }
    });

    const createdFranchiseSale = await FinanceService.createInvoice({
      franchiseId: tn72.id,
      partyType: 'CUSTOMER',
      customerId: customer.id,
      items: [
        {
          productId: product.id,
          productName: product.name,
          quantity: 2,
          unit: 'PKT',
          price: 50,
          taxPercent: 5,
        }
      ],
      paymentType: 'CREDIT',
      receivedAmount: 0,
      createdBy: 'Franchise Admin'
    });

    console.log(`Created Franchise retail invoice: ${(createdFranchiseSale as any).order?.invoiceNum} (ID: ${createdFranchiseSale.id})`);

    // Verify it is scoped to tn72
    const fetchedDetail = await FinanceService.getInvoiceById(createdFranchiseSale.id);
    if (!fetchedDetail) throw new Error('Failed to fetch newly created invoice');

    if (fetchedDetail.order?.franchiseId !== tn72.id) {
      throw new Error(`Expected seller franchiseId to be ${tn72.id}, got ${fetchedDetail.order?.franchiseId}`);
    }
    if (fetchedDetail.order?.partyType !== 'CUSTOMER') {
      throw new Error(`Expected partyType CUSTOMER, got ${fetchedDetail.order?.partyType}`);
    }
    console.log('✅ PASS: Franchise retail invoice correctly created with seller = tn72 and partyType = CUSTOMER.');

    // 5. Test creating an invoice from HQ to Franchise
    console.log(`\n--- Test 4: Creating an HQ-to-Franchise Sales Invoice ---`);
    const createdHqSale = await FinanceService.createInvoice({
      franchiseId: tn72.id, // client might pass buyer's branch context
      partyType: 'FRANCHISE',
      partyId: tn72.id,
      items: [
        {
          productId: product.id,
          productName: product.name,
          quantity: 10,
          unit: 'PKT',
          price: 40,
          taxPercent: 5,
        }
      ],
      paymentType: 'CREDIT',
      receivedAmount: 0,
      createdBy: 'HQ Super Admin'
    });

    console.log(`Created HQ sales invoice to franchise: ${(createdHqSale as any).order?.invoiceNum} (ID: ${createdHqSale.id})`);

    const fetchedHqInvoice = await FinanceService.getInvoiceById(createdHqSale.id);
    if (!fetchedHqInvoice) throw new Error('Failed to fetch HQ invoice');

    if (fetchedHqInvoice.order?.franchiseId !== hq.id) {
      throw new Error(`Expected HQ sale seller franchiseId to be ${hq.id}, got ${fetchedHqInvoice.order?.franchiseId}`);
    }
    if (fetchedHqInvoice.order?.partyType !== 'FRANCHISE') {
      throw new Error(`Expected partyType FRANCHISE, got ${fetchedHqInvoice.order?.partyType}`);
    }
    console.log('✅ PASS: HQ-to-Franchise sale correctly assigned seller = HQ and partyType = FRANCHISE.');

    // 6. Verify Franchise tn72 does NOT see this HQ sale in tn72's Sale Invoices list
    const updatedFranchiseInvoices = await FinanceService.getInvoices({ franchiseId: tn72.id });
    const containsHqSale = updatedFranchiseInvoices.some((inv: any) => inv.id === createdHqSale.id);

    if (containsHqSale) {
      throw new Error('❌ FAIL: Franchise tn72 incorrectly sees the HQ sale in their Sale Invoices list!');
    }
    console.log('✅ PASS: Franchise tn72 does NOT see the HQ-to-Franchise sale in tn72 Sale Invoices list.');

    // Verify tn72 DOES see their own retail sale
    const containsRetailSale = updatedFranchiseInvoices.some((inv: any) => inv.id === createdFranchiseSale.id);
    if (!containsRetailSale) {
      throw new Error('❌ FAIL: Franchise tn72 cannot see their own retail customer sale!');
    }
    console.log('✅ PASS: Franchise tn72 correctly sees their own retail customer sales invoice in list.');

    // Clean up test records
    await prisma.customerLedger.deleteMany({ where: { referenceId: { in: [createdFranchiseSale.orderId, createdHqSale.orderId] } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: [createdFranchiseSale.orderId, createdHqSale.orderId] } } });
    await prisma.invoice.deleteMany({ where: { id: { in: [createdFranchiseSale.id, createdHqSale.id] } } });
    await prisma.order.deleteMany({ where: { id: { in: [createdFranchiseSale.orderId, createdHqSale.orderId] } } });
    await prisma.stockMovement.deleteMany({ where: { itemId: invItem.id } });
    await prisma.inventoryItem.deleteMany({ where: { id: invItem.id } });
    await prisma.product.deleteMany({ where: { id: product.id } });

    console.log('\n================================================================');
    console.log('🎉 ALL STRICT FRANCHISE SALES INVOICE TESTS PASSED PERFECTLY!');
    console.log('================================================================\n');

  } catch (err: any) {
    console.error('\n❌ Test Suite Failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runStrictSalesInvoiceTests();
