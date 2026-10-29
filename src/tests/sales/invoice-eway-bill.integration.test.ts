import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import prisma from '../../lib/prisma';
import {EWayBillService} from '../../modules/eway-bill/ewaybill.service';
import {EWayBillController} from '../../modules/eway-bill/ewaybill.controller';
import {errorHandler} from '../../middleware/error.middleware';

test('invoice E-Way Bill source and safe draft lifecycle', {timeout:180000}, async t=>{
  const target=new URL(process.env.DATABASE_URL || '');
  assert.equal(process.env.KIDDOS_EWB_TEST_DB,'1');assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/kiddos_eway_test');
  let server:any;
  try {
    assert.equal(await prisma.invoice.count(),0,'Requires an empty disposable database');
    const admin={userId:'ewb-test',role:'SUPER_ADMIN'};
    const hq=await prisma.franchise.create({data:{name:'HQ',location:'Chennai',ownerName:'Test',contactNum:'1',isHQ:true}});
    const branch=await prisma.franchise.create({data:{name:'Upcountry Franchise',location:'Coimbatore',ownerName:'Test',contactNum:'9888800022'}});
    const customer=await prisma.customer.create({data:{name:'Customer Charity',phone:'9888800000',gstNumber:'33BBBBB0000B1Z5',address:'Billing address',shippingAddress:'Shipping address',state:'Tamil Nadu',city:'Coimbatore',pincode:'641001'}});
    const dealer=await prisma.dealer.create({data:{name:'Dealer Foods',phone:'9888800011',franchiseId:hq.id,gstNumber:'29CCCCC0000C1Z5',address:'Dealer address',state:'Karnataka',city:'Bengaluru',pincode:'560001'}});
    await prisma.systemSetting.create({data:{key:'COMPANY_PROFILE',value:JSON.stringify({companyName:'Test Foods',gstNumber:'33AAAAA0000A1Z5',address:'HQ dispatch address',city:'Chennai',pincode:'600001',state:'Tamil Nadu',phone:'44444444'})}});
    const product=await prisma.product.create({data:{name:'APPAM 500g',sku:'FG-APPA-500G',basePrice:100,taxPercent:5,hsnCode:'1905'}});
    let count=0;
    const invoice=async (partyType:any='CUSTOMER',partyId=customer.id,sellerId=hq.id) => {
      const order=await prisma.order.create({data:{invoiceNum:'INV-2026-'+String(++count).padStart(4,'0'),franchiseId:sellerId,partyType,partyId,customerId:partyType==='CUSTOMER'?customer.id:null,subTotal:100,taxAmount:5,totalAmount:105,stateOfSupply:partyType==='DEALER'?'Karnataka':'Tamil Nadu',orderItems:{create:{productId:product.id,quantity:1,unit:'PC',price:100,taxAmount:5,totalAmount:105}},invoice:{create:{totalAmount:100,taxAmount:5,finalAmount:105,status:'UNPAID'}}},include:{invoice:true}});
      return order.invoice!;
    };
    const customerInvoice=await invoice(),dealerInvoice=await invoice('DEALER',dealer.id),franchiseInvoice=await invoice('FRANCHISE',branch.id),branchInvoice=await invoice('CUSTOMER',customer.id,branch.id);
    const prepare=async (id:string) => ({...await EWayBillService.prefill(admin,'SALE_INVOICE',id),toPincode:'641004',toPlace:'Coimbatore',actToStateCode:33,actFromStateCode:33,transMode:'1',vehicleNo:'TN01AB1234',transDistance:20});
    const original=JSON.stringify(await prisma.invoice.findMany({include:{order:{include:{orderItems:true}}},orderBy:{id:'asc'}}));
    const app=express();app.use(express.json());app.use((req:any,_res,next)=>{req.user=admin;next();});
    app.get('/sources',EWayBillController.sources);app.get('/prefill',EWayBillController.prefill);app.post('/draft',EWayBillController.create);app.post('/:id/submit',EWayBillController.submit);app.use(errorHandler);
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const endpoint='http://127.0.0.1:'+server.address().port;
    await t.test('search finds stable invoice IDs by invoice, each party type and phone',async()=>{
      for(const [search,id] of [['Charity',customerInvoice.id],['9888800000',customerInvoice.id],['Dealer Foods',dealerInvoice.id],['9888800011',dealerInvoice.id],['Upcountry',franchiseInvoice.id],['9888800022',franchiseInvoice.id]]) {
        const response=await fetch(endpoint+'/sources?sourceType=SALE_INVOICE&search='+encodeURIComponent(search));const rows:any=await response.json();assert.equal(response.status,200);assert.ok(rows.some((r:any)=>r.id===id));
      }
      const own=await EWayBillService.listSources({userId:'b',role:'FRANCHISE_ADMIN',franchiseId:branch.id},'SALE_INVOICE');assert.deepEqual(own.map(r=>r.id),[branchInvoice.id]);
      await assert.rejects(EWayBillService.prefill({userId:'b',role:'FRANCHISE_ADMIN',franchiseId:branch.id},'SALE_INVOICE',customerInvoice.id),/Forbidden/);
    });
    await t.test('maps saved values, separate shipping address, correct parties and no current-price tax substitution',async()=>{
      await prisma.product.update({where:{id:product.id},data:{taxPercent:18,basePrice:999}});
      const customer:any=await EWayBillService.prefill(admin,'SALE_INVOICE',customerInvoice.id);
      assert.equal(customer.sourceId,customerInvoice.id);assert.equal(customer.docType,'INV');assert.equal(customer.supplyType,'O');assert.equal(customer.transactionType,2);
      assert.equal(customer.fromTradeName,'Test Foods');assert.equal(customer.toAddr1,'Shipping address');assert.equal(customer.sourceSummary.billingAddress,'Billing address');assert.equal(customer.toPincode,'');
      assert.equal(customer.items[0].qtyUnit,'PCS');assert.equal(customer.items[0].hsnCode,'1905');assert.equal(customer.items[0].taxableAmount,100);assert.equal(customer.items[0].cgstRate,2.5);assert.equal(customer.otherValue,0);
      const dealer:any=await EWayBillService.prefill(admin,'SALE_INVOICE',dealerInvoice.id);assert.equal(dealer.toTradeName,'Dealer Foods');assert.equal(dealer.items[0].igstRate,5);assert.equal(dealer.items[0].cgstRate,0);
      const franchise:any=await EWayBillService.prefill(admin,'SALE_INVOICE',franchiseInvoice.id);assert.equal(franchise.toTradeName,'Upcountry Franchise');assert.equal(franchise.toGstin,'URP');assert.notEqual(franchise.toGstin,franchise.fromGstin);
      const branch:any=await EWayBillService.prefill(admin,'SALE_INVOICE',branchInvoice.id);assert.equal(branch.fromTradeName,'Upcountry Franchise');assert.equal(branch.fromGstin,'');assert.ok(branch.warnings.some((w:string)=>w.includes('Branch GSTIN')));
      assert.ok(customer.warnings.some((w:string)=>w.includes('not fully fulfilled')));
      const {InvoiceEwbSource}=await import('../../modules/eway-bill/invoice-source');
      const actual=await InvoiceEwbSource.resolve(admin,customerInvoice.id);
      const alternate={...prisma,invoice:{findFirst:async()=>({...actual,order:{...actual.order,franchise:{...actual.order.franchise,primaryWarehouse:{id:'dispatch',location:'Different dispatch address'}}}})}};
      const dispatch=await InvoiceEwbSource.mapping(admin,customerInvoice.id,alternate);
      assert.equal(dispatch.payload.transactionType,4);assert.equal(dispatch.payload.fromAddr1,'Different dispatch address');assert.equal(dispatch.payload.fromPincode,'');assert.equal(dispatch.payload.actFromStateCode,null);
      await assert.rejects(EWayBillService.create(admin,{...await prepare(dealerInvoice.id),docDate:'2020-01-01'}),/date must match/);
      await assert.rejects(EWayBillService.create(admin,{...await prepare(dealerInvoice.id),actToStateCode:null}),/shipment state/);
    });
    let draft:any;
    await t.test('concurrent canonical/legacy source retries create one draft and expose existing status',async()=>{
      const payload=await prepare(customerInvoice.id);
      const responses=await Promise.all([fetch(endpoint+'/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),fetch(endpoint+'/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,sourceId:customerInvoice.orderId})})]);
      assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
      draft=await prisma.eWayBill.findFirstOrThrow({where:{sourceType:'SALE_INVOICE',sourceId:customerInvoice.id}});assert.equal(draft.status,'DRAFT');assert.equal(draft.ewbNumber,null);
      const sources:any[]=await EWayBillService.listSources(admin,'SALE_INVOICE','Charity');assert.equal(sources.find(r=>r.id===customerInvoice.id)?.existingEwb.id,draft.id);
      assert.equal((await EWayBillService.list(admin,{sourceType:'SALE_INVOICE',sourceId:customerInvoice.orderId})).length,1);
    });
    await t.test('validates and exports a draft, but never accepts a fake official confirmation without integration',async()=>{
      const validation=await EWayBillService.validateDraft(admin,draft.id);assert.equal(validation.valid,true,validation.errors.join(' '));assert.equal(validation.generationAvailable,false);
      const json:any=await EWayBillService.exportNicJson(admin,[draft.id]);assert.equal(json.billLists[0].totInvValue,105);assert.equal(json.billLists[0].cgstValue,2.5);assert.equal(json.billLists[0].itemList[0].quantity,1);
      const response=await fetch(endpoint+'/'+draft.id+'/submit',{method:'POST'});assert.equal(response.status,503);const failed:any=await response.json();assert.match(failed.message || failed.error,/No authorised/);
      await assert.rejects(EWayBillService.markGenerated(admin,draft.id,{ewbNumber:'123456789012'}),/No authorised/);
      const saved=await prisma.eWayBill.findUniqueOrThrow({where:{id:draft.id}});assert.equal(saved.status,'DRAFT');assert.equal(saved.ewbDate,null);assert.equal(saved.validUntil,null);
    });
    await t.test('missing HSN, units, GSTIN and transport show validation failures; corrections affect only the draft',async()=>{
      await prisma.product.update({where:{id:product.id},data:{hsnCode:null}});const missing:any=await EWayBillService.prefill(admin,'SALE_INVOICE',dealerInvoice.id);assert.ok(missing.warnings.some((w:string)=>w.includes('HSN')));
      await assert.rejects(EWayBillService.create(admin,missing),/HSN/);await prisma.product.update({where:{id:product.id},data:{hsnCode:'1905'}});
      const payload=await prepare(dealerInvoice.id);payload.toPincode='560001';payload.actToStateCode=29;
      await assert.rejects(EWayBillService.create(admin,{...payload,fromGstin:'INVALID'}),/GSTIN/);
      await assert.rejects(EWayBillService.create(admin,{...payload,items:payload.items.map((i:any)=>({...i,qtyUnit:''}))}),/UQC/);
      const row=await EWayBillService.create(admin,{...payload,vehicleNo:'',transDistance:0});const check=await EWayBillService.validateDraft(admin,row.id);assert.equal(check.valid,false);assert.ok(check.errors.some(e=>e.includes('Vehicle number')));
      await EWayBillService.update(admin,row.id,{...payload,items:payload.items.map((i:any)=>({...i,quantity:2}))});assert.ok((await EWayBillService.validateDraft(admin,row.id)).errors.some(e=>e.includes('quantities')));
      await EWayBillService.update(admin,row.id,payload);assert.equal((await EWayBillService.validateDraft(admin,row.id)).valid,true);
    });
    await t.test('partial dispatch uses actual challan quantities and prevents full-invoice export',async()=>{
      const inv=await invoice();const dc=await prisma.deliveryChallan.create({data:{challanNumber:'DC-PARTIAL',sourceInvoiceId:inv.orderId,sourceFranchiseId:hq.id,customerId:customer.id,status:'IN_TRANSIT',totalAmount:42,items:{create:{productId:product.id,productName:product.name,quantity:0.4,unit:'PC',rate:100,taxPercent:5,taxAmount:2,totalAmount:42}}}});
      const payload:any=await prepare(inv.id);assert.equal(payload.requiresMovementSource,true);const row=await EWayBillService.create(admin,payload);
      assert.equal((await EWayBillService.validateDraft(admin,row.id)).valid,false);await assert.rejects(EWayBillService.exportNicJson(admin,[row.id]),/Delivery Challan/);
      const actual:any=await EWayBillService.prefill(admin,'DELIVERY_CHALLAN',dc.id);assert.equal(actual.docType,'CHL');assert.equal(actual.items[0].quantity,0.4);assert.equal(actual.items[0].taxableAmount,40);
    });
    await t.test('same full movement cannot be duplicated using its challan alias',async()=>{
      const inv=await invoice();const dc=await prisma.deliveryChallan.create({data:{challanNumber:'DC-FULL',sourceInvoiceId:inv.orderId,sourceFranchiseId:hq.id,customerId:customer.id,totalAmount:105,items:{create:{productId:product.id,productName:product.name,quantity:1,unit:'PC',rate:100,taxPercent:5,taxAmount:5,totalAmount:105}}}});
      await EWayBillService.create(admin,await prepare(inv.id));const payload:any=await EWayBillService.prefill(admin,'DELIVERY_CHALLAN',dc.id);
      await assert.rejects(EWayBillService.create(admin,{...payload,toPincode:'641004',toPlace:'Coimbatore',actToStateCode:33}),/already has/);
    });
    await t.test('manual and delivery sources keep their lifecycle and official metadata display',async()=>{
      const base=await prepare(franchiseInvoice.id);const manual:any=await EWayBillService.create(admin,{...base,sourceType:'MANUAL',sourceId:null,docNo:'MANUAL-1',toGstin:'URP',toTradeName:'Manual recipient',toStateCode:33});
      const generated=await EWayBillService.markGenerated(admin,manual.id,{ewbNumber:'223456789012',ewbDate:new Date().toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()});assert.equal(generated.status,'GENERATED');assert.equal(generated.ewbNumber,'223456789012');assert.ok(generated.validUntil);
      await assert.rejects(EWayBillService.create(admin,{...base,sourceType:'MANUAL',sourceId:null,docNo:'MANUAL-1',toGstin:'URP',toTradeName:'Manual recipient',toStateCode:33}),/already generated/);
    });
    await t.test('no source operation modifies invoices, allocations, payments or physical inventory',async()=>{
      const snapshots=await prisma.invoice.findMany({where:{id:{in:[customerInvoice.id,dealerInvoice.id,franchiseInvoice.id,branchInvoice.id]}},include:{order:{include:{orderItems:true}}},orderBy:{id:'asc'}});assert.equal(JSON.stringify(snapshots),original);
      assert.equal(await prisma.stockMovement.count(),0);assert.equal(await prisma.inventoryBatch.count(),0);assert.equal(await prisma.payment.count(),0);assert.ok(snapshots.every(i=>i.order.inventory_deducted===false));
    });
  } finally {if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await prisma.$disconnect();}
});
