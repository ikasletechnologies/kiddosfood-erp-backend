import prisma from '../lib/prisma';
import { AppError } from '../middleware/error.middleware';

/**
 * Record-ownership checks for franchise isolation (audit C-08, H-13).
 *
 * Owner keys: a record whose franchiseId is null OR the HQ franchise's id is
 * owned by "HQ" (both conventions exist in the data); anything else is owned
 * by that franchise. SUPER_ADMIN may act on any owner. Every other role may
 * act only on records whose owner equals its own franchise — a FRANCHISE_ADMIN
 * of a non-HQ franchise can therefore never touch HQ-owned records.
 */
export interface ActingUser {
  userId?: string;
  role?: string;
  franchiseId?: string | null;
}

export const HQ_OWNER = '__HQ__';

export async function ownerKeyOf(franchiseId: string | null | undefined, db: any = prisma): Promise<string> {
  if (!franchiseId) return HQ_OWNER;
  const f = await db.franchise.findUnique({ where: { id: franchiseId }, select: { isHQ: true } });
  return f?.isHQ ? HQ_OWNER : franchiseId;
}

export function isSuperAdmin(user?: ActingUser | null): boolean {
  return user?.role === 'SUPER_ADMIN';
}

/** Throws 403 unless `user` may act on a record owned by `recordFranchiseId`. */
export async function assertCanActOnFranchise(user: ActingUser | null | undefined, recordFranchiseId: string | null | undefined, what: string, db: any = prisma) {
  if (!user || !user.role) throw new AppError('Unauthorized', 401);
  if (isSuperAdmin(user)) return;
  if (!user.franchiseId) throw new AppError(`Forbidden: your account has no franchise assigned, so it cannot modify this ${what}.`, 403);
  const [recordOwner, userOwner] = await Promise.all([ownerKeyOf(recordFranchiseId, db), ownerKeyOf(user.franchiseId, db)]);
  if (recordOwner !== userOwner) {
    throw new AppError(`Forbidden: this ${what} belongs to a different franchise.`, 403);
  }
}

/** Parses a strictly positive, finite money/quantity amount or throws 400. */
export function requirePositiveAmount(value: unknown, label = 'Amount'): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new AppError(`${label} must be a number greater than zero.`, 400);
  return n;
}

/** Parses a finite, non-negative number or throws 400. */
export function requireNonNegativeNumber(value: unknown, label = 'Value'): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < 0) throw new AppError(`${label} must be a finite number of zero or more.`, 400);
  return n;
}
