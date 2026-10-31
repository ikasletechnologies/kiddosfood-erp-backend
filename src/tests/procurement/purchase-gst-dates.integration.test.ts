import assert from 'node:assert/strict';
import prisma from '../../lib/prisma';
import { withRollback } from '../with-rollback';
import { ProcurementService } from '../../modules/procurement/procurement.service';
import { GRNService } from '../../modules/grn/grn.service';
import { VendorInvoiceService } from '../../modules/vendor-invoices/vendor-invoices.service';
import { PurchaseService } from '../../modules/purchase/purchase.service';
import { purchaseGstRate } from '../../modules/procurement/purchase-tax';
import { purchaseBusinessDate, validateDeliveryDate } from '../../modules/procurement/purchase-dates';

async function main() {
  assert.equal(purchaseBusinessDate(new Date('2026-10-30T18:29:59Z')),'2026-10-30');
  assert.equal(purchaseBusinessDate(new Date('2026-10-30T18:30:00Z')),'2026-10-31');
  const fixed=new Date('2026-10-31T10:00:00Z');
  assert.equal(validateDeliveryDate('2026-10-31','2026-10-31',fixed).toISOString(),'2026-10-30T18:30:00.000Z');
  assert.doesNotThrow(()=>validateDeliveryDate('2026-11-05','2026-10-31',fixed));
  for(const day of ['2026-10-30','2026-02-30','',undefined])assert.throws(()=>validateDeliveryDate(day,'2026-10-31',fixed));
  for(const rate of [undefined,null,'',NaN,-1,101,false])assert.throws(()=>purchaseGstRate(rate));
  assert.equal(purchaseGstRate(0),0);
  const tag=`GST-DATE-${Date.now()}`;
  await withRollback(async tx=>{
    const today=purchaseBusinessDate();
    const warehouse=await tx.warehouse.create({data:{name:tag,nameKey:tag.toLowerCase()}});
    for(const rate of [0,5,12,18,28,2.5]){
      const vendor=await tx.vendor.create({data:{name:`${tag}-${rate}`,contact:'9000000000',state:'Tamil Nadu'}});
      const item=await tx.inventoryItem.create({data:{name:`${tag}-${rate}`,sku:`${tag}-${rate}`,category:'RAW_MATERIAL',unit:'PC',currentStock:0,gstRate:18}});
      const payload={vendorId:vendor.id,warehouseId:warehouse.id,purchaseDate:today,expectedDeliveryDate:today,items:[{inventoryItemId:item.id,quantity:10,price:10,unit:'PC',gstRate:rate}]};
      const po=await ProcurementService.createPurchaseOrder(payload);
      const total=Number((100+rate).toFixed(2));
      assert.equal(po.status,'APPROVED');assert.equal(po.totalAmount,total);assert.equal(po.poItems[0].gstRate,rate);
      assert.equal(purchaseBusinessDate(po.createdAt),today);
      assert.equal(purchaseBusinessDate(po.expectedDeliveryDate!),today);
      await assert.rejects(()=>ProcurementService.createPurchaseOrder({...payload,expectedDeliveryDate:'2020-01-01'}),/Expected Delivery/);
      await assert.rejects(()=>ProcurementService.createPurchaseOrder({...payload,purchaseDate:'2020-01-01'}),/Purchase Date/);
      await assert.rejects(()=>ProcurementService.createPurchaseOrder({...payload,expectedDeliveryDate:undefined}),/required/);
      await assert.rejects(()=>ProcurementService.createPurchaseOrder({...payload,items:[{...payload.items[0],gstRate:undefined}]}),/explicit GST/);
      await assert.rejects(()=>ProcurementService.createPurchaseOrder({...payload,manualTax:{cgst:99,sgst:99,igst:0}}),/tax amounts/);
      const grn=await GRNService.createFromPO(po.id,{items:[{materialId:item.id,orderedQty:10,receivedQty:10,acceptedQty:10,rejectedQty:0,price:10,warehouseId:warehouse.id,expDate:'2099-12-31'}]});
      await GRNService.approve(grn.id);
      const listed=(await GRNService.getAll()).find(g=>g.id===grn.id)!;
      assert.equal(listed.procurementOrder.poItems[0].gstRate,rate,'GRN history must carry the saved PO rate, not master 18%');
      const bill=await tx.vendorInvoice.findFirstOrThrow({where:{grnId:grn.id}});
      assert.equal(bill.subtotal,100);assert.equal(bill.taxAmount,rate);assert.equal(bill.amount,total);
      const credit=await tx.vendorLedger.findFirstOrThrow({where:{invoiceId:bill.id,referenceType:'PURCHASE'}});
      assert.equal(credit.amount,total);
      const beforeBill=await tx.vendorInvoice.findUnique({where:{id:bill.id}});
      await VendorInvoiceService.create({vendorId:vendor.id,poId:po.id,grnId:grn.id,amount:999,taxAmount:999});
      const ordersBefore = await tx.procurementOrder.count();
      await VendorInvoiceService.create({vendorId:vendor.id,grnId:grn.id,amount:999,taxAmount:999});
      assert.equal(await tx.procurementOrder.count(),ordersBefore,'GRN-only bill requests must reuse the original PO');
      assert.deepEqual(await tx.vendorInvoice.findUnique({where:{id:bill.id}}),beforeBill,'Reopening a posted bill must preserve its amount and reference');
      await assert.rejects(()=>VendorInvoiceService.create({vendorId:vendor.id,poId:po.id,grnId:grn.id,amount:1,discountAmount:1}),/already posted/);
      const lot=await tx.inventoryBatch.findFirstOrThrow({where:{goodsReceiptItemId:grn.items[0].id}});
      const ret=await PurchaseService.createPurchaseReturn({vendorId:vendor.id,procurementOrderId:po.id,status:'COMPLETED',reason:'GST regression return',items:[{itemName:item.name,materialId:item.id,inventoryBatchId:lot.id,quantity:10,unit:'PC',rate:999}]});
      const saved=await tx.purchaseReturn.findUniqueOrThrow({where:{id:ret.id}});
      assert.equal(saved.taxableValue,100);assert.equal(saved.taxAmount,rate);assert.equal(saved.gstRate,rate);
      const debit=await tx.vendorLedger.findFirstOrThrow({where:{referenceType:'RETURN',referenceId:saved.returnNumber}});
      assert.equal(debit.amount,total);
      assert.equal(await ProcurementService.getVendorBalance(vendor.id),0);
      assert.equal((await tx.inventoryItem.findUniqueOrThrow({where:{id:item.id}})).gstRate,18);
      if(rate===0){
        const partialPO=await ProcurementService.createPurchaseOrder(payload);
        const partialGRN=await GRNService.createFromPO(partialPO.id,{items:[{materialId:item.id,orderedQty:10,receivedQty:10,acceptedQty:6,rejectedQty:4,price:10,warehouseId:warehouse.id,expDate:'2099-12-31'}]});
        await GRNService.approve(partialGRN.id);
        const partialBill=await tx.vendorInvoice.findFirstOrThrow({where:{grnId:partialGRN.id}});
        assert.equal(partialBill.subtotal,60);assert.equal(partialBill.taxAmount,0);assert.equal(partialBill.amount,60);
        const partialLot=await tx.inventoryBatch.findFirstOrThrow({where:{goodsReceiptItemId:partialGRN.items[0].id}});
        const partialReturn=await PurchaseService.createPurchaseReturn({vendorId:vendor.id,procurementOrderId:partialPO.id,status:'COMPLETED',reason:'Accepted quantity return',items:[{itemName:item.name,materialId:item.id,inventoryBatchId:partialLot.id,quantity:6,unit:'PC',rate:10}]});
        assert.equal((await tx.purchaseReturn.findUniqueOrThrow({where:{id:partialReturn.id}})).taxAmount,0);
        assert.equal(await ProcurementService.getVendorBalance(vendor.id),0);
        const oldDate=new Date('2020-01-02T10:00:00Z');
        const historical=await tx.procurementOrder.create({data:{vendorId:vendor.id,status:'APPROVED',totalAmount:0,createdAt:oldDate,expectedDeliveryDate:oldDate}});
        await ProcurementService.updatePO(historical.id,{notes:'Keep original dates',purchaseDate:'2020-01-02',expectedDeliveryDate:'2020-01-02'});
        const unchanged=await tx.procurementOrder.findUniqueOrThrow({where:{id:historical.id}});
        assert.equal(unchanged.createdAt.toISOString(),oldDate.toISOString());assert.equal(unchanged.expectedDeliveryDate!.toISOString(),oldDate.toISOString());
        await assert.rejects(()=>ProcurementService.updatePO(historical.id,{purchaseDate:today}),/cannot be changed/);
        await assert.rejects(()=>ProcurementService.updatePO(historical.id,{expectedDeliveryDate:'2020-01-03'}),/Expected Delivery/);
      }
    }
  });
  assert.equal(await prisma.vendor.count({where:{name:{startsWith:tag}}}),0);
  console.log('PASS: 0/5/12/18/28/2.5% PO -> GRN -> Bill -> Ledger -> full lot return; no master GST fallback; posted bill immutable; IST midnight/current/future/past dates and historical dates; fixtures rolled back');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>prisma.$disconnect());
