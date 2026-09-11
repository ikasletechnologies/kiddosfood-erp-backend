import axios from 'axios';
import prisma from '../../lib/prisma';

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const GSTVERIFY_BASE_URL = 'https://gstverify.co.in/api/v1/verify';

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

    // city/pinCode are derived, not persisted — only store what GSTVerify actually returned.
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
