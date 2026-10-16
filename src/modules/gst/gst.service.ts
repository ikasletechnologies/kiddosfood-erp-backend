import axios from 'axios';
import prisma from '../../lib/prisma';

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTVERIFY_BASE_URL = process.env.GSTVERIFY_BASE_URL || 'https://gstverify.co.in/api/v1/verify';
const SANDBOX_PRODUCTION_URL = 'https://api.sandbox.co.in';
const SANDBOX_TEST_URL = 'https://test-api.sandbox.co.in';
const SANDBOX_BASE_URL = process.env.SANDBOX_BASE_URL || 'https://api.sandbox.co.in';

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
};

// In-memory token cache for Sandbox.co.in API (valid for 24h)
class SandboxAuth {
  private static cachedToken: string | null = null;
  private static tokenExpiresAt = 0;

  static async getAccessToken(apiKey: string, apiSecret: string): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.tokenExpiresAt > now + 60_000) {
      return this.cachedToken;
    }

    try {
      const response = await axios.post(
        `${SANDBOX_BASE_URL}/authenticate`,
        {},
        {
          headers: {
            'x-api-key': apiKey,
            'x-api-secret': apiSecret,
            'x-api-version': '1.0.0',
            'Content-Type': 'application/json',
          },
          validateStatus: () => true,
        }
      );

      if (response.status !== 200 || !response.data?.data?.access_token) {
        const errorMsg =
          response.data?.message ||
          response.data?.error ||
          `Sandbox authentication failed (HTTP ${response.status})`;
        throw new GstVerifyError(errorMsg, response.status === 401 ? 401 : 502);
      }

      this.cachedToken = response.data.data.access_token as string;
      this.tokenExpiresAt = now + 23 * 60 * 60 * 1000; // cache for 23 hours
      return this.cachedToken;
    } catch (err: any) {
      if (err instanceof GstVerifyError) throw err;
      throw new GstVerifyError(
        `Failed to authenticate with Sandbox API: ${err.message}`,
        502
      );
    }
  }
}

export class GstService {
  private static sandboxToken: { value: string; expiresAt: number } | null = null;

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

    const apiKey = process.env.GSTVERIFY_API_KEY;
    if (!apiKey) {
      throw new GstVerifyError('GSTVERIFY_API_KEY is not configured on the server.', 500);
    }

    const response = await axios.get(`${GSTVERIFY_BASE_URL}/${gstin}`, {
      headers: { 'X-API-Key': apiKey },
      validateStatus: () => true,
    });

    if (response.status !== 200 || !response.data?.success) {
      const message = response.data?.error || `GSTVerify lookup failed (${response.status})`;
      // 429 (rate limit) is worth surfacing as-is; everything else (bad/expired
      // key, no credits, upstream GST outage) is a server-side problem, not
      // the caller's, so it comes back as a generic upstream failure.
      throw new GstVerifyError(message, response.status === 429 ? 429 : 502);
    }

    const raw = response.data.data || {};
    const address = raw.address || '';
    const state = raw.state || '';
    const details: GstinDetails = {
      gstin: raw.gstin || gstin,
      legalName: raw.legal_name || raw.trade_name || 'Unknown Business',
      tradeName: raw.trade_name || raw.legal_name || '',
      status: raw.status || 'UNKNOWN',
      constitution: raw.constitution || '',
      taxpayerType: raw.taxpayer_type || 'Regular',
      registrationDate: raw.registration_date || '',
      pan: raw.pan || '',
      address,
      state,
      ...this.deriveLocation(address, state),
      natureOfBusiness: Array.isArray(raw.nature_of_business) ? raw.nature_of_business : [],
    };

    // Save to gstinCache for instant subsequent hits
    const { gstin: _gstin, city: _city, pinCode: _pinCode, ...persisted } = details;
    await prisma.gstinCache.upsert({
      where: { gstin },
      create: { gstin, ...persisted, raw },
      update: { ...persisted, raw, fetchedAt: new Date() },
    });

    return { details, cached: false };
  }

  private static toDetails(cached: CachedRow): GstinDetails {
    const address = cached.address || '';
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
      city: derived.city,
      pinCode: derived.pinCode,
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
