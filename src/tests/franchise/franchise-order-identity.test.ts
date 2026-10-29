import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { FranchiseOrderController as Controller } from '../../modules/franchise/franchise-order.controller';
import { FranchiseOrderService as Service } from '../../modules/franchise/franchise-order.service';
import prisma from '../../lib/prisma';

const branch = { id: 'f1', name: 'Coimbatore Main Branch', location: 'CBE' };
const order = { id: 'o1', orderNumber: 'FO-001', franchiseId: 'f1', franchise: branch, status: 'APPROVED', paymentStatus: 'PAID', totalAmount: 378 };
function response() { return { code: 200, body: undefined as any, status(code:number) {this.code=code;return this;}, json(body:any) {this.body=body;return this;} }; }

test('list keeps registered franchise identity and admin filters', async () => {
  const spy=mock.method(Service,'getOrders',async () => [order] as any);
  try { const res=response(); await Controller.getAll({user:{role:'SUPER_ADMIN'},query:{franchiseId:'f1',status:'APPROVED',search:'Main Branch'}} as any,res as any);
    assert.equal(res.code,200); assert.equal(res.body[0].franchise.name,branch.name); assert.equal(res.body[0].franchise.location,'CBE');
    assert.deepEqual(spy.mock.calls[0].arguments[0],{franchiseId:'f1',status:'APPROVED',search:'Main Branch'}); assert.equal(res.body[0].totalAmount,378);
  } finally {spy.mock.restore();}
});

test('franchise list ignores a forged franchise filter and fails closed without assignment',async()=>{
  const spy=mock.method(Service,'getOrders',async()=>[order] as any);
  try {const res=response();await Controller.getAll({user:{role:'FRANCHISE_ADMIN',franchiseId:'f1'},query:{franchiseId:'f2'}} as any,res as any);
    assert.equal(spy.mock.calls[0].arguments[0]!.franchiseId,'f1');
    const denied=response();await Controller.getAll({user:{role:'FRANCHISE_ADMIN'},query:{franchiseId:'f2'}} as any,denied as any);
    assert.equal(denied.code,403);assert.equal(spy.mock.callCount(),1);
  }finally{spy.mock.restore();}
});

test('detail permits owner and HQ but denies other and unassigned franchises',async()=>{
  const spy=mock.method(Service,'getOrderById',async()=>order as any);
  try {for(const [user,code] of [[{role:'SUPER_ADMIN'},200],[{role:'FRANCHISE_ADMIN',franchiseId:'f1'},200],[{role:'FRANCHISE_ADMIN',franchiseId:'f2'},403],[{role:'FRANCHISE_ADMIN'},403]] as const){
    const res=response();await Controller.getById({user,params:{id:'o1'}} as any,res as any);assert.equal(res.code,code);if(code===200)assert.equal(res.body.franchise.name,branch.name);else assert.equal(res.body.franchise,undefined);
  }}finally{spy.mock.restore();}
});

test('search uses related franchise name/location and preserves tenant AND status scope in one query',async()=>{
  const original=prisma.franchiseOrder.findMany; const spy=mock.fn(async (_query:any)=>[]); (prisma.franchiseOrder as any).findMany=spy;
  try{assert.deepEqual(await Service.getOrders({franchiseId:'f1',status:'APPROVED',search:' Main Branch '}),[]);
    const query=spy.mock.calls[0].arguments[0] as any;
    assert.equal(query.where.franchiseId,'f1');assert.equal(query.where.status,'APPROVED');
    assert.deepEqual(query.where.OR,[{orderNumber:{contains:'Main Branch',mode:'insensitive'}},{franchise:{name:{contains:'Main Branch',mode:'insensitive'}}},{franchise:{location:{contains:'Main Branch',mode:'insensitive'}}}]);
    assert.equal(query.include.franchise,true);assert.equal(spy.mock.callCount(),1);
  }finally{(prisma.franchiseOrder as any).findMany=original;}
});


