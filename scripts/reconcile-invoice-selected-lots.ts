import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import prisma from '../src/lib/prisma';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { InvoiceDispatchService } from '../src/modules/sales/invoice-dispatch.service';

// Explicitly targeted correction only. Default invocation is a read-only review.
async function main() {
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { order: { invoiceNum: 'INV-2026-0002' } }, include: { order: { include: { orderItems: { include: { product: true } } } } } });
  const actor = { role: 'SUPER_ADMIN', userId: 'SYSTEM_INVOICE_RECONCILIATION' };
  const originalLines = invoice.order.orderItems;
  assert.equal(originalLines.length, 2);
  assert.ok(originalLines.every(l => l.product?.sku === 'FG-APPA-450G' && l.quantity === 1 && l.unit === 'PC' && l.inventoryBatchId));
  assert.deepEqual(originalLines.map(l=>l.lotNumber).sort(), ['LOT-20261031-00001','LOT-20261031-00003']);
  const ids = originalLines.map(l => l.inventoryBatchId!) as string[];
  const before = await prisma.inventoryBatch.findMany({ where: { id: { in: ids } } });
  assert.equal(new Set(before.map(l=>l.inventoryItemId)).size,1);
  const itemId = before[0].inventoryItemId;
  const ledgerBefore = await InventoryService.computeStock(itemId);
  const paymentsBefore = await prisma.payment.findMany({ where: { invoiceId: invoice.id }, orderBy: { id:'asc' } });
  const moneyBefore = { invoice: await prisma.invoice.findUnique({where:{id:invoice.id}}), payments: paymentsBefore };
  const review = await InvoiceDispatchService.review(invoice.id, actor);
  let result: any = { applied: false };
  if (process.argv.includes('--post')) {
    assert.ok(review.canPost || review.inventoryStatus === 'FULFILLED', review.warnings.join(' '));
    result = { applied: true, ...await InvoiceDispatchService.post(invoice.id, actor) };
  }
  const after = await prisma.inventoryBatch.findMany({ where: { id: { in: ids } } });
  const ledgerAfter = await InventoryService.computeStock(itemId);
  const moneyAfter = { invoice: await prisma.invoice.findUnique({where:{id:invoice.id}}), payments: await prisma.payment.findMany({ where: {invoiceId:invoice.id},orderBy:{id:'asc'} }) };
  assert.deepEqual(moneyAfter,moneyBefore,'Invoice amounts and payment records must remain unchanged');
  if(result.applied && !result.alreadyPosted){
    for(const lot of before)assert.equal(after.find(l=>l.id===lot.id)!.currentQty,lot.currentQty-1);
    assert.equal(ledgerAfter,ledgerBefore-2);
    assert.equal((await InvoiceDispatchService.post(invoice.id,actor)).alreadyPosted,true);
    assert.equal(await InventoryService.computeStock(itemId),ledgerAfter,'Replay must not deduct again');
  }
  const report={generatedAt:new Date().toISOString(),invoiceNumber:invoice.order.invoiceNum,invoiceId:invoice.id,review,applied:result.applied,alreadyPosted:result.alreadyPosted,challanId:result.challan?.id,challanNumber:result.challan?.challanNumber,inventoryPostingTrigger:'Delivery Challan IN_TRANSIT dispatch',ledgerBefore,ledgerAfter,lots:before.map(l=>({id:l.id,lotNumber:l.lotNumber,before:l.currentQty,after:after.find(a=>a.id===l.id)!.currentQty,unitCost:l.unitCost})),amountsAndPaymentsUnchanged:true};
  // Reviews and retries must not replace the evidence from the original posting.
  const reportPath = result.applied && !result.alreadyPosted ? 'docs/INV-2026-0002-reconciliation.json' : 'docs/INV-2026-0002-reconciliation-review.json';
  writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>prisma.$disconnect());
