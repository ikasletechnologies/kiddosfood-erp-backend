import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { TokenPayload } from '../../lib/jwt.util';
import { INDIAN_GST_STATE_MAP, normalizeState } from '../../utils/gst-tax.util';
import { toUqc } from './ewaybill.constants';

const round = (n: number) => Math.round(n * 100) / 100;
const code = (state?: string | null) => Object.entries(INDIAN_GST_STATE_MAP).find(([k,v]) => k !== '28' && normalizeState(v) === normalizeState(state))?.[0];
const gstState = (gst?: string) => gst && INDIAN_GST_STATE_MAP[gst.slice(0,2)] ? Number(gst.slice(0,2)) : null;
export class InvoiceEwbSource {
  static async resolve(user: TokenPayload, id: string, db: any = prisma, requireEligible = true) {
    const invoice = await db.invoice.findFirst({ where: { OR: [{ id }, { orderId: id }] }, include: { order: { include: { orderItems: { include: { product: true } }, customer: true, franchise: { include: { primaryWarehouse: true } } } } } });
    if (!invoice || (requireEligible && (invoice.status === 'CANCELLED' || invoice.order.status === 'CANCELLED'))) throw new AppError('Eligible sale invoice not found',404);
    if (user.role !== 'SUPER_ADMIN' && invoice.order.franchiseId !== user.franchiseId) throw new AppError('Forbidden: invoice belongs to another branch',403);
    return invoice;
  }
  static async party(order: any, db: any = prisma) {
    if (order.partyType === 'DEALER') return order.partyId ? db.dealer.findUnique({where:{id:order.partyId}}) : null;
    if (order.partyType === 'FRANCHISE') return order.partyId ? db.franchise.findUnique({where:{id:order.partyId}}) : null;
    return order.customer || (order.partyId ? db.customer.findUnique({where:{id:order.partyId}}) : null);
  }
  static async list(user: TokenPayload, search = '') {
    const q = search.trim();
    const contains = { contains:q, mode:'insensitive' as const };
    const [dealers, franchises] = q ? await Promise.all([
      prisma.dealer.findMany({where:{OR:[{name:contains},{phone:contains}]},select:{id:true}}),
      prisma.franchise.findMany({where:{OR:[{name:contains},{contactNum:contains}]},select:{id:true}})
    ]) : [[],[]];
    const filter: any = {status:{not:'CANCELLED'},...(user.role !== 'SUPER_ADMIN' ? {franchiseId:user.franchiseId || '__UNASSIGNED__'} : {})};
    if(q) filter.OR = [
      {invoiceNum:contains}, {customerName:contains},
      {customer:{is:{OR:[{name:contains},{phone:contains}]}}},
      {AND:[{partyType:'DEALER'},{partyId:{in:dealers.map(p=>p.id)}}]},
      {AND:[{partyType:'FRANCHISE'},{partyId:{in:franchises.map(p=>p.id)}}]}
    ];
    const rows = await prisma.invoice.findMany({where:{status:{not:'CANCELLED'},order:filter},include:{order:{include:{customer:true}}},orderBy:{createdAt:'desc'},take:50});
    return Promise.all(rows.map(async row => ({id:row.id,legacySourceId:row.orderId,docNo:row.order.invoiceNum,date:row.order.createdAt,partyName:(await this.party(row.order))?.name || row.order.customerName || '',partyType:row.order.partyType || 'CUSTOMER',amount:row.finalAmount})));
  }
  static async mapping(user: TokenPayload, id: string, db: any = prisma) {
    const invoice = await this.resolve(user,id,db), order = invoice.order;
    const party = await this.party(order,db);
    const setting = await db.systemSetting.findUnique({where:{key:'COMPANY_PROFILE'}});
    let profile: any = {}; try {profile = JSON.parse(setting?.value || '{}');} catch {}
    const warnings: string[] = [];
    const supplier = order.partyType === 'FRANCHISE' ? await db.franchise.findFirst({where:{isHQ:true},include:{primaryWarehouse:true}}) || order.franchise : order.franchise;
    const hq = supplier?.isHQ;
    const fromGstin = hq ? String(profile.gstNumber || profile.gstin || '').toUpperCase() : '';
    if (!hq) warnings.push('Branch GSTIN, state and PIN are not stored in the branch master. Verify and enter the supplier registration for this shipment.');
    const shipping = party?.shippingAddress || party?.address || party?.location || '';
    const billing = party?.address || party?.location || '';
    const differentShip = !!party?.shippingAddress && party.shippingAddress !== billing;
    const toGstin = String(party?.gstNumber || '').trim().toUpperCase() || 'URP';
    const toStateCode = gstState(toGstin) || Number(code(party?.state)) || null;
    const actualTo = Number(code(order.stateOfSupply)) || (!differentShip ? Number(code(party?.state)) || toStateCode : null);
    if (differentShip && !actualTo) warnings.push('Shipping address differs from billing. Confirm the actual ship-to state and PIN before validation.');
    if (order.partyType === 'FRANCHISE') warnings.push('Recipient franchise registration and shipment address must be verified; the supplier GSTIN is never copied to the franchise.');
    const lotIds = order.orderItems.map((l:any)=>l.inventoryBatchId).filter(Boolean);
    const lots = lotIds.length ? await db.inventoryBatch.findMany({where:{id:{in:lotIds}},include:{warehouse:true}}) : [];
    const warehouses = [...new Map(lots.filter((l:any)=>l.warehouse).map((l:any)=>[l.warehouse.id,l.warehouse])).values()] as any[];
    const dispatch = warehouses.length === 1 ? warehouses[0] : supplier?.primaryWarehouse;
    if (warehouses.length > 1) warnings.push('Invoice spans multiple warehouses. Use the appropriate delivery challan for each physical movement.');
    const fromAddr1 = dispatch?.location || (hq ? profile.address : supplier?.location) || '';
    const fromStateCode = gstState(fromGstin) || (hq ? Number(code(profile.state)) || null : null);
    const actFrom = fromAddr1 && hq && fromAddr1 !== profile.address ? null : fromStateCode;
    if (fromAddr1 && !actFrom) warnings.push('Confirm actual dispatch-from state and PIN for the selected warehouse.');
    const inter = !!fromStateCode && !!(Number(code(order.stateOfSupply)) || toStateCode) && fromStateCode !== (Number(code(order.stateOfSupply)) || toStateCode);
    const items = order.orderItems.map((line:any,index:number) => {
      const taxable = round(line.quantity * line.price * (1 - (line.discountPct || 0)/100));
      const tax = line.taxAmount;
      if (tax == null) warnings.push('Item '+(index+1)+': saved tax is missing; confirm the tax from the source invoice.');
      if (!line.product?.hsnCode) warnings.push('Item '+(index+1)+': HSN code is missing.');
      const qtyUnit = line.unit && line.unit !== 'NONE' ? toUqc(line.unit) : '';
      if (!qtyUnit || qtyUnit === 'OTH') warnings.push('Item '+(index+1)+': confirm the GST unit code.');
      const rate = taxable > 0 && tax != null ? tax / taxable * 100 : 0;
      return {productName:line.product?.name || '',productDesc:line.product?.sku || '',hsnCode:line.product?.hsnCode || '',quantity:line.quantity,qtyUnit,taxableAmount:taxable,cgstRate:inter?0:rate/2,sgstRate:inter?0:rate/2,igstRate:inter?rate:0,cessRate:0};
    });
    const challans = await db.deliveryChallan.findMany({where:{sourceInvoiceId:order.id,status:{not:'CANCELLED'}},include:{items:true}});
    const qty = (lines:any[]) => { const values = new Map<string,number>(); for(const l of lines) {const key=l.productId+'|'+l.unit;values.set(key,(values.get(key)||0)+l.quantity);} return values; };
    const requested=qty(order.orderItems), movement=qty(challans.flatMap((c:any)=>c.items));
    const splitMovement = warehouses.length > 1 || challans.length > 1 || (challans.length === 1 && ([...requested].some(([k,v])=>Math.abs(v-(movement.get(k)||0))>0.0001) || [...movement.keys()].some(k=>!requested.has(k))));
    if (splitMovement) warnings.push('Partial or multiple dispatches exist. Select the actual Delivery Challan instead of exporting the full invoice.');
    if (!order.inventory_deducted) warnings.push('Invoice is not fully fulfilled. This is a document draft, not a stock dispatch. Confirm actual movement and transportation details.');
    const taxable=round(items.reduce((s:number,l:any)=>s+l.taxableAmount,0));
    const tax=round(items.reduce((s:number,l:any)=>s+l.taxableAmount*(l.cgstRate+l.sgstRate+l.igstRate)/100,0));
    const relatedIds = challans.length === 1 && !splitMovement ? [challans[0].id] : [];
    const kind = String(order.orderType || '').toUpperCase();
    const regular = ['DINE_IN','TAKE_AWAY','DELIVERY','TAX_INVOICE','SALE_INVOICE','SALE','POS'].includes(kind);
    const classification = kind === 'EXPORT' ? {supplyType:'O',subSupplyType:'3',docType:'INV'} : kind === 'SALES_RETURN' ? {supplyType:'I',subSupplyType:'7',docType:'CHL'} : regular ? {supplyType:'O',subSupplyType:'1',docType:'INV'} : {supplyType:'O',subSupplyType:'8',docType:'OTH'};
    if (!regular && !['EXPORT','SALES_RETURN'].includes(kind)) warnings.push('Source transaction classification is not recognised. Confirm supply, sub-supply and document type before export.');
    return { invoice, warnings, splitMovement, relatedIds, payload: {
      sourceType:'SALE_INVOICE',sourceId:invoice.id,docNo:order.invoiceNum,docDate:new Date(new Date(order.createdAt).getTime()+330*60000).toISOString().slice(0,10),
      ...classification,subSupplyDesc:classification.subSupplyType === '8' ? 'Verify source type' : '',transactionType:hq && profile.address && fromAddr1 !== profile.address ? (differentShip?4:3) : (differentShip?2:1),
      fromGstin,fromTradeName:hq?(profile.legalName || profile.companyName || supplier?.name || ''):supplier?.name || '',fromAddr1,fromAddr2:'',fromPlace:hq && fromAddr1===profile.address ? profile.city || '' : '',fromPincode:hq && fromAddr1===profile.address ? String(profile.pincode || ''):'',fromStateCode,actFromStateCode:actFrom,
      toGstin,toTradeName:party?.name || order.customerName || '',toAddr1:shipping,toAddr2:'',toPlace:differentShip?'':party?.city || party?.district || '',toPincode:differentShip?'':party?.pincode || '',toStateCode,actToStateCode:actualTo,
      otherValue:round(invoice.finalAmount-taxable-tax),transMode:'1',transDistance:0,vehicleType:'R',items,gstInterState:inter,
      warnings,requiresMovementSource:splitMovement,sourceSummary:{invoiceId:invoice.id,orderId:order.id,invoiceAmount:invoice.finalAmount,billingAddress:billing,shippingAddress:shipping,phone:party?.phone || party?.contactNum || '',email:party?.email || '',supplierPhone:hq?profile.phone || '':supplier?.contactNum || '',supplierEmail:hq?profile.email || '':'',movementSources:challans.map((c:any)=>({id:c.id,docNo:c.challanNumber,status:c.status}))}
    }};
  }
}
