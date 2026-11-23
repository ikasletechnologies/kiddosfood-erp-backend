import prisma from './prisma';

/**
 * Append-only audit record for security-sensitive mutations (Phase 1 fixes).
 *
 * Unlike AuditService.log (ActivityLog, fire-and-forget, errors swallowed),
 * this writes AuditLog through the caller's transaction client: if the audit
 * row cannot be written, the mutation it describes rolls back with it.
 */
export interface AuditActor {
  userId?: string | null;
  role?: string | null;
  franchiseId?: string | null;
  label?: string | null;
}

export async function writeAuditLog(
  db: any,
  entry: {
    module: string;
    action: string;
    recordId?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    actor?: AuditActor | null;
  }
) {
  const actor = entry.actor || {};
  return (db || prisma).auditLog.create({
    data: {
      module: entry.module,
      action: entry.action,
      recordId: entry.recordId ?? null,
      oldValue: entry.oldValue === undefined ? undefined : (entry.oldValue as any),
      newValue: {
        ...(entry.newValue && typeof entry.newValue === 'object' ? (entry.newValue as object) : entry.newValue !== undefined ? { value: entry.newValue } : {}),
        actor: { userId: actor.userId ?? null, role: actor.role ?? null, franchiseId: actor.franchiseId ?? null },
      } as any,
      performedBy: actor.userId || actor.label || 'UNKNOWN',
    },
  });
}

/** Builds an AuditActor from the authenticated request user (req.user). */
export function actorFromUser(user: any): AuditActor {
  return {
    userId: user?.userId ?? null,
    role: user?.role ?? null,
    franchiseId: user?.franchiseId ?? null,
    label: user?.fullName || user?.email || null,
  };
}
