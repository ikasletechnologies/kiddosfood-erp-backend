import { WarehouseService } from '../warehouse/warehouse.service';
import prisma from '../../lib/prisma';
import { AuthService } from '../auth/auth.service';
import { encryptField } from '../../lib/field-crypto';
import {
  FieldValidationError,
  maskAadhaar,
  validateEmail,
  validateKycFields,
  validatePassword,
} from './franchise.validation';

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
    const { adminUser, aadhaarNumber, panNumber, ...franchiseData } = input;

    // Headquarters Setup (/setup) posts isHQ: true with no admin account — it
    // keeps its original behaviour untouched. The Add Franchise rules below
    // (mandatory admin Email ID + Password, optional Aadhaar/PAN) apply only
    // to branch (non-HQ) creation.
    const isBranch = franchiseData.isHQ !== true;
    let kycColumns: Record<string, string | null> = {};
    let adminEmail = '';
    if (isBranch) {
      const { data: kyc, errors } = validateKycFields({ aadhaarNumber, panNumber });
      adminEmail = typeof adminUser?.email === 'string' ? adminUser.email.trim() : '';
      const emailError = validateEmail(adminEmail);
      if (emailError) errors.email = emailError;
      const passwordError = validatePassword(adminUser?.password);
      if (passwordError) errors.password = passwordError;
      if (Object.keys(errors).length) throw new FieldValidationError(errors);

      kycColumns = {
        panNumber: kyc.panNumber ?? null,
        aadhaarEncrypted: kyc.aadhaarNumber ? encryptField(kyc.aadhaarNumber) : null,
        aadhaarLast4: kyc.aadhaarNumber ? kyc.aadhaarNumber.slice(-4) : null,
      };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        await FranchiseService.assertSingleHQ(tx, franchiseData.isHQ);

        // Duplicate admin email. User.email is @unique but case-sensitive in
        // Postgres, so also guard against case variants of an existing login.
        if (isBranch) {
          const emailOwner = await tx.user.findFirst({
            where: { email: { equals: adminEmail, mode: 'insensitive' } },
            select: { id: true }
          });
          if (emailOwner) {
            throw new FieldValidationError({ email: 'This email address is already registered' }, 409);
          }
        }

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
            dashboardPassword: dashboardPasswordHash,
            ...kycColumns
          }
        });

        // 2. Create Franchise Admin User if provided (requires email or phone).
        // Branches always reach here with a validated email + password.
        if (adminUser && (adminUser.email || franchiseData.contactNum)) {
          const passwordHash = await AuthService.hashPassword(adminUser.password || 'franchise123');

          await tx.user.create({
            data: {
              fullName: adminUser.fullName || franchiseData.ownerName,
              email: (isBranch ? adminEmail : adminUser.email) || null,
              phone: franchiseData.contactNum,
              passwordHash,
              role: 'FRANCHISE_ADMIN',
              franchiseId: franchise.id,
              is_active: true
            }
          });
        }

        return isBranch ? FranchiseService.toSafeFranchise(franchise) : franchise;
      });
    } catch (err: any) {
      // Unique-index races / clashes → clear field errors instead of a raw 500.
      if (err?.code === 'P2002') {
        const target = String(err?.meta?.target ?? '');
        if (target.includes('email')) throw new FieldValidationError({ email: 'This email address is already registered' }, 409);
        if (target.includes('phone')) throw new FieldValidationError({ contactNum: 'This contact number is already registered to another user' }, 409);
      }
      throw err;
    }
  }

  // Strips stored secrets; Aadhaar is only ever exposed masked, and only when
  // includeAadhaar is set (Super Admin callers).
  static toSafeFranchise<T extends Record<string, any>>(franchise: T, opts: { includeAadhaar?: boolean } = { includeAadhaar: true }) {
    const { dashboardPassword: _dp, aadhaarEncrypted: _ae, aadhaarLast4, ...rest } = franchise as any;
    return {
      ...rest,
      aadhaarMasked: opts.includeAadhaar ? maskAadhaar(aadhaarLast4) : null,
      hasAadhaar: Boolean(aadhaarLast4),
    };
  }

  // includeAadhaar: only Super Admins see the (masked) Aadhaar.
  static async getAll(franchiseId?: string, opts: { includeAadhaar?: boolean } = {}) {
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
        panNumber: true,
        aadhaarLast4: true,
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
    }).then((rows) => rows.map((f) => FranchiseService.toSafeFranchise(f, opts)));
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

  static async getById(id: string, opts: { includeAadhaar?: boolean } = {}) {
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
      return FranchiseService.toSafeFranchise(franchise, opts);
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
  /**
   * Dedicated Franchise Warehouse status check.
   * Scoped strictly to the authenticated franchise.
   */
  static async getWarehouseStatus(franchiseId: string) {
    const franchise = await prisma.franchise.findUnique({
      where: { id: franchiseId },
      include: {
        primaryWarehouse: {
          select: {
            id: true,
            name: true,
            code: true,
            location: true,
            type: true,
            status: true,
            createdAt: true,
          }
        }
      }
    });

    if (!franchise) {
      throw new Error('Franchise not found');
    }

    if (franchise.isHQ) {
      throw new Error('Franchise warehouse setup is only applicable for Franchise branches.');
    }

    const hasWarehouse = Boolean(franchise.primaryWarehouseId && franchise.primaryWarehouse);

    let nextCode: string | undefined;
    if (!hasWarehouse) {
      nextCode = await WarehouseService.previewNextWarehouseCode();
    }

    return {
      configured: hasWarehouse,
      franchise: {
        id: franchise.id,
        name: franchise.name,
        location: franchise.location,
      },
      warehouse: franchise.primaryWarehouse || null,
      nextCode,
    };
  }

  /**
   * Creates a dedicated warehouse scoped specifically to this franchise.
   * Completely isolated from HQ / Super Admin setup flow.
   */
  static async setupFranchiseWarehouse(franchiseId: string, data: { name: string; location?: string; code?: string }) {
    if (!data.name || !data.name.trim()) {
      throw new Error('Warehouse name is required');
    }

    return prisma.$transaction(async (tx) => {
      const franchise = await tx.franchise.findUnique({
        where: { id: franchiseId },
        include: { primaryWarehouse: true }
      });

      if (!franchise) {
        throw new Error('Franchise not found');
      }

      if (franchise.isHQ) {
        throw new Error('Franchise warehouse setup cannot be used for HQ.');
      }

      // Idempotency: if franchise already has a primary warehouse, return it
      if (franchise.primaryWarehouseId && franchise.primaryWarehouse) {
        return franchise.primaryWarehouse;
      }

      // Generate unique warehouse code
      let finalCode: string;
      const requestedCode = data.code?.trim();
      if (requestedCode) {
        const codeClash = await tx.warehouse.findFirst({ where: { code: requestedCode } });
        if (!codeClash) {
          finalCode = requestedCode;
          const match = requestedCode.match(/^WH-(\d+)$/i);
          if (match) {
            const n = parseInt(match[1], 10);
            if (!isNaN(n)) {
              const cur = await tx.numberSequence.findUnique({ where: { key: 'WAREHOUSE_CODE' } });
              if (!cur || cur.value < n) {
                await tx.numberSequence.upsert({
                  where: { key: 'WAREHOUSE_CODE' },
                  create: { key: 'WAREHOUSE_CODE', value: n },
                  update: { value: n }
                });
              }
            }
          }
        } else {
          finalCode = await WarehouseService.nextWarehouseCode(tx);
        }
      } else {
        finalCode = await WarehouseService.nextWarehouseCode(tx);
      }

      const nameKey = data.name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      const nameClash = await tx.warehouse.findUnique({ where: { nameKey } });
      if (nameClash) {
        throw new Error(`A warehouse named "${nameClash.name}" already exists. Please choose a unique warehouse name.`);
      }

      const warehouse = await tx.warehouse.create({
        data: {
          name: data.name.trim(),
          nameKey,
          location: data.location?.trim() || null,
          type: 'FRANCHISE',
          code: finalCode,
          status: 'ACTIVE',
        }
      });

      await tx.franchise.update({
        where: { id: franchise.id },
        data: { primaryWarehouseId: warehouse.id }
      });

      return warehouse;
    });
  }
}
