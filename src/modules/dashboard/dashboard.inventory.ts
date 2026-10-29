import prisma from '../../lib/prisma';
import {Prisma} from '@prisma/client';
import {FinanceService} from '../finance/finance.service';
import {FinishedGoodsLowStockService,finishedGoodsStockStatus} from '../settings/finished-goods-low-stock';

export class DashboardInventoryService {
  static async getInventoryStats(franchiseId?:string){
    const itemWhere:Prisma.InventoryItemWhereInput=franchiseId?{franchiseId,isActive:true,category:'FINISHED_GOOD'}:{};
    const batchWhere:Prisma.ProductBatchWhereInput=franchiseId?{franchiseId}:{};
    const [inventoryItems,productBatches,valuation,threshold]=await Promise.all([
      prisma.inventoryItem.findMany({where:itemWhere}),
      // Keep expiry/lot tracking, but never count a batch as another SKU.
      prisma.productBatch.findMany({where:{...batchWhere,expiryDate:{not:null}},include:{product:true},orderBy:{expiryDate:'asc'},take:50}),
      FinanceService.getInventoryValuationReport(franchiseId),
      FinishedGoodsLowStockService.threshold(),
    ]);
    const finishedBySku=new Map<string,typeof inventoryItems[number]>();
    for(const item of inventoryItems){
      if(item.category!=='FINISHED_GOOD'||!item.isActive)continue;
      const key=item.sku?.trim().toUpperCase()||item.id,previous=finishedBySku.get(key);
      finishedBySku.set(key,previous?{...previous,currentStock:previous.currentStock+item.currentStock}:item);
    }
    const finished=[...finishedBySku.values()];
    const finishedLow=finished.filter(item=>finishedGoodsStockStatus(item.currentStock,threshold)==='LOW_STOCK');
    const finishedOut=finished.filter(item=>finishedGoodsStockStatus(item.currentStock,threshold)==='OUT_OF_STOCK');
    // Raw material thresholds, comparisons and quantities retain their rules.
    const rawLow=inventoryItems.filter(item=>item.category!=='FINISHED_GOOD'&&item.currentStock<=item.minimumStock);
    const lowStockList=[...rawLow,...finishedLow].map(item=>{
      const minimum=item.category==='FINISHED_GOOD'?threshold:item.minimumStock;
      return {id:item.id,name:item.name,product:item.name,currentStock:item.currentStock,current:item.currentStock,required:minimum,unit:item.unit||'PC',status:item.currentStock<=0?'RED':'YELLOW',action:item.currentStock<=0?'Request Refill':'Reorder'};
    });
    const inventoryAlerts=productBatches.map(batch=>{
      const balance=batch.product?.sku?finishedBySku.get(batch.product.sku.trim().toUpperCase()):undefined;
      const status=finishedGoodsStockStatus(balance?.currentStock??batch.quantity,threshold);
      const diff=batch.expiryDate?Math.ceil((new Date(batch.expiryDate).getTime()-Date.now())/86400000):null;
      return {
        id:batch.id,productName:batch.product?.name||'Unknown Product',currentStock:batch.quantity,
        unit:balance?.unit||'PC',expiryDate:batch.expiryDate?new Date(batch.expiryDate).toLocaleDateString():'No Expiry',
        daysLeft:diff===null?'N/A':diff>0?diff+' days':'Expired',
        status:status==='OUT_OF_STOCK'?'RED':status==='LOW_STOCK'?'YELLOW':'GREEN',
        refillSuggestion:status==='OUT_OF_STOCK'?'Refill Urgent':status==='LOW_STOCK'?'Reorder Soon':'Safe',
      };
    });
    return {
      inventoryValue:valuation.summary.totalStockValue,inventoryItemCount:inventoryItems.filter(item=>item.isActive).length,
      finishedGoodsLowStockThreshold:threshold,finishedGoodsLowStockCount:finishedLow.length,finishedGoodsOutOfStockCount:finishedOut.length,
      lowStockCount:rawLow.length+finishedLow.length,
      inventoryAlerts:inventoryAlerts.slice(0,10),lowStockAlerts:lowStockList.slice(0,10),lowStock:lowStockList.slice(0,10),
    };
  }
}

