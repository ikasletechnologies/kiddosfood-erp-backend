import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { AuditService } from '../audit/audit.service';
import { STAGE_CONFIG, getStageIndex } from './stage-config';

type Category = keyof typeof STAGE_CONFIG;

export class WorkflowApprovalsService {
  // A Super Admin sees every request; a Franchise Admin only ever sees
  // (and can act on) requests belonging to their own franchise.
  static async getAll(category?: Category, franchiseId?: string | null) {
    return prisma.workflowRequest.findMany({
      where: {
        ...(category ? { category } : {}),
        ...(franchiseId ? { franchiseId } : {}),
      },
      include: { history: { orderBy: { timestamp: 'asc' } } },
      orderBy: { dateInitiated: 'desc' },
    });
  }

  static async getOne(id: string, franchiseId?: string | null) {
    const request = await prisma.workflowRequest.findUnique({
      where: { id },
      include: { history: { orderBy: { timestamp: 'asc' } } },
    });
    if (request && franchiseId && request.franchiseId && request.franchiseId !== franchiseId) {
      throw new AppError('Forbidden: this request belongs to a different franchise', 403);
    }
    return request;
  }

  static async create(
    data: { category: Category; title: string; amount?: number; details?: any; franchiseId?: string },
    actingUser: { userId: string; fullName?: string; role: string; franchiseId?: string | null }
  ) {
    const stages = STAGE_CONFIG[data.category];
    if (!stages) throw new AppError('Invalid workflow category', 400);
    if (!data.title?.trim()) throw new AppError('Title is required', 400);

    // A Franchise Admin's requests are always stamped with their own
    // franchise — the client can't claim to initiate on behalf of another one.
    const franchiseId = actingUser.role === 'SUPER_ADMIN'
      ? (data.franchiseId || null)
      : (actingUser.franchiseId || null);

    const count = await prisma.workflowRequest.count({ where: { category: data.category } });
    const prefix = data.category === 'PURCHASE' ? 'PUR' : data.category === 'PRODUCTION' ? 'PROD' : 'EXP';
    const displayId = `WF-${prefix}-${100 + count + 1}`;

    const request = await prisma.workflowRequest.create({
      data: {
        displayId,
        category: data.category,
        title: data.title.trim(),
        amount: data.amount,
        currentStage: stages[0].key,
        initiatedBy: actingUser.fullName || actingUser.userId,
        franchiseId,
        details: data.details || {},
        history: {
          create: {
            stage: stages[0].key,
            userId: actingUser.userId,
            userLabel: actingUser.fullName || actingUser.userId,
            notes: `Created request at stage: ${stages[0].label}.`,
          },
        },
      },
      include: { history: true },
    });

    await AuditService.log({
      userId: actingUser.userId,
      action: 'WORKFLOW_REQUEST_CREATED',
      entityType: 'WorkflowRequest',
      entityId: request.id,
      targetFranchiseId: data.franchiseId,
      details: { displayId, category: data.category, title: request.title },
    });

    return request;
  }

  static async approve(
    id: string,
    actingUser: { userId: string; role: string; fullName?: string; franchiseId?: string | null },
    notes?: string
  ) {
    const request = await prisma.workflowRequest.findUnique({ where: { id } });
    if (!request) throw new AppError('Workflow request not found', 404);

    const category = request.category as Category;
    const stages = STAGE_CONFIG[category];
    const curIdx = getStageIndex(category, request.currentStage);
    if (curIdx === -1) throw new AppError('Request is in an unknown stage', 400);
    if (curIdx === stages.length - 1) throw new AppError('Workflow is already at the final stage', 400);

    const currentStageDef = stages[curIdx];
    const nextStageDef = stages[curIdx + 1];

    const isSuperAdmin = actingUser.role === 'SUPER_ADMIN';

    // Every stage is approvable by any Franchise Admin — the only rule is
    // they must own the request's franchise. A Super Admin can act on any
    // franchise (that's recorded as an override below, purely for the audit
    // trail — it isn't a permission check).
    if (!isSuperAdmin && request.franchiseId && request.franchiseId !== actingUser.franchiseId) {
      throw new AppError('Forbidden: this request belongs to a different franchise', 403);
    }

    const isOverride = isSuperAdmin && !!request.franchiseId && request.franchiseId !== actingUser.franchiseId;

    const [updated] = await prisma.$transaction([
      prisma.workflowRequest.update({
        where: { id },
        data: {
          currentStage: nextStageDef.key,
          history: {
            create: {
              stage: currentStageDef.key,
              userId: actingUser.userId,
              userLabel: actingUser.fullName || actingUser.userId,
              notes: notes || `Advanced workflow to ${nextStageDef.label}.`,
              isOverride,
            },
          },
        },
        include: { history: { orderBy: { timestamp: 'asc' } } },
      }),
    ]);

    await AuditService.log({
      userId: actingUser.userId,
      action: 'WORKFLOW_APPROVED',
      entityType: 'WorkflowRequest',
      entityId: id,
      targetFranchiseId: request.franchiseId || undefined,
      details: {
        displayId: request.displayId,
        category,
        fromStage: currentStageDef.key,
        toStage: nextStageDef.key,
        isOverride,
      },
    });

    return updated;
  }
}
