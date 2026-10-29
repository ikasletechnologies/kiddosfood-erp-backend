import { test } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../../lib/prisma';
import {FinishedGoodsLowStockService} from '../../modules/settings/finished-goods-low-stock';
import { DashboardInventoryService } from '../../modules/dashboard/dashboard.inventory';
import { DashboardController } from '../../modules/dashboard/dashboard.controller';
import { DashboardService } from '../../modules/dashboard/dashboard.service';
import { FinanceService } from '../../modules/finance/finance.service';

const item = (id:string,stock:number,extra:any={}) => ({id,name:id,sku:id,franchiseId:'branch-1',category:'FINISHED_GOOD',isActive:true,currentStock:stock,minimumStock:10,unit:'PC',...extra});
const batch = (id:string,stock:number) => ({id,franchiseId:'branch-1',quantity:stock,expiryDate:new Date('2027-01-01'),product:{name:'Appam',sku:'FG-APPAM-500G'}});
async function stats(items:any[],batches:any[],franchiseId:string|undefined='branch-1',threshold=5) {
  const original=[prisma.inventoryItem.findMany,prisma.productBatch.findMany,prisma.productBatch.count,FinanceService.getInventoryValuationReport] as const;
  let countCalls=0;const originalThreshold=FinishedGoodsLowStockService.threshold;
  FinishedGoodsLowStockService.threshold=async()=>threshold;
  try {
    (prisma.inventoryItem as any).findMany=async ({where}:any)=>items.filter(i=>(!where.franchiseId||i.franchiseId===where.franchiseId)&&(!where.category||i.category===where.category)&&(where.isActive===undefined||i.isActive===where.isActive));
    (prisma.productBatch as any).findMany=async ({where}:any)=>batches.filter(b=>(!where.franchiseId||b.franchiseId===where.franchiseId)&&b.expiryDate);
    (prisma.productBatch as any).count=async()=>{countCalls++;return batches.filter(b=>b.quantity<=10).length;};
    FinanceService.getInventoryValuationReport=async()=>({summary:{totalStockValue:123}} as any);
    const result=await DashboardInventoryService.getInventoryStats(franchiseId);
    return {result,countCalls};
  }finally{FinishedGoodsLowStockService.threshold=originalThreshold;[ (prisma.inventoryItem as any).findMany,(prisma.productBatch as any).findMany,(prisma.productBatch as any).count,FinanceService.getInventoryValuationReport]=original;}
}

test('one branch SKU and its batch produce one low-stock alert, not two',async()=>{
  const {result,countCalls}=await stats([item('FG-APPAM-500G',1)],[batch('lot-1',1)]);
  assert.equal(result.lowStockCount,1);assert.equal(result.lowStockAlerts.length,1);assert.equal(result.inventoryItemCount,1);assert.equal(countCalls,0);assert.equal(result.inventoryValue,123);
});
test('multiple low-quantity lots never inflate a SKU alert or make a healthy SKU low',async()=>{
  const {result}=await stats([item('FG-APPAM-500G',20)],[batch('lot-1',8),batch('lot-2',6),batch('lot-3',6)]);
  assert.equal(result.lowStockCount,0);assert.deepEqual(result.lowStockAlerts,[]);assert.equal(result.inventoryAlerts.length,3);
});
test('different variants count independently, including zero stock and configured thresholds',async()=>{
  const {result}=await stats([item('FG-APPAM-500G',1),item('FG-APPAM-900G',0),item('FG-APPAM-250G',4,{minimumStock:3})],[batch('lot-1',1),batch('lot-2',0)]);
  assert.equal(result.lowStockCount,2);assert.equal(result.lowStockAlerts.length,2);assert.equal(result.finishedGoodsOutOfStockCount,1);assert.ok(result.lowStockAlerts.every(item=>item.status==='YELLOW'));
});
test('other franchises, inactive items and raw materials are excluded from branch stock count',async()=>{
  const {result}=await stats([item('own',1),item('other',0,{franchiseId:'branch-2'}),item('inactive',0,{isActive:false}),item('raw',0,{category:'RAW_MATERIAL'})],[]);
  assert.equal(result.lowStockCount,1);assert.equal(result.inventoryItemCount,1);assert.equal(result.lowStockAlerts[0].id,'own');
});
test('empty branch has no low-stock alerts',async()=>{
  const {result}=await stats([],[]);assert.equal(result.lowStockCount,0);assert.deepEqual(result.lowStockAlerts,[]);
});
test('global dashboard preserves raw thresholds and counts Finished Goods SKUs once',async()=>{
  const {result,countCalls}=await stats([item('raw',1,{category:'RAW_MATERIAL'}),item('fg',1)],[batch('lot-1',1)],'');
  assert.equal(result.lowStockCount,2);assert.equal(countCalls,0);
});
test('unassigned franchise dashboard cannot fall back to global inventory',async()=>{
  const original=DashboardService.getSummary;let called=false;
  DashboardService.getSummary=async()=>{called=true;return {} as any;};
  try {const res={code:200,status(code:number){this.code=code;return this;},json(_value:any){return this;}};
    await DashboardController.getSummary({user:{role:'FRANCHISE_ADMIN'},query:{franchiseId:'branch-2'}} as any,res as any);
    assert.equal(res.code,403);assert.equal(called,false);
  }finally{DashboardService.getSummary=original;}
});



test('global threshold changes update existing SKU counts without changing per-item minimums',async()=>{const rows=[item('fg',3,{minimumStock:999})];assert.equal((await stats(rows,[],'branch-1',5)).result.lowStockCount,1);assert.equal((await stats(rows,[],'branch-1',2)).result.lowStockCount,0);assert.equal(rows[0].currentStock,3);assert.equal(rows[0].minimumStock,999);});
