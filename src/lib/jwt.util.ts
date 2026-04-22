import jwt from 'jsonwebtoken';

const ACCESS_SECRET = process.env.ACCESS_TOKEN_SECRET || 'kiddos_access_secret_8822';
const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET || 'kiddos_refresh_secret_9933';

export interface TokenPayload {
  userId: string;
  role: string;
  franchiseId?: string | null;
  branchId?: string | null;
  permissions?: string[];
}

export class JwtUtil {
  static generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
  }

  static generateRefreshToken(payload: TokenPayload): string {
    return jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
  }

  static verifyAccessToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, ACCESS_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  }

  static verifyRefreshToken(token: string): TokenPayload | null {
    try {
      return jwt.verify(token, REFRESH_SECRET) as TokenPayload;
    } catch {
      return null;
    }
  }
}
