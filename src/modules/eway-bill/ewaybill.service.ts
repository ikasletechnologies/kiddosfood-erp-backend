import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { TokenPayload } from '../../lib/jwt.util';
import { FranchiseService } from '../franchise/franchise.service';
import { SettingsService } from '../settings/settings.service';
import { INDIAN_GST_STATE_MAP, normalizeState } from '../../utils/gst-tax.util';
import {
  SUPPLY_DOC_MATRIX,
  SUB_SUPPLY_TYPES,
  TRANS_MODES,
  CANCEL_REASONS,
  VEHICLE_UPDATE_REASONS,
  EXTENSION_REASONS,
  toUqc,
  isValidUqc,
} from './ewaybill.constants';

// E-Way Bill lifecycle (GST Rule 138):
//   DRAFT      — prepared here, editable, exportable as NIC JSON.
//   GENERATED  — the user generated it on the NIC portal (bulk-upload the
//                exported JSON, or key it in) and recorded the 12-digit
//                EWB number here. Only Part B can change after this.
//   CANCELLED  — cancelled within 24h of generation.
//   EXPIRED is never stored — it's GENERATED with validUntil in the past,
//   derived on read so it can't go stale.
//
// No EWB number is ever fabricated server-side: there is no NIC/GSP API
// integration, so the number must come from the portal.

type SourceType = 'SALE_INVOICE' | 'DELIVERY_CHALLAN' | 'STOCK_TRANSFER' | 'MANUAL';
const SOURCE_TYPES: SourceType[] = ['SALE_INVOICE', 'DELIVERY_CHALLAN', 'STOCK_TRANSFER', 'MANUAL'];

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
// Transporter id is a GSTIN or a 15-char TRANSIN issued to unregistered transporters.
const TRANSPORTER_ID_RE = /^\d{2}[A-Z0-9]{13}$/;
const PINCODE_RE = /^[1-9]\d{5}$/;
const HSN_RE = /^\d{4,8}$/;
// NIC: max 16 chars, alphanumerics plus / and -, must not start with 0, / or -.
const DOC_NO_RE = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/;
const EWB_NO_RE = /^\d{12}$/;
const VEHICLE_RE = [
  /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/, // regular, e.g. TN01AB1234
  /^\d{2}BH\d{4}[A-Z]{1,2}$/,          // Bharat series
  /^(TR|TM|TC)[A-Z0-9]{6,13}$/,         // temporary registration
  /^(DF|DFD)[A-Z0-9]{4,12}$/,           // defence
];

const IST_OFFSET_MS = 330 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function stateCodeFromName(state?: string | null): number | null {
  const target = normalizeState(state);
  if (!target) return null;
  const aliases: Record<string, string> = { 'jammu & kashmir': 'jammu and kashmir', 'orissa': 'odisha', 'pondicherry': 'puducherry' };
  const wanted = aliases[target] || target;
  for (const [code, name] of Object.entries(INDIAN_GST_STATE_MAP)) {
    // 37 (new Andhra Pradesh) wins over the legacy 28 code for the same name.
    if (name.toLowerCase() === wanted && code !== '28') return Number(code);
  }
  return null;
}

function stateCodeFromGstin(gstin?: string | null): number | null {
  if (!gstin || !/^\d{2}/.test(gstin)) return null;
  const code = gstin.slice(0, 2);
  return INDIAN_GST_STATE_MAP[code] ? Number(code) : null;
}

function normalizeVehicle(v?: string | null): string | null {
  const s = String(v || '').replace(/[\s-]/g, '').toUpperCase();
  return s || null;
}

// Validity: 1 day per 200 km (per 20 km for over-dimensional cargo), where a
// "day" ends at midnight IST — a 1-day EWB generated at 10:00 on the 1st is
// valid until 23:59:59 on the 2nd.
export function computeValidUntil(start: Date, distanceKm: number, vehicleType: string): Date {
  const perDay = vehicleType === 'O' ? 20 : 200;
  const days = Math.max(1, Math.ceil(Math.max(1, distanceKm) / perDay));
  const ist = new Date(start.getTime() + IST_OFFSET_MS);
  const endIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 23, 59, 59, 999);
  return new Date(endIst - IST_OFFSET_MS);
}

function fmtDate(d?: Date | string | null): string | null {
  if (!d) return null;
  const ist = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(ist.getUTCDate())}/${pad(ist.getUTCMonth() + 1)}/${ist.getUTCFullYear()}`;
}

function withDerivedStatus<T extends { status: string; validUntil: Date | null }>(row: T): T & { displayStatus: string } {
  const expired = row.status === 'GENERATED' && row.validUntil && row.validUntil.getTime() < Date.now();
  return { ...row, displayStatus: expired ? 'EXPIRED' : row.status };
}

interface ItemInput {
  productName: string;
  productDesc?: string | null;
  hsnCode: string;
  quantity: number;
  qtyUnit?: string;
  taxableAmount: number;
  gstRate?: number;   // convenience: split into CGST/SGST or IGST by state
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
  cessRate?: number;
}

export class EWayBillService {
  // ── Scope ───────────────────────────────────────────────────────────────
  private static scopeWhere(user: TokenPayload, franchiseId?: string) {
    if (user.role !== 'SUPER_ADMIN') return { franchiseId: user.franchiseId || '__UNASSIGNED__' };
    return franchiseId ? { franchiseId } : {};
  }

  private static async ownFranchiseId(user: TokenPayload): Promise<string | null> {
    if (user.role !== 'SUPER_ADMIN') return user.franchiseId || null;
    const hq = await FranchiseService.getHqFranchiseOrNull();
    return hq?.id || null;
  }

  private static async load(user: TokenPayload, id: string) {
    const row = await prisma.eWayBill.findUnique({
      where: { id },
      include: { items: { orderBy: { itemNo: 'asc' } }, vehicleUpdates: { orderBy: { createdAt: 'desc' } } },
    });
    if (!row) throw new AppError('E-Way Bill not found', 404);
    if (user.role !== 'SUPER_ADMIN' && row.franchiseId !== user.franchiseId) {
      throw new AppError('Forbidden: E-Way Bill belongs to another branch', 403);
    }
    return row;
  }

  // ── Reads ───────────────────────────────────────────────────────────────
  static async list(user: TokenPayload, q: { status?: string; search?: string; fromDate?: string; toDate?: string; franchiseId?: string }) {
    const where: any = { ...this.scopeWhere(user, q.franchiseId) };
    const now = new Date();
    if (q.status === 'EXPIRED') {
      where.status = 'GENERATED';
      where.validUntil = { lt: now };
    } else if (q.status === 'GENERATED') {
      where.status = 'GENERATED';
      where.OR = [{ validUntil: null }, { validUntil: { gte: now } }];
    } else if (q.status && q.status !== 'ALL') {
      where.status = q.status;
    }
    if (q.fromDate || q.toDate) {
      where.docDate = {};
      if (q.fromDate) where.docDate.gte = new Date(q.fromDate);
      if (q.toDate) {
        const end = new Date(q.toDate);
        end.setHours(23, 59, 59, 999);
        where.docDate.lte = end;
      }
    }
    if (q.search) {
      const s = q.search.trim();
      const searchOr = [
        { refNumber: { contains: s, mode: 'insensitive' } },
        { ewbNumber: { contains: s } },
        { docNo: { contains: s, mode: 'insensitive' } },
        { toTradeName: { contains: s, mode: 'insensitive' } },
        { vehicleNo: { contains: s.replace(/[\s-]/g, '').toUpperCase() } },
      ];
      where.AND = [{ OR: searchOr }];
    }
    const rows = await prisma.eWayBill.findMany({
      where,
      include: { _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(withDerivedStatus);
  }

  static async getById(user: TokenPayload, id: string) {
    return withDerivedStatus(await this.load(user, id));
  }

  static async stats(user: TokenPayload, franchiseId?: string) {
    const scope = this.scopeWhere(user, franchiseId);
    const now = new Date();
    const soon = new Date(now.getTime() + 24 * HOUR_MS);
    const [draft, active, expiringSoon, expired, cancelled, activeValue] = await Promise.all([
      prisma.eWayBill.count({ where: { ...scope, status: 'DRAFT' } }),
      prisma.eWayBill.count({ where: { ...scope, status: 'GENERATED', validUntil: { gte: now } } }),
      prisma.eWayBill.count({ where: { ...scope, status: 'GENERATED', validUntil: { gte: now, lte: soon } } }),
      prisma.eWayBill.count({ where: { ...scope, status: 'GENERATED', validUntil: { lt: now } } }),
      prisma.eWayBill.count({ where: { ...scope, status: 'CANCELLED' } }),
      prisma.eWayBill.aggregate({ where: { ...scope, status: 'GENERATED', validUntil: { gte: now } }, _sum: { totInvValue: true } }),
    ]);
    return { draft, active, expiringSoon, expired, cancelled, activeValue: round2(activeValue._sum.totInvValue || 0) };
  }

  // Consignor defaults — the company profile (Settings → Company).
  static async consignorDefaults() {
    const p = await SettingsService.getCompanyProfile();
    const gstin = String(p.gstNumber || p.gstin || '').toUpperCase();
    const stateCode = stateCodeFromGstin(gstin) ?? stateCodeFromName(p.state);
    return {
      fromGstin: gstin,
      fromTradeName: p.legalName || p.companyName || '',
      fromAddr1: p.address || '',
      fromAddr2: '',
      fromPlace: p.city || '',
      fromPincode: String(p.pincode || ''),
      fromStateCode: stateCode,
      actFromStateCode: stateCode,
    };
  }

  // ── Source documents ──────────────────────────────────────────────────────
  static async listSources(user: TokenPayload, sourceType: string, search?: string) {
    const franchiseId = await this.ownFranchiseId(user);
    const s = search?.trim();
    let docs: { id: string; docNo: string; date: Date; partyName: string; amount: number }[] = [];

    if (sourceType === 'SALE_INVOICE') {
      const where: any = { invoice: { isNot: null }, status: { not: 'CANCELLED' } };
      if (user.role !== 'SUPER_ADMIN') where.franchiseId = franchiseId || '__UNASSIGNED__';
      if (s) where.OR = [{ invoiceNum: { contains: s, mode: 'insensitive' } }, { customerName: { contains: s, mode: 'insensitive' } }];
      const orders = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 });
      docs = orders.map(o => ({ id: o.id, docNo: o.invoiceNum, date: o.createdAt, partyName: o.customerName || '—', amount: o.totalAmount }));
    } else if (sourceType === 'DELIVERY_CHALLAN') {
      const where: any = { status: { not: 'CANCELLED' } };
      if (user.role !== 'SUPER_ADMIN') where.OR = [{ sourceFranchiseId: franchiseId }, { franchiseId }];
      if (s) where.challanNumber = { contains: s, mode: 'insensitive' };
      const rows = await prisma.deliveryChallan.findMany({ where, include: { customer: true, dealer: true }, orderBy: { createdAt: 'desc' }, take: 50 });
      docs = rows.map(c => ({ id: c.id, docNo: c.challanNumber, date: c.challanDate, partyName: c.customer?.name || c.dealer?.name || '—', amount: c.totalAmount }));
    } else if (sourceType === 'STOCK_TRANSFER') {
      const where: any = { status: { not: 'CANCELLED' } };
      if (user.role !== 'SUPER_ADMIN') where.fromBranchId = franchiseId || '__UNASSIGNED__';
      const rows = await prisma.stockTransfer.findMany({
        where, include: { toBranch: true, items: { include: { inventoryItem: true } } }, orderBy: { createdAt: 'desc' }, take: 50,
      });
      docs = rows
        .map(t => ({
          id: t.id,
          docNo: `ST-${t.id.slice(0, 8).toUpperCase()}`,
          date: t.createdAt,
          partyName: t.toBranch?.name || '—',
          amount: round2(t.items.reduce((sum, i) => sum + i.quantity * (i.inventoryItem?.costPrice || 0), 0)),
        }))
        .filter(d => !s || d.docNo.includes(s.toUpperCase()) || d.partyName.toLowerCase().includes(s.toLowerCase()));
    } else {
      throw new AppError('sourceType must be SALE_INVOICE, DELIVERY_CHALLAN or STOCK_TRANSFER');
    }

    const existing = await prisma.eWayBill.findMany({
      where: { sourceType, sourceId: { in: docs.map(d => d.id) }, status: { not: 'CANCELLED' } },
      select: { sourceId: true, refNumber: true, ewbNumber: true, status: true },
    });
    const bySource = new Map(existing.map(e => [e.sourceId, e]));
    return docs.map(d => ({ ...d, existingEwb: bySource.get(d.id) || null }));
  }

  // Builds an unsaved EWB payload from a source document. The UI loads this
  // into the form; nothing is persisted until the user saves.
  static async prefill(user: TokenPayload, sourceType: string, sourceId: string) {
    const from = await this.consignorDefaults();
    const base: any = {
      sourceType, sourceId,
      supplyType: 'O', subSupplyType: '1', subSupplyDesc: '', docType: 'INV', transactionType: 1,
      ...from,
      toGstin: 'URP', toTradeName: '', toAddr1: '', toAddr2: '', toPlace: '', toPincode: '', toStateCode: null, actToStateCode: null,
      otherValue: 0, transMode: '1', transDistance: 0, vehicleType: 'R',
      items: [] as ItemInput[],
    };
    const fillParty = (p: any) => {
      if (!p) return;
      const gstin = String(p.gstNumber || '').trim().toUpperCase();
      base.toGstin = GSTIN_RE.test(gstin) ? gstin : 'URP';
      base.toTradeName = p.name || '';
      base.toAddr1 = p.shippingAddress || p.address || '';
      base.toPlace = p.city || p.district || '';
      base.toPincode = p.pincode || '';
      base.toStateCode = stateCodeFromGstin(base.toGstin) ?? stateCodeFromName(p.state);
      base.actToStateCode = stateCodeFromName(p.state) ?? base.toStateCode;
    };

    if (sourceType === 'SALE_INVOICE') {
      const order = await prisma.order.findUnique({ where: { id: sourceId }, include: { orderItems: { include: { product: true } }, customer: true } });
      if (!order) throw new AppError('Sale invoice not found', 404);
      if (user.role !== 'SUPER_ADMIN' && order.franchiseId !== user.franchiseId) throw new AppError('Forbidden', 403);
      base.docNo = order.invoiceNum;
      base.docDate = order.createdAt;
      if (order.partyType === 'DEALER' && order.partyId) fillParty(await prisma.dealer.findUnique({ where: { id: order.partyId } }));
      else if (order.partyType === 'FRANCHISE' && order.partyId) {
        const f = await prisma.franchise.findUnique({ where: { id: order.partyId } });
        base.toGstin = from.fromGstin || 'URP';
        base.toTradeName = f?.name || '';
        base.toAddr1 = f?.location || '';
        base.toStateCode = from.fromStateCode;
        base.actToStateCode = from.fromStateCode;
      } else fillParty(order.customer || (order.partyId ? await prisma.customer.findUnique({ where: { id: order.partyId } }) : null));
      if (!base.toTradeName) base.toTradeName = order.customerName || '';
      base.items = order.orderItems.map(i => {
        const taxable = i.totalAmount != null && i.taxAmount != null
          ? i.totalAmount - i.taxAmount
          : i.quantity * i.price * (1 - (i.discountPct || 0) / 100);
        const rate = i.taxAmount != null && taxable > 0 ? Math.round((i.taxAmount / taxable) * 100 * 4) / 4 : i.product?.taxPercent || 0;
        return {
          productName: i.product?.name || 'Item', hsnCode: i.product?.hsnCode || '', quantity: i.quantity,
          qtyUnit: toUqc(i.unit), taxableAmount: round2(taxable), gstRate: rate,
        };
      });
      const computed = base.items.reduce((s: number, i: any) => s + i.taxableAmount * (1 + i.gstRate / 100), 0);
      base.otherValue = Math.max(0, round2(order.totalAmount - computed));
    } else if (sourceType === 'DELIVERY_CHALLAN') {
      const dc = await prisma.deliveryChallan.findUnique({ where: { id: sourceId }, include: { items: true, customer: true, dealer: true } });
      if (!dc) throw new AppError('Delivery challan not found', 404);
      base.docType = 'CHL';
      base.subSupplyType = '8';
      base.subSupplyDesc = 'Delivery Challan';
      base.docNo = dc.challanNumber;
      base.docDate = dc.challanDate;
      base.vehicleNo = dc.vehicleNo || '';
      fillParty(dc.customer || dc.dealer);
      const ids = dc.items.map(i => i.productId).filter(Boolean) as string[];
      const [products, invItems] = await Promise.all([
        prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, hsnCode: true } }),
        prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, hsnCode: true } }),
      ]);
      const hsn = new Map([...invItems, ...products].map(p => [p.id, p.hsnCode || '']));
      base.items = dc.items.map(i => ({
        productName: i.productName, hsnCode: (i.productId && hsn.get(i.productId)) || '', quantity: i.quantity,
        qtyUnit: toUqc(i.unit), taxableAmount: round2(i.totalAmount - i.taxAmount || i.quantity * i.rate), gstRate: i.taxPercent || 0,
      }));
    } else if (sourceType === 'STOCK_TRANSFER') {
      const t = await prisma.stockTransfer.findUnique({ where: { id: sourceId }, include: { fromBranch: true, toBranch: true, items: { include: { inventoryItem: true } } } });
      if (!t) throw new AppError('Stock transfer not found', 404);
      if (user.role !== 'SUPER_ADMIN' && t.fromBranchId !== user.franchiseId) throw new AppError('Forbidden', 403);
      // Branch transfer under the same GSTIN: Outward / For Own Use / Delivery Challan.
      base.docType = 'CHL';
      base.subSupplyType = '5';
      base.docNo = `ST-${t.id.slice(0, 8).toUpperCase()}`;
      base.docDate = t.createdAt;
      base.fromPlace = t.fromBranch?.location || base.fromPlace;
      base.toGstin = from.fromGstin || 'URP';
      base.toTradeName = `${from.fromTradeName}${t.toBranch ? ` (${t.toBranch.name})` : ''}`;
      base.toAddr1 = t.toBranch?.location || '';
      base.toStateCode = from.fromStateCode;
      base.actToStateCode = from.fromStateCode;
      base.items = t.items.map(i => ({
        productName: i.inventoryItem?.name || 'Item', hsnCode: i.inventoryItem?.hsnCode || '', quantity: i.quantity,
        qtyUnit: toUqc(i.inventoryItem?.unit), taxableAmount: round2(i.quantity * (i.inventoryItem?.costPrice || 0)),
        gstRate: i.inventoryItem?.gstRate || 0,
      }));
    } else {
      throw new AppError('Unsupported sourceType');
    }

    // Split the flat GST rate into CGST+SGST or IGST using the place of supply.
    const inter = base.fromStateCode && base.actToStateCode && base.fromStateCode !== base.actToStateCode;
    base.items = base.items.map((i: any) => this.splitRate(i, !!inter));
    return base;
  }

  private static splitRate(i: ItemInput, interState: boolean) {
    const rate = Number(i.gstRate) || 0;
    const { gstRate, ...rest } = i;
    return interState
      ? { ...rest, igstRate: rate, cgstRate: 0, sgstRate: 0, cessRate: i.cessRate || 0 }
      : { ...rest, igstRate: 0, cgstRate: rate / 2, sgstRate: rate / 2, cessRate: i.cessRate || 0 };
  }

  // ── Normalization / validation ──────────────────────────────────────────
  // Returns a Prisma-ready header + items with totals recomputed from items.
  private static normalize(data: any) {
    const errors: string[] = [];
    const up = (v: any) => String(v ?? '').trim().toUpperCase();
    const str = (v: any) => { const s = String(v ?? '').trim(); return s || null; };

    const supplyType = up(data.supplyType) || 'O';
    const subSupplyType = String(data.subSupplyType || '1');
    const docType = up(data.docType) || 'INV';
    const allowedDocs = SUPPLY_DOC_MATRIX[supplyType]?.[subSupplyType];
    if (!SUPPLY_DOC_MATRIX[supplyType]) errors.push('Supply type must be Outward (O) or Inward (I)');
    else if (!allowedDocs) errors.push(`Sub-supply type "${SUB_SUPPLY_TYPES[subSupplyType] || subSupplyType}" is not allowed for ${supplyType === 'O' ? 'Outward' : 'Inward'} supply`);
    else if (!allowedDocs.includes(docType)) errors.push(`Document type ${docType} is not allowed with sub-supply "${SUB_SUPPLY_TYPES[subSupplyType]}" (allowed: ${allowedDocs.join(', ')})`);
    if (subSupplyType === '8' && !str(data.subSupplyDesc)) errors.push('Sub-supply description is required when sub-supply type is Others');

    const docNo = String(data.docNo || '').trim();
    if (!DOC_NO_RE.test(docNo)) errors.push('Document No. must be 1–16 characters (letters, digits, / and -), not starting with 0, / or -');
    const docDate = data.docDate ? new Date(data.docDate) : null;
    if (!docDate || isNaN(docDate.getTime())) errors.push('Document date is required');
    else if (docDate.getTime() > Date.now() + 24 * HOUR_MS) errors.push('Document date cannot be in the future');

    const transactionType = Number(data.transactionType) || 1;
    if (![1, 2, 3, 4].includes(transactionType)) errors.push('Transaction type must be 1–4');

    const party = (prefix: 'from' | 'to') => {
      const label = prefix === 'from' ? 'Consignor' : 'Consignee';
      const gstin = up(data[`${prefix}Gstin`]) || 'URP';
      if (gstin !== 'URP' && !GSTIN_RE.test(gstin)) errors.push(`${label} GSTIN "${gstin}" is invalid (use URP for unregistered)`);
      const tradeName = String(data[`${prefix}TradeName`] || '').trim();
      if (!tradeName) errors.push(`${label} name is required`);
      const pincode = String(data[`${prefix}Pincode`] || '').trim();
      if (!PINCODE_RE.test(pincode)) errors.push(`${label} pincode must be a valid 6-digit PIN`);
      const stateCode = Number(data[`${prefix}StateCode`]);
      if (!INDIAN_GST_STATE_MAP[String(stateCode).padStart(2, '0')]) errors.push(`${label} state is required`);
      else if (gstin !== 'URP' && stateCodeFromGstin(gstin) !== stateCode) errors.push(`${label} state must match GSTIN state code (${gstin.slice(0, 2)})`);
      const actKey = prefix === 'from' ? 'actFromStateCode' : 'actToStateCode';
      const act = Number(data[actKey]) || stateCode;
      if (!INDIAN_GST_STATE_MAP[String(act).padStart(2, '0')]) errors.push(`${label} actual ${prefix === 'from' ? 'dispatch' : 'ship-to'} state is invalid`);
      return {
        [`${prefix}Gstin`]: gstin, [`${prefix}TradeName`]: tradeName,
        [`${prefix}Addr1`]: str(data[`${prefix}Addr1`]), [`${prefix}Addr2`]: str(data[`${prefix}Addr2`]),
        [`${prefix}Place`]: str(data[`${prefix}Place`]), [`${prefix}Pincode`]: pincode,
        [`${prefix}StateCode`]: stateCode, [actKey]: act,
      };
    };
    const fromParty = party('from');
    const toParty = party('to');
    if (supplyType === 'O' && fromParty.fromGstin === 'URP') errors.push('Consignor GSTIN is required for outward supply — set it in Settings → Company Profile');

    const rawItems: any[] = Array.isArray(data.items) ? data.items : [];
    if (rawItems.length === 0) errors.push('Add at least one item');
    const items = rawItems.map((it, idx) => {
      const n = idx + 1;
      const hsnCode = String(it.hsnCode || '').trim();
      if (!String(it.productName || '').trim()) errors.push(`Item ${n}: product name is required`);
      if (!HSN_RE.test(hsnCode)) errors.push(`Item ${n}: HSN code must be 4–8 digits`);
      const quantity = Number(it.quantity);
      if (!(quantity > 0)) errors.push(`Item ${n}: quantity must be greater than 0`);
      const qtyUnit = up(it.qtyUnit) || 'NOS';
      if (!isValidUqc(qtyUnit)) errors.push(`Item ${n}: unit "${qtyUnit}" is not a valid GST UQC`);
      const taxableAmount = round2(it.taxableAmount);
      if (!(taxableAmount >= 0)) errors.push(`Item ${n}: taxable value cannot be negative`);
      const rates = ['cgstRate', 'sgstRate', 'igstRate', 'cessRate'].map(k => Number(it[k]) || 0);
      if (rates.some(r => r < 0 || r > 100)) errors.push(`Item ${n}: tax rates must be between 0 and 100`);
      return {
        itemNo: n, productName: String(it.productName || '').trim(), productDesc: str(it.productDesc), hsnCode,
        quantity, qtyUnit, taxableAmount,
        cgstRate: rates[0], sgstRate: rates[1], igstRate: rates[2], cessRate: rates[3],
      };
    });

    const inter = fromParty.actFromStateCode !== toParty.actToStateCode;
    items.forEach(i => {
      if (inter && (i.cgstRate || i.sgstRate)) errors.push(`Item ${i.itemNo}: inter-state movement must use IGST, not CGST/SGST`);
      if (!inter && i.igstRate) errors.push(`Item ${i.itemNo}: intra-state movement must use CGST/SGST, not IGST`);
    });

    const sum = (fn: (i: typeof items[number]) => number) => round2(items.reduce((s, i) => s + fn(i), 0));
    const totalValue = sum(i => i.taxableAmount);
    const cgstValue = sum(i => i.taxableAmount * i.cgstRate / 100);
    const sgstValue = sum(i => i.taxableAmount * i.sgstRate / 100);
    const igstValue = sum(i => i.taxableAmount * i.igstRate / 100);
    const cessValue = sum(i => i.taxableAmount * i.cessRate / 100);
    const otherValue = round2(data.otherValue || 0);
    const totInvValue = round2(totalValue + cgstValue + sgstValue + igstValue + cessValue + otherValue);
    if (items.length && totInvValue <= 0) errors.push('Total invoice value must be greater than 0');

    // Part B — optional while drafting, enforced at generation.
    const transMode = str(data.transMode);
    if (transMode && !TRANS_MODES[transMode]) errors.push('Transport mode must be Road, Rail, Air or Ship');
    const transDistance = Math.round(Number(data.transDistance) || 0);
    if (transDistance < 0 || transDistance > 4000) errors.push('Approximate distance must be between 1 and 4000 km');
    const transporterId = up(data.transporterId) || null;
    if (transporterId && !TRANSPORTER_ID_RE.test(transporterId)) errors.push('Transporter ID must be a 15-character GSTIN/TRANSIN');
    const vehicleNo = normalizeVehicle(data.vehicleNo);
    if (vehicleNo && !VEHICLE_RE.some(re => re.test(vehicleNo))) errors.push(`Vehicle number "${vehicleNo}" is not in a valid format (e.g. TN01AB1234)`);
    const vehicleType = up(data.vehicleType) === 'O' ? 'O' : 'R';
    const transDocDate = data.transDocDate ? new Date(data.transDocDate) : null;

    if (errors.length) throw new AppError(errors.join('\n'), 422);

    return {
      header: {
        supplyType, subSupplyType, subSupplyDesc: str(data.subSupplyDesc), docType, docNo, docDate: docDate!, transactionType,
        ...fromParty, ...toParty,
        totalValue, cgstValue, sgstValue, igstValue, cessValue, otherValue, totInvValue,
        transMode, transDistance, transporterId, transporterName: str(data.transporterName),
        transDocNo: str(data.transDocNo), transDocDate, vehicleNo, vehicleType, notes: str(data.notes),
      } as any,
      items,
    };
  }

  private static assertPartBComplete(h: { transMode: string | null; vehicleNo: string | null; transDocNo: string | null; transDocDate: Date | null; transporterId: string | null; transDistance: number }) {
    const errors: string[] = [];
    if (!(h.transDistance > 0)) errors.push('Approximate distance (km) is required');
    if (!h.transMode) {
      if (!h.transporterId) errors.push('Enter transport details (Part B), or a Transporter ID so the transporter can fill Part B');
    } else if (h.transMode === '1') {
      if (!h.vehicleNo) errors.push('Vehicle number is required for road transport');
    } else if (!h.transDocNo || !h.transDocDate) {
      errors.push(`Transport document no. and date are required for ${TRANS_MODES[h.transMode]} transport`);
    }
    if (errors.length) throw new AppError(errors.join('\n'), 422);
  }

  private static async assertNoDuplicate(h: { sourceType?: string; sourceId?: string | null; docNo: string; docType: string; fromGstin: string }, excludeId?: string) {
    const notSelf = excludeId ? { id: { not: excludeId } } : {};
    if (h.sourceId && h.sourceType !== 'MANUAL') {
      const dup = await prisma.eWayBill.findFirst({ where: { ...notSelf, sourceType: h.sourceType, sourceId: h.sourceId, status: { not: 'CANCELLED' } } });
      if (dup) throw new AppError(`This document already has an active E-Way Bill (${dup.ewbNumber || dup.refNumber})`, 409);
    }
    const dupDoc = await prisma.eWayBill.findFirst({
      where: { ...notSelf, docNo: h.docNo, docType: h.docType, fromGstin: h.fromGstin, status: 'GENERATED' },
    });
    if (dupDoc) throw new AppError(`An E-Way Bill (${dupDoc.ewbNumber}) is already generated for ${h.docType} ${h.docNo}`, 409);
  }

  // ── Writes ──────────────────────────────────────────────────────────────
  static async create(user: TokenPayload, data: any) {
    const sourceType: SourceType = SOURCE_TYPES.includes(data.sourceType) ? data.sourceType : 'MANUAL';
    const sourceId = sourceType === 'MANUAL' ? null : (data.sourceId || null);
    const { header, items } = this.normalize(data);
    await this.assertNoDuplicate({ ...header, sourceType, sourceId });
    const franchiseId = await this.ownFranchiseId(user);

    const created = await prisma.$transaction(async (tx: any) => {
      const seq = await tx.numberSequence.upsert({
        where: { key: 'EWB_REF' }, create: { key: 'EWB_REF', value: 1 }, update: { value: { increment: 1 } },
      });
      return tx.eWayBill.create({
        data: {
          ...header, refNumber: `EWB-DFT-${String(seq.value).padStart(5, '0')}`,
          sourceType, sourceId, franchiseId, createdBy: user.userId,
          items: { create: items },
        },
      });
    });
    return this.getById(user, created.id);
  }

  static async update(user: TokenPayload, id: string, data: any) {
    const row = await this.load(user, id);
    if (row.status !== 'DRAFT') throw new AppError('Only draft E-Way Bills can be edited. Use "Update Vehicle" for Part B changes.', 409);
    const { header, items } = this.normalize(data);
    await this.assertNoDuplicate({ ...header, sourceType: row.sourceType, sourceId: row.sourceId }, id);
    await prisma.$transaction(async (tx: any) => {
      await tx.eWayBillItem.deleteMany({ where: { ewayBillId: id } });
      await tx.eWayBill.update({ where: { id }, data: { ...header, items: { create: items } } });
    });
    return this.getById(user, id);
  }

  static async remove(user: TokenPayload, id: string) {
    const row = await this.load(user, id);
    if (row.status !== 'DRAFT') throw new AppError('Only draft E-Way Bills can be deleted — cancel a generated one instead', 409);
    await prisma.eWayBill.delete({ where: { id } });
    return { success: true };
  }

  // Records the EWB number issued by the NIC portal.
  static async markGenerated(user: TokenPayload, id: string, body: { ewbNumber?: string; ewbDate?: string; validUntil?: string }) {
    const row = await this.load(user, id);
    if (row.status !== 'DRAFT') throw new AppError(`E-Way Bill is already ${row.status.toLowerCase()}`, 409);
    const ewbNumber = String(body.ewbNumber || '').replace(/\s/g, '');
    if (!EWB_NO_RE.test(ewbNumber)) throw new AppError('E-Way Bill number must be exactly 12 digits', 422);
    const taken = await prisma.eWayBill.findUnique({ where: { ewbNumber } });
    if (taken) throw new AppError(`EWB number ${ewbNumber} is already recorded on ${taken.refNumber}`, 409);
    this.assertPartBComplete(row);
    await this.assertNoDuplicate(row, id);

    const ewbDate = body.ewbDate ? new Date(body.ewbDate) : new Date();
    if (isNaN(ewbDate.getTime()) || ewbDate.getTime() > Date.now() + 5 * 60 * 1000) throw new AppError('Generation date/time is invalid or in the future', 422);
    if (ewbDate.getTime() < row.docDate.getTime() - 24 * HOUR_MS) throw new AppError('E-Way Bill cannot be generated before the document date', 422);
    // Part-A-only slips (no vehicle yet) have no validity until Part B is entered.
    const hasPartB = !!(row.vehicleNo || row.transDocNo);
    let validUntil: Date | null = hasPartB ? computeValidUntil(ewbDate, row.transDistance, row.vehicleType) : null;
    if (body.validUntil) {
      // Portal's printed validity wins if the user supplies it.
      const v = new Date(body.validUntil);
      if (isNaN(v.getTime()) || v <= ewbDate) throw new AppError('Valid-until must be after the generation time', 422);
      validUntil = v;
    }
    await prisma.eWayBill.update({ where: { id }, data: { status: 'GENERATED', ewbNumber, ewbDate, validUntil } });
    return this.getById(user, id);
  }

  static async updateVehicle(user: TokenPayload, id: string, body: any) {
    const row = await this.load(user, id);
    if (row.status !== 'GENERATED') throw new AppError('Vehicle can only be updated on a generated E-Way Bill', 409);
    if (row.validUntil && row.validUntil.getTime() < Date.now()) throw new AppError('E-Way Bill has expired — extend its validity first', 409);
    const reasonCode = String(body.reasonCode || '');
    if (!VEHICLE_UPDATE_REASONS[reasonCode]) throw new AppError('Select a reason for the vehicle update', 422);
    if (reasonCode === '3' && !String(body.reasonRemarks || '').trim()) throw new AppError('Remarks are required when reason is Others', 422);
    const transMode = String(body.transMode || row.transMode || '1');
    if (!TRANS_MODES[transMode]) throw new AppError('Invalid transport mode', 422);
    const vehicleNo = normalizeVehicle(body.vehicleNo);
    if (transMode === '1') {
      if (!vehicleNo) throw new AppError('Vehicle number is required for road transport', 422);
      if (!VEHICLE_RE.some(re => re.test(vehicleNo))) throw new AppError(`Vehicle number "${vehicleNo}" is not in a valid format`, 422);
    } else if (!body.transDocNo || !body.transDocDate) {
      throw new AppError('Transport document no. and date are required', 422);
    }
    const fromPlace = String(body.fromPlace || '').trim();
    const fromStateCode = Number(body.fromStateCode);
    if (!fromPlace) throw new AppError('Current place (from where the vehicle starts) is required', 422);
    if (!INDIAN_GST_STATE_MAP[String(fromStateCode).padStart(2, '0')]) throw new AppError('Current state is required', 422);

    const transDocDate = body.transDocDate ? new Date(body.transDocDate) : null;
    const firstPartB = !row.vehicleNo && !row.transDocNo;
    await prisma.$transaction([
      prisma.eWayBillVehicleUpdate.create({
        data: {
          ewayBillId: id, kind: 'VEHICLE', vehicleNo, transMode, transDocNo: body.transDocNo || null, transDocDate,
          fromPlace, fromStateCode, reasonCode, reasonRemarks: body.reasonRemarks || null, createdBy: user.userId,
        },
      }),
      prisma.eWayBill.update({
        where: { id },
        data: {
          vehicleNo, transMode, transDocNo: body.transDocNo || row.transDocNo, transDocDate: transDocDate || row.transDocDate,
          // Validity starts when Part B is first entered on a Part-A-only slip.
          ...(firstPartB && !row.validUntil ? { validUntil: computeValidUntil(new Date(), row.transDistance, row.vehicleType) } : {}),
        },
      }),
    ]);
    return this.getById(user, id);
  }

  // Extension is allowed from 8 hours before until 8 hours after expiry;
  // new validity is computed from now over the remaining distance.
  static async extendValidity(user: TokenPayload, id: string, body: any) {
    const row = await this.load(user, id);
    if (row.status !== 'GENERATED' || !row.validUntil) throw new AppError('Only a generated E-Way Bill with a validity period can be extended', 409);
    const now = Date.now();
    const exp = row.validUntil.getTime();
    if (now < exp - 8 * HOUR_MS || now > exp + 8 * HOUR_MS) {
      throw new AppError('Validity can only be extended within 8 hours before or after expiry', 409);
    }
    const reasonCode = String(body.reasonCode || '');
    if (!EXTENSION_REASONS[reasonCode]) throw new AppError('Select a reason for extension', 422);
    const remainingKm = Math.round(Number(body.remainingKm) || 0);
    if (remainingKm < 1 || remainingKm > 4000) throw new AppError('Remaining distance must be between 1 and 4000 km', 422);
    const fromPlace = String(body.fromPlace || '').trim();
    const fromStateCode = Number(body.fromStateCode);
    if (!fromPlace || !INDIAN_GST_STATE_MAP[String(fromStateCode).padStart(2, '0')]) throw new AppError('Current place and state are required', 422);

    const validUntil = computeValidUntil(new Date(), remainingKm, row.vehicleType);
    await prisma.$transaction([
      prisma.eWayBillVehicleUpdate.create({
        data: {
          ewayBillId: id, kind: 'EXTENSION', vehicleNo: row.vehicleNo, transMode: row.transMode, fromPlace, fromStateCode,
          reasonCode, reasonRemarks: body.reasonRemarks || null, remainingKm, validUntil, createdBy: user.userId,
        },
      }),
      prisma.eWayBill.update({ where: { id }, data: { validUntil, extensionCount: { increment: 1 } } }),
    ]);
    return this.getById(user, id);
  }

  static async cancel(user: TokenPayload, id: string, body: { reasonCode?: string; remarks?: string }) {
    const row = await this.load(user, id);
    if (row.status !== 'GENERATED') throw new AppError('Only a generated E-Way Bill can be cancelled (delete drafts instead)', 409);
    if (row.ewbDate && Date.now() - row.ewbDate.getTime() > 24 * HOUR_MS) {
      throw new AppError('E-Way Bill can only be cancelled within 24 hours of generation', 409);
    }
    const reasonCode = String(body.reasonCode || '');
    if (!CANCEL_REASONS[reasonCode]) throw new AppError('Select a cancellation reason', 422);
    if (reasonCode === '4' && !String(body.remarks || '').trim()) throw new AppError('Remarks are required when reason is Others', 422);
    await prisma.eWayBill.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: reasonCode, cancelRemarks: body.remarks || null, cancelledAt: new Date() },
    });
    return this.getById(user, id);
  }

  // ── NIC bulk-upload JSON ────────────────────────────────────────────────
  static async exportNicJson(user: TokenPayload, ids: string[]) {
    if (!ids.length) throw new AppError('Select at least one E-Way Bill to export');
    const rows = await Promise.all(ids.map(id => this.load(user, id)));
    const notDraft = rows.filter(r => r.status !== 'DRAFT');
    if (notDraft.length) throw new AppError(`Only drafts can be exported for generation (${notDraft.map(r => r.refNumber).join(', ')} already ${notDraft[0].status.toLowerCase()})`, 409);
    rows.forEach(r => this.assertPartBCompleteForExport(r));

    const mainHsn = (items: any[]) => [...items].sort((a, b) => b.taxableAmount - a.taxableAmount)[0]?.hsnCode;
    return {
      version: '1.0.0621',
      billLists: rows.map(r => ({
        userGstin: r.fromGstin,
        supplyType: r.supplyType,
        subSupplyType: Number(r.subSupplyType),
        subSupplyDesc: r.subSupplyDesc || '',
        docType: r.docType,
        docNo: r.docNo,
        docDate: fmtDate(r.docDate),
        transType: r.transactionType,
        fromGstin: r.fromGstin,
        fromTrdName: r.fromTradeName,
        fromAddr1: r.fromAddr1 || '',
        fromAddr2: r.fromAddr2 || '',
        fromPlace: r.fromPlace || '',
        fromPincode: Number(r.fromPincode),
        fromStateCode: r.fromStateCode,
        actualFromStateCode: r.actFromStateCode,
        toGstin: r.toGstin,
        toTrdName: r.toTradeName,
        toAddr1: r.toAddr1 || '',
        toAddr2: r.toAddr2 || '',
        toPlace: r.toPlace || '',
        toPincode: Number(r.toPincode),
        toStateCode: r.toStateCode,
        actualToStateCode: r.actToStateCode,
        totalValue: r.totalValue,
        cgstValue: r.cgstValue,
        sgstValue: r.sgstValue,
        igstValue: r.igstValue,
        cessValue: r.cessValue,
        TotNonAdvolVal: 0,
        OthValue: r.otherValue,
        totInvValue: r.totInvValue,
        transMode: r.transMode ? Number(r.transMode) : '',
        transDistance: r.transDistance,
        transporterName: r.transporterName || '',
        transporterId: r.transporterId || '',
        transDocNo: r.transDocNo || '',
        transDocDate: fmtDate(r.transDocDate) || '',
        vehicleNo: r.vehicleNo || '',
        vehicleType: r.vehicleType,
        mainHsnCode: Number(mainHsn(r.items)),
        itemList: r.items.map(i => ({
          itemNo: i.itemNo,
          productName: i.productName,
          productDesc: i.productDesc || i.productName,
          hsnCode: Number(i.hsnCode),
          quantity: i.quantity,
          qtyUnit: i.qtyUnit,
          taxableAmount: i.taxableAmount,
          sgstRate: i.sgstRate,
          cgstRate: i.cgstRate,
          igstRate: i.igstRate,
          cessRate: i.cessRate,
          cessNonAdvol: 0,
        })),
      })),
    };
  }

  private static assertPartBCompleteForExport(r: any) {
    try {
      this.assertPartBComplete(r);
    } catch (e: any) {
      throw new AppError(`${r.refNumber}: ${e.message}`, 422);
    }
  }
}
