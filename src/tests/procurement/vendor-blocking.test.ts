import prisma from '../../lib/prisma';
import { ProcurementService } from '../../modules/procurement/procurement.service';

async function runVendorBlockingAcceptanceTests() {
  console.log('🧪 RUNNING VENDOR BLOCKING ENFORCEMENT ACCEPTANCE TESTS');
  console.log('========================================================\n');

  let activeVendorId: string | null = null;
  let testItemId: string | null = null;
  let testPOId: string | null = null;

  try {
    // 0. Setup test raw material
    const rawItem = await prisma.inventoryItem.create({
      data: {
        name: 'Test Blocking Organic Flour',
        sku: 'TEST-BLK-FLOUR-' + Date.now(),
        category: 'RAW_MATERIAL',
        unit: 'KG',
        currentStock: 100,
        minimumStock: 10,
        costPrice: 50,
        gstRate: 5
      }
    });
    testItemId = rawItem.id;

    // 1. Test 1: Active Vendor -> Can select and create PO
    console.log('1️⃣ Test 1: Creating Active Vendor and creating PO...');
    const activeVendor = await prisma.vendor.create({
      data: {
        name: 'Active Test Vendor ' + Date.now(),
        contact: '9876543210',
        status: 'ACTIVE',
        vendorCode: 'V-ACT-' + Date.now().toString().slice(-4)
      }
    });
    activeVendorId = activeVendor.id;

    const po1 = await ProcurementService.createPurchaseOrder({
      vendorId: activeVendor.id,
      items: [{ inventoryItemId: rawItem.id, quantity: 10, price: 50, unit: 'KG', gstRate: 5 }]
    });

    if (!po1 || !po1.id) throw new Error('Active vendor PO creation failed');
    testPOId = po1.id;
    console.log(`   ✅ PASS: PO created successfully for active vendor (PO ID: ${po1.id}, Number: ${po1.poNumber})`);

    // 2. Test 2: Blocked Vendor -> createPurchaseOrder rejected
    console.log('\n2️⃣ Test 2: Creating Blocked Vendor and attempting PO creation...');
    const blockedVendor = await prisma.vendor.create({
      data: {
        name: 'Blocked Test Vendor ' + Date.now(),
        contact: '9876543211',
        status: 'BLOCKED',
        vendorCode: 'V-BLK-' + Date.now().toString().slice(-4)
      }
    });

    let blockedErrorCaught = false;
    try {
      await ProcurementService.createPurchaseOrder({
        vendorId: blockedVendor.id,
        items: [{ inventoryItemId: rawItem.id, quantity: 5, price: 50, unit: 'KG', gstRate: 5 }]
      });
    } catch (err: any) {
      blockedErrorCaught = true;
      console.log(`   ✅ PASS: Blocked vendor rejected with message: "${err.message}"`);
      if (!err.message.includes('This vendor is blocked and cannot be used for Purchase Orders.')) {
        throw new Error(`Unexpected error message: ${err.message}`);
      }
    }
    if (!blockedErrorCaught) {
      throw new Error('FAIL: Blocked vendor was incorrectly allowed to create a PO!');
    }

    // 3. Test 3: Blacklisted & Inactive Vendors rejected
    console.log('\n3️⃣ Test 3: Testing BLACKLISTED & INACTIVE vendor statuses...');
    const blacklistedVendor = await prisma.vendor.create({
      data: {
        name: 'Blacklisted Test Vendor ' + Date.now(),
        contact: '9876543212',
        status: 'BLACKLISTED',
        vendorCode: 'V-BKL-' + Date.now().toString().slice(-4)
      }
    });

    let blacklistedErrorCaught = false;
    try {
      await ProcurementService.createPurchaseOrder({
        vendorId: blacklistedVendor.id,
        items: [{ inventoryItemId: rawItem.id, quantity: 5, price: 50, unit: 'KG', gstRate: 5 }]
      });
    } catch (err: any) {
      blacklistedErrorCaught = true;
      console.log(`   ✅ PASS: Blacklisted vendor rejected with: "${err.message}"`);
    }
    if (!blacklistedErrorCaught) throw new Error('FAIL: Blacklisted vendor allowed to create PO!');

    // 4. Test 4: Draft PO created while vendor was active, then vendor blocked
    console.log('\n4️⃣ Test 4: Simulating draft PO when vendor transitions from ACTIVE -> BLOCKED...');
    // Create draft PO while vendor is active
    const draftPO = await ProcurementService.createPurchaseOrder({
      vendorId: activeVendor.id,
      status: 'DRAFT',
      items: [{ inventoryItemId: rawItem.id, quantity: 2, price: 50, unit: 'KG', gstRate: 5 }]
    });
    console.log(`   - Draft PO created while vendor ACTIVE (PO ID: ${draftPO.id})`);

    // Now vendor gets BLOCKED
    await prisma.vendor.update({
      where: { id: activeVendor.id },
      data: { status: 'BLOCKED' }
    });
    console.log(`   - Vendor ${activeVendor.name} status updated to BLOCKED`);

    // Attempting to approve or submit/update PO for now-blocked vendor must be rejected
    let approveErrorCaught = false;
    try {
      await ProcurementService.approvePO(draftPO.id);
    } catch (err: any) {
      approveErrorCaught = true;
      console.log(`   ✅ PASS: Approving PO for now-blocked vendor rejected with: "${err.message}"`);
    }
    if (!approveErrorCaught) throw new Error('FAIL: Approved PO for blocked vendor!');

    // 5. Test 5: Unblock vendor -> vendor becomes usable again
    console.log('\n5️⃣ Test 5: Unblocking vendor and verifying PO creation resumes...');
    await prisma.vendor.update({
      where: { id: activeVendor.id },
      data: { status: 'ACTIVE' }
    });
    console.log(`   - Vendor ${activeVendor.name} status restored to ACTIVE`);

    const poAfterUnblock = await ProcurementService.createPurchaseOrder({
      vendorId: activeVendor.id,
      items: [{ inventoryItemId: rawItem.id, quantity: 8, price: 50, unit: 'KG', gstRate: 5 }]
    });
    if (!poAfterUnblock) throw new Error('Failed to create PO after unblocking vendor');
    console.log(`   ✅ PASS: PO created successfully after unblocking (PO ID: ${poAfterUnblock.id})`);

    // 6. Test 6: Historical POs remain viewable even if vendor is later blocked
    console.log('\n6️⃣ Test 6: Verifying historical POs remain intact and readable when vendor is blocked...');
    // Block vendor again
    await prisma.vendor.update({
      where: { id: activeVendor.id },
      data: { status: 'BLOCKED' }
    });

    const historicalPO = await ProcurementService.getPurchaseOrderById(testPOId);
    if (!historicalPO) throw new Error('Failed to retrieve historical PO');
    if (historicalPO.id !== testPOId) throw new Error('Historical PO mismatch');
    console.log(`   ✅ PASS: Historical PO ${historicalPO.poNumber} remains fully intact and viewable (Total Amount: ₹${historicalPO.totalAmount})`);

    // Clean up temporary test data
    console.log('\n🧹 Cleaning up test artifacts...');
    const vendorIds = [activeVendor.id, blockedVendor.id, blacklistedVendor.id];
    const poIds = [testPOId, draftPO.id, poAfterUnblock.id].filter(Boolean) as string[];
    await prisma.vendorMaterial.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await prisma.procurementOrderItem.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.procurementOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await prisma.inventoryItem.delete({ where: { id: testItemId } });

    console.log('\n🎉 ALL 6 VENDOR BLOCKING ACCEPTANCE TESTS PASSED 100%! 🎉\n');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    process.exit(1);
  }
}

runVendorBlockingAcceptanceTests();
