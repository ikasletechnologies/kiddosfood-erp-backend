import axios from 'axios';
import prisma from '../../lib/prisma';

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTVERIFY_BASE_URL = 'https://gstverify.co.in/api/v1/verify';
const SANDBOX_PRODUCTION_URL = 'https://api.sandbox.co.in';
const SANDBOX_TEST_URL = 'https://test-api.sandbox.co.in';

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
  // GSTVerify only returns one combined address string, no structured
  // city/pinCode — derived from it on read so we don't need to store them.
  city: string;
  pinCode: string;
  natureOfBusiness: string[];
}

// Non-2xx statuses GSTVerify documents explicitly; anything else surfaces as a generic upstream failure.
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

export class GstService {
  private static sandboxToken: { value: string; expiresAt: number } | null = null;

  static isValidGstin(gstin: string): boolean {
    return GSTIN_REGEX.test(gstin);
  }

  // GSTVerify itself also caches, but our own row means repeat lookups (any
  // user, any franchise) never spend a credit at all.
  static async verify(gstinRaw: string, forceRefresh = false): Promise<{ details: GstinDetails; cached: boolean }> {
    const gstin = gstinRaw.trim().toUpperCase();
    if (!this.isValidGstin(gstin)) {
      throw new GstVerifyError('Invalid GSTIN format. Must be a 15-character alphanumeric code.', 400);
    }

    if (!forceRefresh) {
      const cached = await prisma.gstinCache.findUnique({ where: { gstin } });
      if (cached) {
        return { details: this.toDetails(cached), cached: true };
      }
    }

    const raw = await this.fetchGstin(gstin, forceRefresh);
    const sandboxAddress = raw.pradr?.addr;
    const address = raw.address || this.formatSandboxAddress(sandboxAddress);
    const state = raw.state || raw.stateName || sandboxAddress?.stcd || '';
    const details: GstinDetails = {
      gstin: raw.gstin || gstin,
      legalName: raw.legal_name || raw.lgnm || raw.legalName || raw.trade_name || raw.tradeNam || 'Unknown Business',
      tradeName: raw.trade_name || raw.tradeNam || raw.legal_name || raw.lgnm || raw.legalName || '',
      status: raw.status || raw.sts || 'UNKNOWN',
      constitution: raw.constitution || raw.ctb || '',
      taxpayerType: raw.taxpayer_type || raw.dty || 'Regular',
      registrationDate: raw.registration_date || raw.rgdt || raw.regStartDate || '',
      pan: raw.pan || '',
      address,
      state,
      city: sandboxAddress?.loc || sandboxAddress?.dst || this.deriveLocation(address, state).city,
      pinCode: String(sandboxAddress?.pncd || this.deriveLocation(address, state).pinCode),
      natureOfBusiness: Array.isArray(raw.nature_of_business)
        ? raw.nature_of_business
        : Array.isArray(raw.nba) ? raw.nba : raw.bussNature ? [raw.bussNature] : [],
    };

    // city/pinCode are derived, not persisted — only store what GSTVerify actually returned.
    const { gstin: _gstin, city: _city, pinCode: _pinCode, ...persisted } = details;
    await prisma.gstinCache.upsert({
      where: { gstin },
      create: { gstin, ...persisted, raw },
      update: { ...persisted, raw, fetchedAt: new Date() },
    });

    return { details, cached: false };
  }

  private static async fetchGstin(gstin: string, forceRefresh: boolean): Promise<any> {
    if (process.env.SANDBOX_API_KEY && process.env.SANDBOX_SECRET) {
      return this.fetchFromSandbox(gstin, forceRefresh);
    }

    const apiKey = process.env.GSTVERIFY_API_KEY;
    if (!apiKey) {
      throw new GstVerifyError(
        'GST verification is not configured. Set SANDBOX_API_KEY and SANDBOX_SECRET on the server.',
        503,
      );
    }

    const response = await axios.get(`${GSTVERIFY_BASE_URL}/${gstin}`, {
      headers: { 'X-API-Key': apiKey },
      validateStatus: () => true,
    });
    if (response.status !== 200 || !response.data?.success) {
      const message = response.data?.error || `GST verification lookup failed (${response.status})`;
      throw new GstVerifyError(message, response.status === 429 ? 429 : 502);
    }
    return response.data.data || {};
  }

  private static sandboxBaseUrl(): string {
    if (process.env.SANDBOX_API_BASE_URL) return process.env.SANDBOX_API_BASE_URL.replace(/\/$/, '');
    return process.env.SANDBOX_API_KEY?.startsWith('key_test') ? SANDBOX_TEST_URL : SANDBOX_PRODUCTION_URL;
  }

  private static async sandboxAccessToken(): Promise<string> {
    if (this.sandboxToken && this.sandboxToken.expiresAt > Date.now()) return this.sandboxToken.value;

    const response = await axios.post(`${this.sandboxBaseUrl()}/authenticate`, undefined, {
      headers: {
        'x-api-key': process.env.SANDBOX_API_KEY,
        'x-api-secret': process.env.SANDBOX_SECRET,
        'x-api-version': '1.0',
      },
      validateStatus: () => true,
    });
    const token = response.data?.data?.access_token;
    if (response.status !== 200 || !token) {
      throw new GstVerifyError('GST verification provider authentication failed.', 502);
    }

    this.sandboxToken = { value: token, expiresAt: Date.now() + 23 * 60 * 60 * 1000 };
    return token;
  }

  private static async fetchFromSandbox(gstin: string, forceRefresh: boolean): Promise<any> {
    const token = await this.sandboxAccessToken();
    const response = await axios.post(
      `${this.sandboxBaseUrl()}/gst/compliance/public/gstin/search`,
      { gstin },
      {
        headers: {
          authorization: token,
          'x-api-key': process.env.SANDBOX_API_KEY,
          'x-api-version': '1.0.0',
          'x-accept-cache': String(!forceRefresh),
        },
        validateStatus: () => true,
      },
    );
    const raw = response.data?.data?.data;
    if (response.status !== 200 || response.data?.data?.status_cd !== '1' || !raw) {
      const message = response.data?.data?.error?.message || response.data?.message || 'GSTIN could not be verified.';
      throw new GstVerifyError(message, response.status === 429 ? 429 : 502);
    }
    return raw;
  }

  private static formatSandboxAddress(address: any): string {
    if (!address) return '';
    return [address.flno, address.bno, address.bnm, address.st, address.landMark, address.loc, address.dst, address.stcd, address.pncd]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join(', ');
  }

  private static toDetails(cached: CachedRow): GstinDetails {
    const address = cached.address || '';
    const state = cached.state || '';
    return {
      gstin: cached.gstin,
      legalName: cached.legalName || 'Unknown Business',
      tradeName: cached.tradeName || cached.legalName || '',
      status: cached.status || 'UNKNOWN',
      constitution: cached.constitution || '',
      taxpayerType: cached.taxpayerType || 'Regular',
      registrationDate: cached.registrationDate || '',
      pan: cached.pan || '',
      address,
      state,
      ...this.deriveLocation(address, state),
      natureOfBusiness: Array.isArray(cached.natureOfBusiness) ? (cached.natureOfBusiness as string[]) : [],
    };
  }

  // GSTN addresses are free-text and messy, so this is a best-effort parse:
  // pincode is the trailing 6-digit number; city is the last comma-separated
  // segment left after stripping the pincode and the state name.
  private static deriveLocation(address: string, state: string): { city: string; pinCode: string } {
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
