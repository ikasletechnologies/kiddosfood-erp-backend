import { TokenPayload } from '../lib/jwt.util';
import { FranchiseService } from '../modules/franchise/franchise.service';


/**
 * Helper to ensure data isolation between franchises/branches.
 * Super Admin can see everything, other roles are restricted to their own branch.
 */
export class IsolationUtil {
  /**
   * Generates a Prisma 'where' filter for multi-branch isolation.
   * @param user The authenticated user from req.user
   */
  static getFranchiseFilter(user: TokenPayload) {
    if (user.role === 'SUPER_ADMIN') {
      return {}; // No filter, can see all
    }

    if (!user.franchiseId) {
      console.warn(`[IsolationUtil] User ${user.userId} (${user.role}) has no assigned franchise. Restricting access.`);
      return { franchiseId: '__UNASSIGNED__' };
    }

    return { franchiseId: user.franchiseId };
  }

  /**
   * Ensures that a non-SuperAdmin cannot create or update data for a different franchise.
   * @param user Authenticated user
   * @param targetFranchiseId The franchise ID provided in the request body
   */
  static async enforceFranchiseMatch(user: TokenPayload, targetFranchiseId?: string): Promise<string | null> {
    if (user.role === 'SUPER_ADMIN') {
      if (targetFranchiseId) return targetFranchiseId; // HQ can assign to any branch
      // No explicit target — resolve the real HQ fresh from the DB instead
      // of trusting user.franchiseId, a claim baked into the JWT at
      // login/refresh time that can drift from the DB and has no
      // guaranteed relationship to "is this account HQ-scoped" (this is
      // exactly how a stale token minted an InventoryItem with the literal
      // HQ franchise id instead of the canonical HQ-scope null).
      const hq = await FranchiseService.getHqFranchiseOrNull();
      return hq?.id ?? user.franchiseId ?? null;
    }

    // For FRANCHISE_ADMIN, use their own franchise ID exclusively
    return user.franchiseId ?? null;
  }
}
