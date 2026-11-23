/**
 * Shared fixtures for the Phase 1 integration suite. Every DB-touching test
 * calls requireTestDatabase() first: it refuses to run unless DATABASE_URL
 * points at a database whose name ends in "_test" (the runner,
 * scripts/run-phase1-tests.ts, sets that up and resets it).
 */
import type { AddressInfo } from 'net';
import prisma from '../../../lib/prisma';
import { JwtUtil } from '../../../lib/jwt.util';
import { InventoryService } from '../../../modules/inventory/inventory.service';

export function requireTestDatabase() {
  let name = '';
  try { name = new URL(process.env.DATABASE_URL || '').pathname.replace(/^\//, ''); } catch { /* invalid */ }
  if (!name.endsWith('_test') || process.env.PHASE1_DB_TESTS !== '1') {
    throw new Error(`Refusing to run DB tests: DATABASE_URL database "${name}" is not a dedicated *_test database (use npm run test:phase1).`);
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10);

export async function ensureHq() {
  const existing = await prisma.franchise.findFirst({ where: { isHQ: true } });
  if (existing) return existing;
  return prisma.franchise.create({ data: { name: `HQ ${uid()}`, location: 'HQ', ownerName: 'HQ', contactNum: '0', isHQ: true } });
}

export async function createFranchise(label = 'F') {
  return prisma.franchise.create({ data: { name: `${label} ${uid()}`, location: 'Test', ownerName: 'Owner', contactNum: '0' } });
}

export async function createUser(role: 'SUPER_ADMIN' | 'FRANCHISE_ADMIN', franchiseId: string | null, passwordHash = 'not-a-real-hash') {
  return prisma.user.create({
    data: { fullName: `${role} ${uid()}`, email: `${role.toLowerCase()}-${uid()}@test.local`, passwordHash, role, franchiseId },
    select: { id: true, role: true, franchiseId: true, email: true, fullName: true }
  });
}

export function tokenFor(user: { id: string; role: string; franchiseId: string | null; email?: string | null }) {
  return JwtUtil.generateAccessToken({ userId: user.id, role: user.role, franchiseId: user.franchiseId, email: user.email || undefined });
}

export async function createAccount(franchiseId: string | null, balance: number, type: 'CASH' | 'BANK' | 'UPI' = 'CASH') {
  return prisma.account.create({ data: { name: `${type} ${uid()}`, type, balance, franchiseId, status: 'ACTIVE' } });
}

export async function balanceOf(accountId: string) {
  return (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance;
}

/** Inventory item with real stock (lot + ledger movement), like a GRN would leave it. */
export async function createStockedItem(opts: { franchiseId: string | null; qty: number; category?: 'RAW_MATERIAL' | 'FINISHED_GOOD'; sku?: string; franchisePrice?: number; unitCost?: number }) {
  const item = await prisma.inventoryItem.create({
    data: {
      name: `Item ${uid()}`,
      sku: opts.sku || `SKU-${uid()}`,
      category: opts.category || 'RAW_MATERIAL',
      currentStock: 0,
      unit: 'PC',
      franchiseId: opts.franchiseId,
      franchisePrice: opts.franchisePrice ?? 0,
      costPrice: opts.unitCost ?? 10,
    }
  });
  if (opts.qty > 0) {
    await prisma.$transaction(tx => InventoryService.recordMovement(tx, {
      itemId: item.id,
      type: 'PURCHASE_IN',
      quantity: opts.qty,
      referenceType: 'TEST_FIXTURE',
      note: 'test fixture stock',
      receiveAtCost: { unitCost: opts.unitCost ?? 10, batchNumber: `B-${uid()}` }
    }));
  }
  return item;
}

export async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = (await import('../../../app')).default;
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

export async function call(base: string, method: string, path: string, token?: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}

export async function auditCount(module: string, action: string, recordId?: string) {
  return prisma.auditLog.count({ where: { module, action, ...(recordId ? { recordId } : {}) } });
}
