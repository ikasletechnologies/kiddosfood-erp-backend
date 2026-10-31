import prisma from '../src/lib/prisma';
import { FinishedGoodsLowStockService, FINISHED_GOODS_LOW_STOCK_KEY } from '../src/modules/settings/finished-goods-low-stock';
import { InventoryService } from '../src/modules/inventory/inventory.service';

async function main(){
  const threshold=await FinishedGoodsLowStockService.threshold();
  const rows=await InventoryService.getAlerts();
  const finished=rows.filter(r=>r.category==='FINISHED_GOOD');
  if(finished.some(r=>r.minimumStock!==threshold || r.shortfall!==Math.max(0,threshold-r.currentStock)))throw new Error('Report threshold mismatch');
  console.log(JSON.stringify({readOnly:true,threshold,settingRecords:await prisma.systemSetting.count({where:{key:FINISHED_GOODS_LOW_STOCK_KEY}}),totalRows:rows.length,finishedGoodsRows:finished.length,finishedGoodsLow:finished.filter(r=>r.stockStatus==='LOW_STOCK').length,finishedGoodsOut:finished.filter(r=>r.stockStatus==='OUT_OF_STOCK').length,otherCategoryRows:rows.length-finished.length}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>prisma.$disconnect());
