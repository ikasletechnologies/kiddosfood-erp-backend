import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { AuditService } from '../audit/audit.service';
import { PermissionUtil } from '../../utils/permission.util';
import { STAGE_CONFIG, getStageIndex } from './stage-config';

type Category = keyof typeof STAGE_CONFIG;

export class WorkflowApprovalsService {
  static async getAll(category?: Category) {
    return prisma.workflowRequest.findMany({
      where: category ? { category } : undefined,
      include: { history: { orderBy: { timestamp: 'asc' } } },
      orderBy: { dateInitiated: 'desc' },
    });
  }

  static async getOne(id: string) {
    return prisma.workflowRequest.findUnique({
      where: { id },
      include: { history: { orderBy: { timestamp: 'asc' } } },
    });
  }

  static async create(
    data: { category: Category; title: string; amount?: number; details?: any; franchiseId?: string },
    actingUser: { userId: string; fullName?: string }
  ) {
    const stages = STAGE_CONFIG[data.category];
    if (!stages) throw new AppError('Invalid workflow category', 400);
    if (!data.title?.trim()) throw new AppError('Title is required', 400);

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
        franchiseId: data.franchiseId || null,
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
    actingUser: { userId: string; role: string; fullName?: string },
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

    const effective = await PermissionUtil.getEffectivePermissions(actingUser.userId);
    const hasPermission = effective.permissions.includes(currentStageDef.requiredPermission);
    const isSuperAdmin = actingUser.role === 'SUPER_ADMIN';

    if (!isSuperAdmin && !hasPermission) {
      throw new AppError(
        `Forbidden: this stage requires the '${currentStageDef.requiredPermission}' permission, which your assigned role does not have.`,
        403
      );
    }

    const isOverride = isSuperAdmin && !hasPermission;

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
