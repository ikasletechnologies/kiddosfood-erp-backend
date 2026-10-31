import axios from 'axios';
import prisma from '../../lib/prisma';

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTIN_API_BASE_URL = (process.env.GSTIN_API_BASE_URL || 'https://www.gstinapi.in').replace(/\/$/, '');

const GST_STATE_MAP: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

export interface GstinDetails {
  gstin: string;
  legalName: string;
  tradeName: string;
  status: string;
  constitution: string;
  taxpayerType: string;
  registrationDate: string;
  pan: string;
  address: string;
  state: string;
  city: string;
  district: string;
  pinCode: string;
  natureOfBusiness: string[];
}

// Non-2xx statuses upstream documents explicitly; anything else surfaces as a generic upstream failure.
class GstVerifyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

type CachedRow = {
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  status: string | null;
  constitution: string | null;
  taxpayerType: string | null;
  registrationDate: string | null;
  pan: string | null;
  address: string | null;
  state: string | null;
  natureOfBusiness: unknown;
  raw?: unknown;
};

export class GstService {
  static isValidGstin(gstin: string): boolean {
    return GSTIN_REGEX.test(gstin);
  }

  static async verify(
    gstinRaw: string,
    forceRefresh = false
  ): Promise<{ details: GstinDetails; cached: boolean }> {
    const gstin = gstinRaw.trim().toUpperCase();
    if (!this.isValidGstin(gstin)) {
      throw new GstVerifyError(
        'Invalid GSTIN format. Must be a 15-character alphanumeric code.',
        400
      );
    }

    if (!forceRefresh) {
      const cached = await prisma.gstinCache.findUnique({ where: { gstin } });
      if (cached) {
        return { details: this.toDetails(cached), cached: true };
      }
    }

    const apiKey = process.env.GSTIN_API_KEY;
    if (!apiKey) {
      throw new GstVerifyError('GSTIN_API_KEY is not configured on the server.', 500);
    }

    const response = await axios.get(`${GSTIN_API_BASE_URL}/v1/gstin/${encodeURIComponent(gstin)}`, {
      headers: { 'x-api-key': apiKey },
      params: { include: 'profile' },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (response.status !== 200 || !response.data?.success) {
      const message = response.data?.error || `GSTIN lookup failed (${response.status})`;
      // 429 (rate limit) is worth surfacing as-is; everything else (bad/expired
      // key, no credits, upstream GST outage) is a server-side problem, not
      // the caller's, so it comes back as a generic upstream failure.
      throw new GstVerifyError(message, response.status === 429 ? 429 : 502);
    }

    const raw = response.data.data || {};
    const address = raw.address || '';
    const state = raw.address_details?.state || GST_STATE_MAP[String(raw.state_code || gstin.slice(0, 2))] || '';
    const derived = this.deriveLocation(address, state);
    const details: GstinDetails = {
      gstin: raw.gstin || gstin,
      legalName: raw.legal_name || raw.trade_name || 'Unknown Business',
      tradeName: raw.trade_name || raw.legal_name || '',
      status: raw.status || 'UNKNOWN',
      constitution: raw.business_constitution || '',
      taxpayerType: raw.taxpayer_type || 'Regular',
      registrationDate: raw.registration_date || '',
      pan: raw.pan || gstin.substring(2, 12),
      address,
      state,
      city: raw.address_details?.city || raw.city || '',
      district: raw.address_details?.district || raw.district || '',
      pinCode: String(raw.address_details?.pincode || raw.pincode || derived.pinCode),
      natureOfBusiness: Array.isArray(raw.nature_of_business) ? raw.nature_of_business : [],
    };

    // Save to gstinCache for instant subsequent hits
    const { gstin: _gstin, city: _city, district: _district, pinCode: _pinCode, ...persisted } = details;
    await prisma.gstinCache.upsert({
      where: { gstin },
      create: { gstin, ...persisted, raw },
      update: { ...persisted, raw, fetchedAt: new Date() },
    });

    return { details, cached: false };
  }

  private static toDetails(cached: CachedRow): GstinDetails {
    // Location fields are preserved in raw because the cache has no dedicated columns.
    const raw = cached.raw && typeof cached.raw === 'object' && !Array.isArray(cached.raw)
      ? cached.raw as Record<string, any> : {};
    const address = cached.address || raw.address || '';
    const state = cached.state || GST_STATE_MAP[cached.gstin.substring(0, 2)] || '';
    const derived = this.deriveLocation(address, state);

    return {
      gstin: cached.gstin,
      legalName: cached.legalName || 'Unknown Business',
      tradeName: cached.tradeName || cached.legalName || '',
      status: cached.status || 'UNKNOWN',
      constitution: cached.constitution || '',
      taxpayerType: cached.taxpayerType || 'Regular',
      registrationDate: cached.registrationDate || '',
      pan: cached.pan || (cached.gstin.length >= 12 ? cached.gstin.substring(2, 12) : ''),
      address,
      state,
      city: raw.address_details?.city || raw.city || '',
      district: raw.address_details?.district || raw.district || '',
      pinCode: String(raw.address_details?.pincode || raw.pincode || derived.pinCode),
      natureOfBusiness: Array.isArray(cached.natureOfBusiness)
        ? (cached.natureOfBusiness as string[])
        : [],
    };
  }

  private static deriveLocation(
    address: string,
    state: string
  ): { city: string; pinCode: string } {
    if (!address) return { city: '', pinCode: '' };

    const pinMatches = address.match(/\d{6}(?!\d)/g);
    const pinCode = pinMatches?.length ? pinMatches[pinMatches.length - 1] : '';

    const withoutPin = address.replace(/[\s,\-–—]*\d{6}\s*$/, '').trim();
    const segments = withoutPin
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !/^\d+$/.test(s) && s.toLowerCase() !== state.trim().toLowerCase());

    const city = segments.length ? segments[segments.length - 1] : '';
    return { city, pinCode };
  }
}

export { GstVerifyError };
