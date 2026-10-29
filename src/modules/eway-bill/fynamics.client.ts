import { AppError } from '../../middleware/error.middleware';

export class FynamicsError extends AppError {
  constructor(message: string, public uncertain = false) { super(message, uncertain ? 503 : 422); Object.setPrototypeOf(this, FynamicsError.prototype); }
}
export function providerDate(value: unknown): Date {
  if (typeof value !== 'string') throw new FynamicsError('Invalid date in E-Way Bill service response', true);
  const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2})[:.](\d{2}):(\d{2})(?: (AM|PM))?$/i);
  if (!m) throw new FynamicsError('Unexpected E-Way Bill service date format', true);
  let h = +m[4]; if (m[7] && h <= 12) h = h % 12 + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T${String(h).padStart(2,'0')}:${m[5]}:${m[6]}+05:30`);
  if (+m[2]<1 || +m[2]>12 || +m[1]<1 || +m[1]>new Date(Date.UTC(+m[3],+m[2],0)).getUTCDate() || h>23 || +m[5]>59 || +m[6]>59 || !Number.isFinite(d.getTime())) throw new FynamicsError('Invalid E-Way Bill service date', true);
  return d;
}
export function officialResult(data: any, reconciliation = false) {
  if ((!reconciliation && data?.status !== 1) || !/^\d{12}$/.test(String(data?.ewayBillNo))) throw new FynamicsError('E-Way Bill service did not confirm an official number', true);
  return { ewbNumber: String(data.ewayBillNo), ewbDate: providerDate(data.ewayBillDate), validUntil: data.validUpto ? providerDate(data.validUpto) : null };
}
export function mapFynamicsDraft(r: any) {
  const date = (v: any) => v ? new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(v)) : '';
  const payload: any = {};
  for (const key of ['supplyType','subSupplyType','subSupplyDesc','docType','docNo','transactionType','fromGstin','fromAddr1','fromAddr2','fromPlace','fromStateCode','actFromStateCode','toGstin','toAddr1','toAddr2','toPlace','toStateCode','actToStateCode','totalValue','cgstValue','sgstValue','igstValue','cessValue','totInvValue','transMode','transporterId','transporterName','transDocNo','vehicleNo','vehicleType']) payload[key] = r[key] ?? '';
  Object.assign(payload, {docDate:date(r.docDate),transDocDate:date(r.transDocDate),fromTrdName:r.fromTradeName,toTrdName:r.toTradeName,fromPincode:Number(r.fromPincode),toPincode:Number(r.toPincode),otherValue:String(r.otherValue),transDistance:String(r.transDistance),cessNonAdvolValue:0});
  payload.itemList = r.items.map((i: any) => ({productName:i.productName,productDesc:i.productDesc || i.productName,hsnCode:Number(i.hsnCode),quantity:i.quantity,qtyUnit:i.qtyUnit,taxableAmount:i.taxableAmount,cgstRate:i.cgstRate,sgstRate:i.sgstRate,igstRate:i.igstRate,cessRate:i.cessRate,cessNonadvol:0}));
  return payload;
}

export class FynamicsClient {
  private gateway?: {token:string; until:number};
  private taxpayer?: {token:string; sek:string; until:number};
  private pending?: Promise<void>;
  constructor(private env: NodeJS.ProcessEnv = process.env, private http: typeof fetch = fetch) {}
  configured() { return ['FYNAMICS_BASE_URL','FYNAMICS_CLIENT_ID','FYNAMICS_CLIENT_SECRET','FYNAMICS_GSTIN','FYNAMICS_EWAY_USERNAME','FYNAMICS_EWAY_PASSWORD'].every(k=>!!this.env[k]) && this.env.FYNAMICS_BASE_URL === 'https://staging.fynamics.co.in/api'; }
  configurationMessage() {
    const missing = ['FYNAMICS_BASE_URL','FYNAMICS_CLIENT_ID','FYNAMICS_CLIENT_SECRET','FYNAMICS_GSTIN','FYNAMICS_EWAY_USERNAME','FYNAMICS_EWAY_PASSWORD'].filter(key => !this.env[key]);
    if (missing.length) return 'E-Way Bill service setup is incomplete. Missing backend configuration: '+missing.join(', ')+'. Taxpayer API username/password are separate from the Fynamics Client ID/Secret.';
    if (!this.configured()) return 'Fynamics staging URL must be https://staging.fynamics.co.in/api. Production generation is disabled.';
    return 'Fynamics staging is configured. Draft validation is required before generation.';
  }
  assertConfigured(gstin?: string) {
    if (!this.configured()) throw new AppError(this.configurationMessage(),503);
    if (gstin && gstin !== this.env.FYNAMICS_GSTIN) throw new AppError('Draft consignor GSTIN does not match the configured Fynamics taxpayer',422);
  }
  private safe(value: unknown) {
    let s = String(value ?? '').replace(/[\r\n]/g,' ').slice(0,500);
    for (const v of [this.env.FYNAMICS_CLIENT_ID,this.env.FYNAMICS_CLIENT_SECRET,this.env.FYNAMICS_EWAY_PASSWORD,this.gateway?.token,this.taxpayer?.token,this.taxpayer?.sek]) if(v) s=s.split(v).join('[REDACTED]');
    return s;
  }
  private async request(path:string, headers:Record<string,string>, body?:any) {
    let response: Response;
    try { response = await this.http(this.env.FYNAMICS_BASE_URL+path,{method:path === '/authenticate' || body !== undefined ? 'POST':'GET',headers:{accept:'application/json','content-type':'application/json',...headers},...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000),redirect:'error'}); }
    catch { throw new FynamicsError('E-Way Bill service connection failed or timed out. Reconcile before retrying.',true); }
    let data:any; try { data=await response.json(); } catch { throw new FynamicsError('Unexpected E-Way Bill service response. Reconcile before retrying.',true); }
    if (!response.ok) throw new FynamicsError(`E-Way Bill service returned HTTP ${response.status}`,response.status >= 500);
    if (data?.status === 0 || data?.Status === 0) {
      const details = data.errorMessage || data.ErrorDetails?.map((e:any)=>`${e.ErrorCode}: ${e.ErrorMessage}`).join('; ') || data.info || `Provider error code ${data.error?.errorCodes ?? 'unknown'}`;
      const safeDetails=this.safe(details);
      this.taxpayer=undefined; this.gateway=undefined;
      throw new FynamicsError(safeDetails,path.includes('/generate') && (/duplicate|already|eway.*exist/i.test(safeDetails) || !!data.error?.errorCodes));
    }
    return data;
  }
  private async authenticate() {
    this.assertConfigured();
    if (!this.gateway || this.gateway.until < Date.now()+60000) {
      const r=await this.request('/authenticate',{clientId:this.env.FYNAMICS_CLIENT_ID!,clientSecret:this.env.FYNAMICS_CLIENT_SECRET!});
      if(r.status !== 1 || typeof r.data?.accessToken !== 'string' || !(r.data.expiresIn > 0)) throw new FynamicsError('Unexpected gateway authentication response');
      this.gateway={token:r.data.accessToken,until:Date.now()+r.data.expiresIn*1000}; this.taxpayer=undefined;
    }
    if (!this.taxpayer || this.taxpayer.until < Date.now()+60000) {
      const r=await this.request('/eway/enhanced/authentication',{Authorization:`Bearer ${this.gateway.token}`,gstin:this.env.FYNAMICS_GSTIN!},{action:'ACCESSTOKEN',username:this.env.FYNAMICS_EWAY_USERNAME,password:this.env.FYNAMICS_EWAY_PASSWORD});
      const d=r.Data; const until=typeof d?.TokenExpiry === 'string' ? new Date(d.TokenExpiry.replace(' ','T')+'+05:30').getTime() : NaN;
      if(r.Status !== 1 || !d?.AuthToken || !d?.Sek || !(until > Date.now()+60000)) throw new FynamicsError('Unexpected taxpayer authentication response or expired token');
      this.taxpayer={token:d.AuthToken,sek:d.Sek,until};
    }
  }
  async ready(gstin:string) {
    this.assertConfigured(gstin);
    if(!this.pending) this.pending=this.authenticate().finally(()=>{this.pending=undefined;});
    await this.pending;
  }
  private headers() { return {Authorization:`Bearer ${this.gateway!.token}`,gstin:this.env.FYNAMICS_GSTIN!,username:this.env.FYNAMICS_EWAY_USERNAME!,authtoken:this.taxpayer!.token,sek:this.taxpayer!.sek}; }
  async generate(payload:any) { return officialResult(await this.request('/eway/enhanced/generate',this.headers(),payload)); }
  async reconcile(docType:string,docNo:string) {
    const r=await this.request(`/eway/enhanced/bills-generated-consigner/${encodeURIComponent(docType)}/${encodeURIComponent(docNo)}`,this.headers());
    return officialResult(r,true);
  }
}
export const fynamics = new FynamicsClient();
