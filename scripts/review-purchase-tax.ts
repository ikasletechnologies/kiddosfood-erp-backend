import { writeFileSync } from 'node:fs';
import prisma from '../src/lib/prisma';
import { VendorInvoiceService } from '../src/modules/vendor-invoices/vendor-invoices.service';
import { resolveSellerState } from '../src/utils/gst-tax.util';

async function main() {
  const report = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const bills = await tx.vendorInvoice.findMany({ include:{ procurementOrder:{include:{poItems:true,vendor:{select:{state:true}}}}, grn:{include:{items:true}}, ledgerEntries:true } });
    const sellerState = await resolveSellerState(null);
    const findings:any[]=[];
    for(const bill of bills){
      if(!bill.grn)continue;
      try{
        const expected=VendorInvoiceService.computeCommercialsFromPO(bill.procurementOrder,bill.grn.items,bill.procurementOrder.vendor?.state,sellerState);
        const actualTax=bill.taxAmount ?? ((bill.cgst??0)+(bill.sgst??0)+(bill.igst??0));
        if(Math.abs(actualTax-expected.taxAmount)>0.011)findings.push({type:'BILL_TAX_MISMATCH',billId:bill.id,billNumber:bill.invoiceNumber,poId:bill.poId,grnId:bill.grnId,currentTax:actualTax,expectedTax:expected.taxAmount,currentAmount:bill.amount,suggestedAmount:bill.amount-actualTax+expected.taxAmount,ledgerReferences:bill.ledgerEntries.map(l=>({id:l.id,reference:l.referenceId,amount:l.amount,type:l.type}))});
        for(const entry of bill.ledgerEntries)if(entry.referenceType==='PURCHASE'&&Math.abs(entry.amount-bill.amount)>0.011)findings.push({type:'BILL_LEDGER_MISMATCH',billId:bill.id,billNumber:bill.invoiceNumber,ledgerId:entry.id,ledgerAmount:entry.amount,billAmount:bill.amount});
      }catch(e:any){findings.push({type:'MISSING_OR_AMBIGUOUS_SNAPSHOT',billId:bill.id,billNumber:bill.invoiceNumber,reason:e.message});}
    }
    const grns=await tx.goodsReceipt.findMany({where:{status:'COMPLETED'},include:{procurementOrder:{include:{poItems:{include:{inventoryItem:{select:{name:true,gstRate:true}}}}}},items:true}});
    const zeroGstGrns=grns.filter(g=>g.procurementOrder.poItems.some(p=>p.gstRate===0)).map(g=>({grnId:g.id,poId:g.poId,zeroRateLines:g.procurementOrder.poItems.filter(p=>p.gstRate===0).map(p=>({poLineId:p.id,materialId:p.inventoryItemId,name:p.itemName??p.inventoryItem?.name,savedGstRate:p.gstRate,currentMasterGst:p.inventoryItem?.gstRate}))}));
    const returns=await tx.purchaseReturn.findMany({where:{status:'COMPLETED'},include:{procurementOrder:{include:{poItems:true}},items:true}});
    for(const r of returns)if(r.procurementOrder?.poItems.length&&r.procurementOrder.poItems.every(p=>p.gstRate===0)&&Number(r.taxAmount??0)>0.011)findings.push({type:'ZERO_GST_RETURN_TAX',returnId:r.id,returnNumber:r.returnNumber,poId:r.procurementOrderId,currentTax:r.taxAmount,expectedTax:0});
    const testPOs=await tx.procurementOrder.findMany({where:{poItems:{some:{OR:[{itemName:{equals:'TEST',mode:'insensitive'}},{inventoryItem:{name:{equals:'TEST',mode:'insensitive'}}}]}}},select:{id:true,poNumber:true,createdAt:true,subtotal:true,cgst:true,sgst:true,igst:true,totalAmount:true,poItems:{select:{id:true,itemName:true,gstRate:true,subtotal:true,total:true}}}});
    return {generatedAt:new Date().toISOString(),readOnly:true,billsReviewed:bills.length,completedGrnsReviewed:grns.length,postedFinancialCandidates:findings.length,findings,zeroGstGrns,testPOs,correctionApplied:false,limitations:'A consistently stored 5% PO cannot prove that a user originally intended 0%. Source-entry evidence is needed. Mixed-rate returns without source lot/PO identities require manual review. Posted records are never repaired by this report.',procedure:'Review exact original PO line snapshots, GRN accepted quantities, bill, return and ledger references; obtain explicit Super Admin approval for a specific correction; retain original rows and references and record linked compensating adjustments and an audit entry. Vendor ledger adjustment alone does not correct GST reporting. A separately approved tax-report correction plan is required for genuinely misposted tax.'};
  });
  writeFileSync('docs/purchase-tax-review.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({billsReviewed:report.billsReviewed,completedGrnsReviewed:report.completedGrnsReviewed,postedFinancialCandidates:report.postedFinancialCandidates,zeroGstGrns:report.zeroGstGrns.length,testPOs:report.testPOs.length,report:'docs/purchase-tax-review.json'}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>prisma.$disconnect());
