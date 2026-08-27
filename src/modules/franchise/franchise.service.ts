import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';

export class FranchiseService {
  // Enforces the "exactly one HQ" invariant getHqFranchise[OrNull] already
  // assumes at read time — without this, nothing stopped a second
  // isHQ:true franchise from being created, which would only surface later
  // as every HQ-dependent module (Inventory/POS/Procurement/...) throwing.
  // excludeId lets update() check against every OTHER franchise while
  // editing the current HQ itself (which legitimately already has isHQ:true).
  private static async assertSingleHQ(tx: any, isHQ: boolean | undefined, excludeId?: string) {
    if (!isHQ) return;
    const existing = await tx.franchise.findFirst({
      where: { isHQ: true, ...(excludeId ? { id: { not: excludeId } } : {}) }
    });
    if (existing) {
      throw new Error(`"${existing.name}" is already the HQ franchise. Exactly one franchise may have isHQ=true — unset it there first.`);
    }
  }

  static async create(input: any) {
    const { adminUser, ...franchiseData } = input;

    return prisma.$transaction(async (tx) => {
      await FranchiseService.assertSingleHQ(tx, franchiseData.isHQ);

      // 1. Create Franchise with sanitized data
      // Hash the dashboard password if provided
      const dashboardPasswordHash = franchiseData.dashboardPassword
        ? await AuthService.hashPassword(franchiseData.dashboardPassword)
        : null;

      const franchise = await tx.franchise.create({
        data: {
          name: franchiseData.name,
          location: franchiseData.location,
          ownerName: franchiseData.ownerName,
          contactNum: franchiseData.contactNum,
          status: franchiseData.status || 'ACTIVE',
          isHQ: franchiseData.isHQ ?? false,
          dashboardPassword: dashboardPasswordHash
        }
      });

      // 2. Create Franchise Admin User if provided (requires email or phone)
      if (adminUser && (adminUser.email || franchiseData.contactNum)) {
        const passwordHash = await AuthService.hashPassword(adminUser.password || 'franchise123');

        await tx.user.create({
          data: {
            fullName: adminUser.fullName || franchiseData.ownerName,
            email: adminUser.email || null,
            phone: franchiseData.contactNum,
            passwordHash,
            role: 'FRANCHISE_ADMIN',
            franchiseId: franchise.id,
            is_active: true
          }
        });
      }

      return franchise;
    });
  }

  static async getAll(franchiseId?: string) {
    const where: any = {
      status: { not: 'DELETED' }
    };
    if (franchiseId) {
      where.id = franchiseId;
    }
    return prisma.franchise.findMany({
      where,
      select: {
        id: true,
        name: true,
        location: true,
        ownerName: true,
        contactNum: true,
        status: true,
        outstandingAmount: true,
        creditLimit: true,
        walletBalance: true,
        isHQ: true,
        primaryWarehouseId: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { users: true, orders: true, inventory: true }
        }
      }
    });
  }

  // The single source of truth for "which franchise is HQ" — replaces the
  // id==='hq-001'/name-contains-'HQ' heuristics that used to be duplicated
  // (and disagreed with each other) across product/pos/inventory/franchise-order
  // services. `tx` lets callers use it inside an existing transaction.
  static async getHqFranchise(tx: any = prisma) {
    const rows = await tx.franchise.findMany({ where: { isHQ: true } });
    if (rows.length > 1) {
      throw new Error(`Multiple franchises are marked isHQ (${rows.map((f: any) => f.id).join(', ')}) — exactly one HQ franchise is required.`);
    }
    if (rows.length === 0) {
      throw new Error('No franchise is marked as HQ (Franchise.isHQ). Set isHQ=true on exactly one franchise.');
    }
    return rows[0];
  }

  // Same invariant (never silently pick one of several), but returns null
  // instead of throwing when there simply isn't an HQ configured yet — for
  // call sites that historically treated "no HQ yet" as a soft no-op.
  static async getHqFranchiseOrNull(tx: any = prisma) {
    const rows = await tx.franchise.findMany({ where: { isHQ: true } });
    if (rows.length > 1) {
      throw new Error(`Multiple franchises are marked isHQ (${rows.map((f: any) => f.id).join(', ')}) — exactly one HQ franchise is required.`);
    }
    return rows[0] || null;
  }

  // The single place that converts a real Franchise id into the value an
  // InventoryItem should actually be scoped with. Franchise.isHQ identifies
  // WHICH franchise is headquarters; InventoryItem.franchiseId = null is
  // the separate, independent convention for "this stock belongs to HQ" —
  // conflating the two (storing the HQ franchise's own id on an
  // InventoryItem) is what split HQ stock between null and a literal id.
  // Every writer that resolves a franchise id and then creates/looks up an
  // InventoryItem with it must run the id through here first.
  static async toInventoryScopeId(tx: any, franchiseId: string): Promise<string | null> {
    const franchise = await tx.franchise.findUnique({ where: { id: franchiseId }, select: { isHQ: true } });
    return franchise?.isHQ ? null : franchiseId;
  }

  static async getById(id: string) {
    const franchise = await prisma.franchise.findUnique({
      where: { id },
      include: { 
        users: true, 
        orders: true, 
        expenses: true,
        ledgerEntries: {
          orderBy: { createdAt: 'asc' }
        }
      }
    });

    if (franchise) {
      const { dashboardPassword, ...safeFranchise } = franchise;
      return safeFranchise;
    }
    return null;
  }

  static async verifyDashboardPassword(id: string, password: string) {
    const franchise = await prisma.franchise.findUnique({
      where: { id },
      select: { dashboardPassword: true }
    });

    if (!franchise || !franchise.dashboardPassword) return false;
    
    return AuthService.comparePassword(password, franchise.dashboardPassword);
  }

  static async update(id: string, input: any) {
    const data: any = {
      name: input.name,
      location: input.location,
      ownerName: input.ownerName,
      contactNum: input.contactNum,
      status: input.status
    };
    if (input.isHQ !== undefined) data.isHQ = input.isHQ;
    if (input.primaryWarehouseId !== undefined) data.primaryWarehouseId = input.primaryWarehouseId;

    if (input.dashboardPassword) {
      data.dashboardPassword = await AuthService.hashPassword(input.dashboardPassword);
    }

    return prisma.$transaction(async (tx) => {
      if (input.isHQ !== undefined) {
        await FranchiseService.assertSingleHQ(tx, input.isHQ, id);
      }
      return tx.franchise.update({
        where: { id },
        data
      });
    });
  }

  static async updateStatus(id: string, status: string) {
    return prisma.franchise.update({
      where: { id },
      data: { status }
    });
  }
}
