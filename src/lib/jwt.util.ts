import jwt from 'jsonwebtoken';
import crypto from 'crypto';

/**
 * JWT signing/verification.
 *
 * Secrets come ONLY from ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET. There is
 * deliberately no fallback: the previous hard-coded defaults were committed to
 * source, so any environment missing the variables signed tokens with a
 * publicly known key (audit C-02). `assertJwtConfig()` runs at process start
 * (src/index.ts) so a misconfigured server refuses to boot; every sign/verify
 * call re-validates as a backstop.
 */

export const MIN_JWT_SECRET_LENGTH = 32;

// Never accepted even if long enough: the old committed fallbacks and common
// placeholders copied from examples.
const KNOWN_WEAK_SECRETS = new Set([
  'kiddos_access_secret_8822',
  'kiddos_refresh_secret_9933',
  'secret',
  'changeme',
  'jwt_secret',
]);

const ALGORITHM: jwt.Algorithm = 'HS256';
const TOKEN_USE_CLAIM = 'tu';

export class JwtConfigError extends Error {}

function checkSecret(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new JwtConfigError(`${name} is not set. Generate a random value of at least ${MIN_JWT_SECRET_LENGTH} characters, e.g. node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`);
  }
  const v = value.trim();
  if (v.length < MIN_JWT_SECRET_LENGTH) {
    throw new JwtConfigError(`${name} is too short (${v.length} chars); at least ${MIN_JWT_SECRET_LENGTH} are required.`);
  }
  if (KNOWN_WEAK_SECRETS.has(v.toLowerCase()) || /^(.)\1+$/.test(v) || /(changeme|replace[-_ ]?(me|with)|placeholder|your[-_ ]?secret)/i.test(v)) {
    throw new JwtConfigError(`${name} is a known/placeholder value and must be replaced with a random secret.`);
  }
  return v;
}

/** Validates both secrets and returns them. Throws JwtConfigError on any problem. */
export function assertJwtConfig(env: NodeJS.ProcessEnv = process.env): { access: string; refresh: string } {
  const access = checkSecret('ACCESS_TOKEN_SECRET', env.ACCESS_TOKEN_SECRET);
  const refresh = checkSecret('REFRESH_TOKEN_SECRET', env.REFRESH_TOKEN_SECRET);
  if (access === refresh) {
    throw new JwtConfigError('ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be different values.');
  }
  return { access, refresh };
}

export interface TokenPayload {
  userId: string;
  email?: string;
  role: string;
  franchiseId?: string | null;
  branchId?: string | null;
}

function stripClaims(decoded: any): TokenPayload {
  const { iat: _iat, exp: _exp, jti: _jti, [TOKEN_USE_CLAIM]: _tu, ...rest } = decoded || {};
  return rest as TokenPayload;
}

export class JwtUtil {
  static generateAccessToken(payload: TokenPayload): string {
    const { access } = assertJwtConfig();
    return jwt.sign({ ...stripClaims(payload), [TOKEN_USE_CLAIM]: 'access' }, access, {
      algorithm: ALGORITHM,
      expiresIn: '15m',
      jwtid: crypto.randomUUID()
    });
  }

  static generateRefreshToken(payload: TokenPayload): string {
    const { refresh } = assertJwtConfig();
    return jwt.sign({ ...stripClaims(payload), [TOKEN_USE_CLAIM]: 'refresh' }, refresh, {
      algorithm: ALGORITHM,
      expiresIn: '7d',
      jwtid: crypto.randomUUID()
    });
  }

  private static verifyWith(token: string, secret: string, use: 'access' | 'refresh'): TokenPayload | null {
    try {
      // Algorithm pinned: rejects alg=none and algorithm-confusion tokens.
      const decoded: any = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
      if (!decoded || typeof decoded !== 'object') return null;
      // Tokens minted before the token-use claim existed carry no `tu` and are
      // accepted on signature alone (they expire within 15m / 7d); a token
      // that declares the other use is always rejected.
      if (decoded[TOKEN_USE_CLAIM] !== undefined && decoded[TOKEN_USE_CLAIM] !== use) return null;
      if (typeof decoded.userId !== 'string' || typeof decoded.role !== 'string') return null;
      return stripClaims(decoded);
    } catch {
      return null;
    }
  }

  static verifyAccessToken(token: string): TokenPayload | null {
    const { access } = assertJwtConfig();
    return this.verifyWith(token, access, 'access');
  }

  static verifyRefreshToken(token: string): TokenPayload | null {
    const { refresh } = assertJwtConfig();
    return this.verifyWith(token, refresh, 'refresh');
  }
}
