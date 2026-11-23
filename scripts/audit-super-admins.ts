/**
 * READ-ONLY audit of SUPER_ADMIN accounts (audit C-01 follow-up).
 *
 * Until the Phase 1 fix, POST /api/auth/register was public and accepted
 * role=SUPER_ADMIN, so any SUPER_ADMIN account without an admin-creation
 * record may have been self-registered. This script never writes anything.
 *
 *   npx tsx scripts/audit-super-admins.ts          # masked emails
 *   npx tsx scripts/audit-super-admins.ts --full   # unmasked (local use only)
 *
 * Review each SUSPECT row; deactivate (is_active=false) any account nobody can
 * vouch for, then rotate JWT secrets so its tokens stop working.
 */
import prisma from '../src/lib/prisma';

const FULL = process.argv.includes('--full');
const mask = (email?: string | null) => {
  if (!email) return '(none)';
  if (FULL) return email;
  const [u, d] = email.split('@');
  return `${u.slice(0, 2)}***@${d || '?'}`;
};

async function main() {
  const admins = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN' },
    select: { id: true, email: true, fullName: true, is_active: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const ids = admins.map(a => a.id);
  const [activityCreates, auditCreates, liveTokens] = await Promise.all([
    prisma.activityLog.findMany({ where: { action: 'USER_CREATED', entityId: { in: ids } }, select: { entityId: true, userId: true } }),
    prisma.auditLog.findMany({ where: { action: 'USER_REGISTERED', recordId: { in: ids } }, select: { recordId: true, performedBy: true } }),
    prisma.refreshToken.groupBy({ by: ['userId'], where: { userId: { in: ids }, isRevoked: false, expiresAt: { gt: new Date() } }, _count: true }),
  ]);
  const createdBy = new Map<string, string>();
  activityCreates.forEach(a => a.entityId && createdBy.set(a.entityId, a.userId || 'unknown'));
  auditCreates.forEach(a => a.recordId && createdBy.set(a.recordId, a.performedBy || 'unknown'));
  const tokens = new Map(liveTokens.map(t => [t.userId, t._count]));

  console.log(`SUPER_ADMIN accounts: ${admins.length} (active: ${admins.filter(a => a.is_active).length})\n`);
  for (const a of admins) {
    const origin = createdBy.get(a.id);
    const flag = origin ? 'ok      ' : 'SUSPECT ';
    console.log(`${flag} id=${a.id} email=${mask(a.email)} active=${a.is_active} created=${a.createdAt.toISOString()} createdBy=${origin || '(no admin-creation record)'} liveRefreshTokens=${tokens.get(a.id) || 0}`);
  }
  console.log('\nSUSPECT = no USER_CREATED/USER_REGISTERED record by another admin. Seeded/initial accounts also appear here; verify each manually.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
