import axios from 'axios';
import prisma from '../../lib/prisma';

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTVERIFY_BASE_URL = process.env.GSTVERIFY_BASE_URL || 'https://gstverify.co.in/api/v1/verify';
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

    // Check credentials for Sandbox.co.in and GSTVerify.co.in
    const sandboxKey = process.env.SANDBOX_API_KEY || process.env.GST_API_KEY;
    const sandboxSecret = process.env.SANDBOX_API_SECRET || process.env.GST_API_SECRET;
    const gstverifyKey = process.env.GSTVERIFY_API_KEY;

    let raw: any = null;

    if (sandboxKey) {
      // Use Sandbox.co.in Tax API
      raw = await this.fetchFromSandbox(gstin, sandboxKey, sandboxSecret);
    } else if (gstverifyKey) {
      // Use GSTVerify.co.in API
      raw = await this.fetchFromGstVerify(gstin, gstverifyKey);
    } else {
      // Neither API key is configured
      // If dev fallback is enabled via GST_MOCK_FALLBACK=true or in local dev without keys
      if (process.env.GST_MOCK_FALLBACK === 'true') {
        const derivedDetails = this.createFallbackDetails(gstin);
        return { details: derivedDetails, cached: false };
      }

      throw new GstVerifyError(
        'GST API credentials are not configured on the server. Please configure SANDBOX_API_KEY and SANDBOX_API_SECRET (for Sandbox.co.in) or GSTVERIFY_API_KEY in the backend .env file.',
        500
      );
    }

    const details = this.normalizeDetails(gstin, raw);

    // Save to gstinCache for instant subsequent hits
    const { gstin: _gstin, city: _city, pinCode: _pinCode, ...persisted } = details;
    await prisma.gstinCache.upsert({
      where: { gstin },
      create: { gstin, ...persisted, raw },
      update: { ...persisted, raw, fetchedAt: new Date() },
    });

    return { details, cached: false };
  }

  private static async fetchFromSandbox(
    gstin: string,
    apiKey: string,
    apiSecret?: string
  ): Promise<any> {
    if (!apiSecret) {
      throw new GstVerifyError(
        'SANDBOX_API_SECRET is required when using Sandbox.co.in. Please add SANDBOX_API_SECRET to .env',
        500
      );
    }

    const accessToken = await SandboxAuth.getAccessToken(apiKey, apiSecret);

    const response = await axios.post(
      `${SANDBOX_BASE_URL}/gst/compliance/public/gstin/search`,
      { gstin },
      {
        headers: {
          'x-api-key': apiKey,
          authorization: accessToken,
          'x-api-version': '1.0',
          'Content-Type': 'application/json',
        },
        validateStatus: () => true,
      }
    );

    if (response.status !== 200 || !response.data) {
      const msg =
        response.data?.message ||
        response.data?.error ||
        `Sandbox GST lookup failed (${response.status})`;
      throw new GstVerifyError(msg, response.status === 429 ? 429 : response.status >= 400 && response.status < 500 ? response.status : 502);
    }

    return response.data?.data?.data || response.data?.data || response.data;
  }

  private static async fetchFromGstVerify(gstin: string, apiKey: string): Promise<any> {
    const response = await axios.get(`${GSTVERIFY_BASE_URL}/${gstin}`, {
      headers: { 'X-API-Key': apiKey },
      validateStatus: () => true,
    });

    if (response.status !== 200 || !response.data?.success) {
      const message = response.data?.error || `GSTVerify lookup failed (${response.status})`;
      throw new GstVerifyError(message, response.status === 429 ? 429 : 502);
    }

    return response.data?.data || {};
  }

  private static normalizeDetails(gstin: string, raw: any): GstinDetails {
    const legalName =
      raw.legal_name ||
      raw.lgnm ||
      raw.trade_name ||
      raw.tradeNam ||
      'Unknown Business';

    const tradeName =
      raw.trade_name ||
      raw.tradeNam ||
      raw.legal_name ||
      raw.lgnm ||
      '';

    const status = raw.status || raw.sts || 'UNKNOWN';
    const constitution = raw.constitution || raw.ctb || '';
    const taxpayerType = raw.taxpayer_type || raw.dty || 'Regular';
    const registrationDate = raw.registration_date || raw.rgdt || '';
    const pan = raw.pan || (gstin.length >= 12 ? gstin.substring(2, 12) : '');

    let address = raw.address || '';
    let state = raw.state || '';
    let city = raw.city || '';
    let pinCode = raw.pinCode || raw.pincode || '';

    // Handle GSTN structured address (e.g. from Sandbox / government format)
    if (raw.pradr?.addr) {
      const a = raw.pradr.addr;
      const parts = [
        a.bno,
        a.flno,
        a.st,
        a.loc,
        a.city || a.dst,
        a.stcd,
        a.pncd,
      ].filter(Boolean);
      address = parts.join(', ');
      state = a.stcd || state;
      city = a.city || a.dst || city;
      pinCode = a.pncd || pinCode;
    }

    // Fallback state lookup from 2-digit GST state code
    if (!state) {
      const stateCode = gstin.substring(0, 2);
      state = GST_STATE_MAP[stateCode] || '';
    }

    // Best-effort derive city and pinCode from freeform address if missing
    if (!city || !pinCode) {
      const derived = this.deriveLocation(address, state);
      if (!city) city = derived.city;
      if (!pinCode) pinCode = derived.pinCode;
    }

    // Nature of business normalization
    let natureOfBusiness: string[] = [];
    if (Array.isArray(raw.nature_of_business)) {
      natureOfBusiness = raw.nature_of_business;
    } else if (Array.isArray(raw.nba)) {
      natureOfBusiness = raw.nba;
    } else if (raw.pradr?.ntr) {
      natureOfBusiness = [raw.pradr.ntr];
    }

    return {
      gstin: raw.gstin || gstin,
      legalName,
      tradeName,
      status,
      constitution,
      taxpayerType,
      registrationDate,
      pan,
      address,
      state,
      city,
      pinCode,
      natureOfBusiness,
    };
  }

  private static createFallbackDetails(gstin: string): GstinDetails {
    const stateCode = gstin.substring(0, 2);
    const state = GST_STATE_MAP[stateCode] || 'Unknown';
    const pan = gstin.substring(2, 12);
    return {
      gstin,
      legalName: `Business (${gstin})`,
      tradeName: `Business (${gstin})`,
      status: 'ACTIVE',
      constitution: 'Regular',
      taxpayerType: 'Regular',
      registrationDate: new Date().toISOString().split('T')[0],
      pan,
      address: `${state}, India`,
      state,
      city: '',
      pinCode: '',
      natureOfBusiness: [],
    };
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
