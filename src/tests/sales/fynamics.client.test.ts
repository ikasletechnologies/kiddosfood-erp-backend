import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FynamicsClient, FynamicsError, mapFynamicsDraft, officialResult, providerDate } from '../../modules/eway-bill/fynamics.client';
const env = {FYNAMICS_BASE_URL:'https://staging.fynamics.co.in/api',FYNAMICS_CLIENT_ID:'fixture-client',FYNAMICS_CLIENT_SECRET:'fixture-secret',FYNAMICS_GSTIN:'33AAAAA0000A1Z5',FYNAMICS_EWAY_USERNAME:'fixture-user',FYNAMICS_EWAY_PASSWORD:'fixture-password'};
const success = {status:1,ewayBillNo:123456789012,ewayBillDate:'29/10/2026 11:17:00',validUpto:'30/10/2026 12.00:00'};
const taxpayer = {Status:1,Data:{AuthToken:'fixture-token',Sek:'fixture-sek',TokenExpiry:'2099-01-01 12:00:00'}};
const gateway = {status:1,data:{accessToken:'fixture-gateway',expiresIn:86400}};
test('enhanced authentication, server-only headers, cached tokens, official response and reconciliation',async()=>{
  const calls:any[]=[];
  const client=new FynamicsClient(env, (async(url:any,init:any)=>{calls.push({url,init}); return Response.json(calls.length===1?gateway:calls.length===2?taxpayer:success);}) as typeof fetch);
  await Promise.all([client.ready(env.FYNAMICS_GSTIN),client.ready(env.FYNAMICS_GSTIN)]);
  const result=await client.generate({docNo:'INV-1'});
  assert.equal(result.ewbNumber,'123456789012');
  assert.equal(calls[0].url,env.FYNAMICS_BASE_URL+'/authenticate');assert.equal(calls[0].init.body,undefined);assert.equal(calls[0].init.method,'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body),{action:'ACCESSTOKEN',username:'fixture-user',password:'fixture-password'});
  assert.equal(calls[2].init.headers.Authorization,'Bearer fixture-gateway');assert.equal(calls[2].init.headers.sek,'fixture-sek');
  await client.ready(env.FYNAMICS_GSTIN);assert.equal(calls.length,3);
  await client.reconcile('INV','INV/1');assert.ok(calls[3].url.endsWith('/INV/INV%2F1'));assert.equal(calls[3].init.method,'GET');
});
test('production and mismatched taxpayers are blocked',()=>{
  assert.throws(()=>new FynamicsClient({...env,FYNAMICS_BASE_URL:'https://www.fynamics.co.in/api'}).assertConfigured(),/Production/);
  assert.throws(()=>new FynamicsClient(env).assertConfigured('29BBBBB0000B1Z5'),/does not match/);
});
test('network failures and malformed success remain uncertain; no number is invented',async()=>{
  assert.throws(()=>officialResult({status:1}),FynamicsError);assert.throws(()=>officialResult({...success,status:0}),FynamicsError);
  const c=new FynamicsClient(env,(async()=>{throw new Error('fixture-secret');}) as typeof fetch);
  await assert.rejects(c.ready(env.FYNAMICS_GSTIN),(e:any)=>e.uncertain && !e.message.includes('fixture-secret'));
});
test('authentication errors redact credentials',async()=>{
  const c=new FynamicsClient(env,(async()=>Response.json({status:0,errorMessage:'Invalid fixture-secret fixture-password'})) as typeof fetch);
  await assert.rejects(c.ready(env.FYNAMICS_GSTIN),(e:any)=>!e.message.includes('fixture-secret') && !e.message.includes('fixture-password'));
});
test('maps saved shared draft for every source without mutating it',()=>{
  for(const sourceType of ['MANUAL','SALE_INVOICE','DELIVERY_CHALLAN']) {
    const row={sourceType,docDate:new Date('2026-10-28T18:30:00Z'),fromTradeName:'From',toTradeName:'To',fromPincode:'600001',toPincode:'641001',otherValue:0,transDistance:20,transactionType:1,items:[{productName:'Food',hsnCode:'1905',quantity:2,qtyUnit:'NOS',taxableAmount:100,cgstRate:2.5,sgstRate:2.5,igstRate:0,cessRate:0}]};
    const before=JSON.stringify(row);const p=mapFynamicsDraft(row);
    assert.equal(p.docDate,'29/10/2026');assert.equal(p.fromTrdName,'From');assert.equal(p.fromPincode,600001);assert.equal(p.transDistance,'20');assert.equal(p.itemList[0].cessNonadvol,0);assert.equal(JSON.stringify(row),before);
  }
});
test('official dates use IST with supported provider punctuation',()=>{assert.equal(providerDate('29/10/2026 11:17:00').toISOString(),'2026-10-29T05:47:00.000Z');assert.equal(providerDate('29/10/2026 11:17:00 PM').toISOString(),'2026-10-29T17:47:00.000Z');});
test('expired gateway token refreshes both sessions without replaying generation',async()=>{
  const original=Date.now;let now=original();Date.now=()=>now;
  try {
    let count=0;
    const c=new FynamicsClient(env,(async()=>{count++;return Response.json(count%2===1?{status:1,data:{accessToken:'fixture-gateway',expiresIn:120}}:taxpayer);}) as typeof fetch);
    await c.ready(env.FYNAMICS_GSTIN);assert.equal(count,2);
    now+=121000;await c.ready(env.FYNAMICS_GSTIN);assert.equal(count,4);
  } finally {Date.now=original;}
});
test('generation timeout is uncertain and is never replayed',async()=>{
  let count=0;
  const c=new FynamicsClient(env,(async()=>{count++;if(count===1)return Response.json(gateway);if(count===2)return Response.json(taxpayer);throw new Error('connection lost');}) as typeof fetch);
  await c.ready(env.FYNAMICS_GSTIN);
  await assert.rejects(c.generate({docNo:'INV-1'}),(e:any)=>e instanceof FynamicsError && e.uncertain);
  assert.equal(count,3);
});
test('setup feedback identifies missing variable names without exposing configured credentials',()=>{
  const c=new FynamicsClient({...env,FYNAMICS_GSTIN:'',FYNAMICS_EWAY_USERNAME:'',FYNAMICS_EWAY_PASSWORD:''});
  const message=c.configurationMessage();
  for(const key of ['FYNAMICS_GSTIN','FYNAMICS_EWAY_USERNAME','FYNAMICS_EWAY_PASSWORD']) assert.ok(message.includes(key));
  assert.ok(!message.includes('fixture-secret'));assert.ok(!message.includes('fixture-client'));
});
