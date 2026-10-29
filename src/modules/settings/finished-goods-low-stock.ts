import prisma from '../../lib/prisma';
import {AppError} from '../../middleware/error.middleware';

export const FINISHED_GOODS_LOW_STOCK_KEY='finishedGoodsLowStockThreshold';
export const DEFAULT_FINISHED_GOODS_LOW_STOCK_THRESHOLD=5;
export type FinishedGoodsStockStatus='OUT_OF_STOCK'|'LOW_STOCK'|'IN_STOCK';
export function validateFinishedGoodsThreshold(value:unknown):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new AppError('Low Stock Alert Quantity must be a non-negative whole number.',422);
  return value;
}
export function finishedGoodsStockStatus(available:number,threshold:number):FinishedGoodsStockStatus {
  if(available<=0)return 'OUT_OF_STOCK';
  return available<=threshold?'LOW_STOCK':'IN_STOCK';
}
export class FinishedGoodsLowStockService {
  static parse(value:string):number {
    if(!/^\d+$/.test(value))throw new AppError('The saved Finished Goods low-stock setting is invalid. Ask Super Admin to update it.',500);
    return validateFinishedGoodsThreshold(Number(value));
  }
  /** Read-only helper for inventory transactions; no config locks or SKU writes. */
  static async threshold(db:any=prisma):Promise<number>{
    const row=await db.systemSetting.findUnique({where:{key:FINISHED_GOODS_LOW_STOCK_KEY},select:{value:true}});
    return row?this.parse(row.value):DEFAULT_FINISHED_GOODS_LOW_STOCK_THRESHOLD;
  }
  static async get(){
    const existing=await prisma.systemSetting.findUnique({where:{key:FINISHED_GOODS_LOW_STOCK_KEY}});
    const row=existing || await prisma.systemSetting.upsert({
      where:{key:FINISHED_GOODS_LOW_STOCK_KEY},update:{},
      create:{key:FINISHED_GOODS_LOW_STOCK_KEY,value:String(DEFAULT_FINISHED_GOODS_LOW_STOCK_THRESHOLD),group:'INVENTORY',description:'One global Finished Goods low-stock alert quantity (PC).'},
    });
    return {finishedGoodsLowStockThreshold:this.parse(row.value),unit:'PC'};
  }
  static async set(value:unknown){
    const threshold=validateFinishedGoodsThreshold(value);
    await prisma.systemSetting.upsert({
      where:{key:FINISHED_GOODS_LOW_STOCK_KEY},
      create:{key:FINISHED_GOODS_LOW_STOCK_KEY,value:String(threshold),group:'INVENTORY',description:'One global Finished Goods low-stock alert quantity (PC).'},
      update:{value:String(threshold),group:'INVENTORY'},
    });
    return {finishedGoodsLowStockThreshold:threshold,unit:'PC'};
  }
}

