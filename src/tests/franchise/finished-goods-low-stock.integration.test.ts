import {test} from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../../lib/prisma';
import app from '../../app';
import {JwtUtil} from '../../lib/jwt.util';
import {FinishedGoodsLowStockService,FINISHED_GOODS_LOW_STOCK_KEY,finishedGoodsStockStatus,validateFinishedGoodsThreshold} from '../../modules/settings/finished-goods-low-stock';
import {InventoryService} from '../../modules/inventory/inventory.service';
import {DashboardInventoryService} from '../../modules/dashboard/dashboard.inventory';

test('whole-number validation and Finished Goods status boundaries',()=>{
  for(const value of [-1,1.5,NaN,Infinity,'5',null,undefined,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateFinishedGoodsThreshold(value));
  assert.equal(validateFinishedGoodsThreshold(0),0);
  for(const [qty,min,status] of [[0,5,'OUT_OF_STOCK'],[3,5,'LOW_STOCK'],[5,5,'LOW_STOCK'],[10,5,'IN_STOCK'],[3,2,'IN_STOCK'],[1,0,'IN_STOCK']] as const)assert.equal(finishedGoodsStockStatus(qty,min),status);
});
test('global setting persistence, APIs and inventory safety',{timeout:180000},async t=>{
  const target=new URL(process.env.DATABASE_URL||'');assert.equal(process.env.KIDDOS_LOW_STOCK_TEST_DB,'1');assert.equal(target.hostname,'127.0.0.1');assert.equal(target.pathname,'/kiddos_low_stock_test');let server:any;
  try{
    assert.equal(await prisma.systemSetting.count(),0,'Requires an empty disposable test database');
    const fg:Array<{id:string}>=[];
    for(const [index,qty] of [10,5,3,0].entries())fg.push(await prisma.inventoryItem.create({data:{name:'Appam '+index,sku:'FG-APPA-'+index,category:'FINISHED_GOOD',unit:'PC',currentStock:qty,minimumStock:999,costPrice:20,customerPrice:100}}));
    const raw=await prisma.inventoryItem.create({data:{name:'Rice',sku:'RM-RICE',category:'RAW_MATERIAL',unit:'KG',currentStock:3,minimumStock:100,costPrice:50}});
    const snapshot=await prisma.inventoryItem.findMany({orderBy:{id:'asc'}});
    server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    const token=JwtUtil.generateAccessToken({userId:'hq-test',role:'SUPER_ADMIN'}),branch=JwtUtil.generateAccessToken({userId:'branch-test',role:'FRANCHISE_ADMIN',franchiseId:'branch-one'});
    const url='/api/settings/finished-goods-low-stock';
    const request=(path=url,method='GET',body?:any,auth:string|null=token)=>fetch(origin+path,{method,headers:{...(auth?{Authorization:'Bearer '+auth}:{}),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    await t.test('default 5 PC is created once and repeated reads preserve it',async()=>{
      const result:any=await (await request()).json();assert.equal(result.finishedGoodsLowStockThreshold,5);assert.equal(result.unit,'PC');
      await Promise.all([FinishedGoodsLowStockService.get(),FinishedGoodsLowStockService.get()]);assert.equal(await prisma.systemSetting.count({where:{key:FINISHED_GOODS_LOW_STOCK_KEY}}),1);
    });
    await t.test('inventory statuses and dashboard counts use one value, not per-product minimums or lots',async()=>{
      const items=await InventoryService.getInventory(undefined),finished=items.filter(i=>i.category==='FINISHED_GOOD');
      assert.deepEqual(finished.map(i=>i.stockStatus),['IN_STOCK','LOW_STOCK','LOW_STOCK','OUT_OF_STOCK']);
      assert.ok(finished.every(i=>i.lowStockThreshold===5&&i.minimumStock===999));
      const row=items.find(i=>i.id===raw.id)!;assert.equal(row.lowStockThreshold,100);assert.equal(row.status,'LOW');
      const metrics=await DashboardInventoryService.getInventoryStats();assert.equal(metrics.finishedGoodsLowStockCount,2);assert.equal(metrics.finishedGoodsOutOfStockCount,1);assert.equal(metrics.lowStockCount,3);
    });
    await t.test('saving 2 PC immediately reclassifies existing stock without changing amounts, prices or valuation',async()=>{
      const before=await DashboardInventoryService.getInventoryStats();
      const saved=await request(url,'PUT',{finishedGoodsLowStockThreshold:2});assert.equal(saved.status,200);assert.equal((await saved.json() as any).finishedGoodsLowStockThreshold,2);
      const metrics=await DashboardInventoryService.getInventoryStats();assert.equal(metrics.finishedGoodsLowStockCount,0);assert.equal(metrics.lowStockCount,1);assert.equal(metrics.inventoryValue,before.inventoryValue);
      const rows=await InventoryService.getInventory(undefined);assert.equal(rows.find(i=>i.id===fg[2].id)!.stockStatus,'IN_STOCK');
      assert.deepEqual(await prisma.inventoryItem.findMany({orderBy:{id:'asc'}}),snapshot);assert.equal(await prisma.stockMovement.count(),0);
    });
    await t.test('only Super Admin can update; anonymous and franchise writes fail',async()=>{
      assert.equal((await request(url,'GET',undefined,null)).status,401);
      assert.equal((await request(url,'PUT',{finishedGoodsLowStockThreshold:10},branch)).status,403);
      assert.equal((await request(url,'GET',undefined,branch)).status,200);
      assert.equal(await FinishedGoodsLowStockService.threshold(),2);
    });
    await t.test('invalid values are rejected through dedicated and generic settings APIs',async()=>{
      for(const value of [-1,1.5,'5',null,Number.MAX_SAFE_INTEGER+1])assert.equal((await request(url,'PUT',{finishedGoodsLowStockThreshold:value})).status,422);
      assert.equal((await request('/api/settings','POST',{key:FINISHED_GOODS_LOW_STOCK_KEY,value:'-1'})).status,422);
      assert.equal((await request('/api/settings','POST',{key:FINISHED_GOODS_LOW_STOCK_KEY,value:'1.5'})).status,422);
      assert.equal(await FinishedGoodsLowStockService.threshold(),2);
    });
    await t.test('future SKUs inherit the current value and zero survives subsequent reads',async()=>{
      const later=await prisma.inventoryItem.create({data:{name:'New variant',sku:'FG-NEW-500G',category:'FINISHED_GOOD',unit:'PC',currentStock:1,minimumStock:0}});
      assert.equal((await InventoryService.getInventory(undefined)).find(i=>i.id===later.id)!.stockStatus,'LOW_STOCK');
      assert.equal((await request(url,'PUT',{finishedGoodsLowStockThreshold:0})).status,200);
      const values=await Promise.all([FinishedGoodsLowStockService.get(),FinishedGoodsLowStockService.get()]);assert.ok(values.every(v=>v.finishedGoodsLowStockThreshold===0));
      const rows=await InventoryService.getInventory(undefined);assert.equal(rows.find(i=>i.id===later.id)!.stockStatus,'IN_STOCK');assert.equal(rows.find(i=>i.id===fg[3].id)!.stockStatus,'OUT_OF_STOCK');assert.equal(rows.find(i=>i.id===raw.id)!.lowStockThreshold,100);
      assert.equal(await prisma.systemSetting.count({where:{key:FINISHED_GOODS_LOW_STOCK_KEY}}),1);
    });
  }finally{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await prisma.$disconnect();}
});

