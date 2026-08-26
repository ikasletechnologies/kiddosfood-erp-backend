import { PrismaClient } from '@prisma/client';
import { ProcurementService } from './src/modules/procurement/procurement.service';
import { GRNService } from './src/modules/grn/grn.service';
import { VendorInvoiceService } from './src/modules/vendor-invoices/vendor-invoices.service';

const prisma = new PrismaClient();

async function runAudit() {
  try {
    // 1. Create a Vendor
    const vendor = await prisma.vendor.create({
      data: {
        name: 'Audit Test Vendor',
        contact: '1234567890',
        type: 'SUPPLIER',
        status: 'ACTIVE'
      }
    });

    // 2. Create an Inventory Item
    const item = await prisma.inventoryItem.create({
      data: {
        name: 'Audit Test Material',
        sku: 'AUDIT-123',
        category: 'RAW_MATERIAL',
        unit: 'KG',
        basePrice: 10
      }
    });

    // 3. Create a PO: 10 KG @ 10 = 100, Discount 20, Tax 0 = 80 total?
    // Wait, let's follow the user's "PO 120" example.
    // 10 KG @ 12 = 120, Tax 0, Discount 0 = 120
    const po = await ProcurementService.createPurchaseOrder({
      vendorId: vendor.id,
      deliveryDate: new Date().toISOString(),
      items: [
        { inventoryItemId: item.id, quantity: 10, price: 12, unit: 'KG' }
      ],
      discountAmount: 20 // let's add a discount of 20 to test! Subtotal 120 - 20 = 100
    });
    console.log(`Created PO: subtotal ${po.subtotal}, discount ${po.discountAmount}, totalAmount ${po.totalAmount}`);

    // 4. Create GRN
    const grn = await GRNService.create(po.id, {
      items: [
        { materialId: item.id, receivedQty: 10, acceptedQty: 8, unit: 'KG' } // reject 2 KG
      ]
    });
    console.log(`Created GRN: ${grn.id}`);

    // 5. Approve GRN (this generates Purchase Bill)
    await GRNService.approve(grn.id);
    console.log(`Approved GRN. Purchase Bill should be generated.`);

    // 6. Inspect Purchase Bill
    const bill = await prisma.vendorInvoice.findFirst({ where: { poId: po.id } });
    console.log(`Purchase Bill Generated: amount ${bill?.amount}, subtotal ${bill?.subtotal}`);

    // 7. Inspect Vendor Ledger
    const ledger = await prisma.vendorLedger.findMany({ where: { vendorId: vendor.id } });
    console.log(`Vendor Ledger Entries:`);
    ledger.forEach(l => console.log(` - ${l.type} ${l.amount} (ref: ${l.referenceType})`));

    // Cleanup
    await prisma.vendorLedger.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.vendorInvoice.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.goodsReceiptItem.deleteMany({ where: { grn: { poId: po.id } } });
    await prisma.goodsReceipt.deleteMany({ where: { poId: po.id } });
    await prisma.procurementOrderItem.deleteMany({ where: { poId: po.id } });
    await prisma.procurementOrder.deleteMany({ where: { id: po.id } });
    await prisma.inventoryItem.deleteMany({ where: { id: item.id } });
    await prisma.vendor.deleteMany({ where: { id: vendor.id } });

  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

runAudit();
