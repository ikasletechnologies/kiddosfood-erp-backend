import { TokenPayload } from '../lib/jwt.util';


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
      console.warn(`[IsolationUtil] User ${user.userId} has no assigned franchise. Falling back to no filter.`);
      return {}; 
    }

    return { franchiseId: user.franchiseId };
  }

  /**
   * Ensures that a non-SuperAdmin cannot create or update data for a different franchise.
   * @param user Authenticated user
   * @param targetFranchiseId The franchise ID provided in the request body
   */
  static enforceFranchiseMatch(user: TokenPayload, targetFranchiseId?: string) {
    if (user.role === 'SUPER_ADMIN') return targetFranchiseId || user.franchiseId; // HQ can assign to any branch
    
    // For FRANCHISE_ADMIN, use their own franchise ID exclusively
    return user.franchiseId;
  }
}
