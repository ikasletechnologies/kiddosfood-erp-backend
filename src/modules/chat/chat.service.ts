import { Prisma, UserRole, ChatConversationType } from '@prisma/client';
import prisma from '../../lib/prisma';
import { AppError } from '../../middleware/error.middleware';
import { normalizeContent, normalizeClientMessageId, consumeSendQuota } from './chat.validation';

/**
 * Super Admin ⇄ Franchise private chat.
 *
 * Every authorization decision here is made from the user's DB row (role and
 * franchiseId), loaded per request/event by resolveActor — never from the JWT
 * claims alone and never from a franchise id the client sends. A franchise
 * user asking for any conversation other than their own gets the same 404 as
 * a non-existent id, so ids cannot be probed.
 */

const TYPE = ChatConversationType.FRANCHISE_SUPPORT;
const SYNC_MAX = 200;

export interface ChatActor {
  userId: string;
  role: 'SUPER_ADMIN' | 'FRANCHISE_ADMIN';
  franchiseId: string | null;
  fullName: string;
}

type ConversationRow = { id: string; franchiseId: string; lastMessageAt: Date | null; franchise: { id: string; name: string } };

const messageInclude = { sender: { select: { fullName: true } } } as const;
type MessageRow = Prisma.ChatMessageGetPayload<{ include: typeof messageInclude }>;

export function toMessageDto(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderUserId: m.senderUserId,
    senderRole: m.senderRole,
    senderName: m.sender?.fullName ?? 'Former user',
    messageType: m.messageType,
    content: m.deletedAt ? '' : m.content,
    clientMessageId: m.clientMessageId,
    createdAt: m.createdAt.toISOString(),
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
  };
}
export type ChatMessageDto = ReturnType<typeof toMessageDto>;

function toConversationDto(c: ConversationRow) {
  return {
    id: c.id,
    franchiseId: c.franchiseId,
    franchiseName: c.franchise.name,
    lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
  };
}

const peerRole = (role: ChatActor['role']): UserRole =>
  role === 'SUPER_ADMIN' ? UserRole.FRANCHISE_ADMIN : UserRole.SUPER_ADMIN;

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class ChatService {
  /** Loads the acting user from the DB. Throws 401/403 if they may not chat. */
  static async resolveActor(userId: string | undefined): Promise<ChatActor> {
    if (!userId) throw new AppError('Unauthorized', 401);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, franchiseId: true, is_active: true, fullName: true },
    });
    if (!user || !user.is_active) throw new AppError('Unauthorized', 401);
    if (user.role === UserRole.FRANCHISE_ADMIN && !user.franchiseId) {
      throw new AppError('Forbidden: user is not linked to a franchise', 403);
    }
    return { userId: user.id, role: user.role, franchiseId: user.franchiseId, fullName: user.fullName };
  }

  private static async getOrCreateConversation(franchiseId: string): Promise<ConversationRow> {
    const select = { id: true, franchiseId: true, lastMessageAt: true, franchise: { select: { id: true, name: true } } };
    try {
      return await prisma.chatConversation.upsert({
        where: { franchiseId_type: { franchiseId, type: TYPE } },
        update: {},
        create: { franchiseId, type: TYPE },
        select,
      });
    } catch (err) {
      // Two first-time requests raced on the unique key; the other one won.
      if (!isUniqueViolation(err)) throw err;
      return prisma.chatConversation.findUniqueOrThrow({
        where: { franchiseId_type: { franchiseId, type: TYPE } },
        select,
      });
    }
  }

  /** Throws 404 unless the actor may access this conversation. */
  static async getAccessibleConversation(actor: ChatActor, conversationId: string): Promise<ConversationRow> {
    const conv = await prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, franchiseId: true, lastMessageAt: true, franchise: { select: { id: true, name: true } } },
    });
    const allowed = conv && (actor.role === 'SUPER_ADMIN' || conv.franchiseId === actor.franchiseId);
    if (!conv || !allowed) throw new AppError('Conversation not found', 404);
    return conv;
  }

  private static async unreadCounts(actor: ChatActor, conversationIds: string[]) {
    const result = new Map<string, number>();
    if (conversationIds.length === 0) return result;
    const rows = await prisma.$queryRaw<{ conversationId: string; unread: number }[]>`
      SELECT m."conversationId", COUNT(*)::int AS "unread"
      FROM "ChatMessage" m
      LEFT JOIN "ChatReadState" r
        ON r."conversationId" = m."conversationId" AND r."userId" = ${actor.userId}
      WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
        AND m."deletedAt" IS NULL
        AND m."senderRole"::text = ${peerRole(actor.role)}
        AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
      GROUP BY m."conversationId"`;
    for (const r of rows) result.set(r.conversationId, Number(r.unread));
    return result;
  }

  /** Latest time anyone on the other side read this conversation (for ✓✓). */
  private static async peerLastReadAt(actor: ChatActor, conv: ConversationRow): Promise<string | null> {
    const role = peerRole(actor.role);
    const agg = await prisma.chatReadState.aggregate({
      where: {
        conversationId: conv.id,
        user: role === UserRole.SUPER_ADMIN ? { role } : { role, franchiseId: conv.franchiseId },
      },
      _max: { lastReadAt: true },
    });
    return agg._max.lastReadAt ? agg._max.lastReadAt.toISOString() : null;
  }

  /** Super Admin inbox: every franchise, with its conversation summary if one exists. */
  static async listInbox(actor: ChatActor, search?: string) {
    if (actor.role !== 'SUPER_ADMIN') throw new AppError('Forbidden', 403);
    const term = typeof search === 'string' ? search.trim().slice(0, 100) : '';
    const franchises = await prisma.franchise.findMany({
      where: {
        isHQ: false,
        ...(term && {
          OR: [
            { name: { contains: term, mode: 'insensitive' as const } },
            { location: { contains: term, mode: 'insensitive' as const } },
            { ownerName: { contains: term, mode: 'insensitive' as const } },
          ],
        }),
      },
      select: {
        id: true,
        name: true,
        location: true,
        status: true,
        chatConversations: { where: { type: TYPE }, select: { id: true, lastMessageAt: true } },
      },
    });

    const convIds = franchises.flatMap((f) => f.chatConversations.map((c) => c.id));
    const unread = await this.unreadCounts(actor, convIds);
    const latest = new Map<string, { content: string; senderRole: UserRole; createdAt: Date; deletedAt: Date | null }>();
    if (convIds.length > 0) {
      const rows = await prisma.$queryRaw<{ conversationId: string; content: string; senderRole: UserRole; createdAt: Date; deletedAt: Date | null }[]>`
        SELECT DISTINCT ON ("conversationId") "conversationId", "content", "senderRole", "createdAt", "deletedAt"
        FROM "ChatMessage"
        WHERE "conversationId" IN (${Prisma.join(convIds)})
        ORDER BY "conversationId", "createdAt" DESC, "id" DESC`;
      for (const r of rows) latest.set(r.conversationId, r);
    }

    const items = franchises.map((f) => {
      const conv = f.chatConversations[0];
      const last = conv ? latest.get(conv.id) : undefined;
      return {
        franchiseId: f.id,
        franchiseName: f.name,
        location: f.location,
        status: f.status,
        conversationId: conv?.id ?? null,
        lastMessageAt: conv?.lastMessageAt ? conv.lastMessageAt.toISOString() : null,
        lastMessage: last
          ? {
              preview: last.deletedAt ? 'Message deleted' : last.content.slice(0, 120),
              senderRole: last.senderRole,
              createdAt: last.createdAt.toISOString(),
            }
          : null,
        unreadCount: conv ? unread.get(conv.id) ?? 0 : 0,
      };
    });
    items.sort((a, b) => {
      if (a.lastMessageAt && b.lastMessageAt) return b.lastMessageAt.localeCompare(a.lastMessageAt);
      if (a.lastMessageAt) return -1;
      if (b.lastMessageAt) return 1;
      return a.franchiseName.localeCompare(b.franchiseName);
    });
    return { items };
  }

  /** Franchise user: their own franchise's conversation (created on first use). */
  static async getMyConversation(actor: ChatActor) {
    if (actor.role !== 'FRANCHISE_ADMIN' || !actor.franchiseId) throw new AppError('Forbidden', 403);
    const conv = await this.getOrCreateConversation(actor.franchiseId);
    const unread = await this.unreadCounts(actor, [conv.id]);
    return { conversation: toConversationDto(conv), unreadCount: unread.get(conv.id) ?? 0 };
  }

  /** Super Admin: open (or create) the conversation with one franchise. */
  static async openFranchiseConversation(actor: ChatActor, franchiseId: string) {
    if (actor.role !== 'SUPER_ADMIN') throw new AppError('Forbidden', 403);
    const franchise = await prisma.franchise.findUnique({ where: { id: franchiseId }, select: { id: true, isHQ: true } });
    if (!franchise || franchise.isHQ) throw new AppError('Franchise not found', 404);
    const conv = await this.getOrCreateConversation(franchiseId);
    const unread = await this.unreadCounts(actor, [conv.id]);
    return { conversation: toConversationDto(conv), unreadCount: unread.get(conv.id) ?? 0 };
  }

  /**
   * History, newest page first (returned oldest→newest). `before` pages back
   * from a message id; `after` returns everything newer than a timestamp and is
   * what clients use to resync after a reconnect.
   */
  static async listMessages(actor: ChatActor, conversationId: string, opts: { before?: string; after?: Date; limit: number }) {
    const conv = await this.getAccessibleConversation(actor, conversationId);
    let messages: MessageRow[];
    let hasMore: boolean;

    if (opts.after) {
      messages = await prisma.chatMessage.findMany({
        where: { conversationId: conv.id, createdAt: { gt: opts.after } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SYNC_MAX + 1,
        include: messageInclude,
      });
      hasMore = messages.length > SYNC_MAX;
      if (hasMore) messages = messages.slice(0, SYNC_MAX);
    } else {
      let cursorWhere: Prisma.ChatMessageWhereInput = {};
      if (opts.before) {
        const cursor = await prisma.chatMessage.findFirst({
          where: { id: opts.before, conversationId: conv.id },
          select: { id: true, createdAt: true },
        });
        if (!cursor) throw new AppError('Invalid cursor', 400);
        cursorWhere = {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        };
      }
      const page = await prisma.chatMessage.findMany({
        where: { conversationId: conv.id, ...cursorWhere },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.limit + 1,
        include: messageInclude,
      });
      hasMore = page.length > opts.limit;
      messages = page.slice(0, opts.limit).reverse();
    }

    return {
      conversation: toConversationDto(conv),
      messages: messages.map(toMessageDto),
      hasMore,
      peerLastReadAt: await this.peerLastReadAt(actor, conv),
    };
  }

  /**
   * Persists a message. Retries carrying the same clientMessageId return the
   * originally saved message with duplicate=true (callers must not rebroadcast).
   */
  static async sendMessage(actor: ChatActor, input: { conversationId: string; content: unknown; clientMessageId?: unknown }) {
    const content = normalizeContent(input.content);
    const clientMessageId = normalizeClientMessageId(input.clientMessageId);
    const conv = await this.getAccessibleConversation(actor, input.conversationId);

    if (clientMessageId) {
      const existing = await prisma.chatMessage.findUnique({
        where: { senderUserId_clientMessageId: { senderUserId: actor.userId, clientMessageId } },
        include: messageInclude,
      });
      if (existing) {
        if (existing.conversationId !== conv.id) throw new AppError('clientMessageId already used', 409);
        return { conversation: conv, message: toMessageDto(existing), duplicate: true, read: null };
      }
    }

    consumeSendQuota(actor.userId);

    try {
      const { message, read } = await prisma.$transaction(async (tx) => {
        const message = await tx.chatMessage.create({
          data: {
            conversationId: conv.id,
            senderUserId: actor.userId,
            senderRole: actor.role,
            content,
            clientMessageId,
          },
          include: messageInclude,
        });
        await tx.chatConversation.update({ where: { id: conv.id }, data: { lastMessageAt: message.createdAt } });
        // Sending implies the sender has seen the conversation up to here.
        const read = await tx.chatReadState.upsert({
          where: { conversationId_userId: { conversationId: conv.id, userId: actor.userId } },
          update: { lastReadAt: message.createdAt, lastReadMessageId: message.id },
          create: { conversationId: conv.id, userId: actor.userId, lastReadAt: message.createdAt, lastReadMessageId: message.id },
        });
        return { message, read };
      });
      return {
        conversation: conv,
        message: toMessageDto(message),
        duplicate: false,
        read: { conversationId: conv.id, userId: actor.userId, role: actor.role, lastReadAt: read.lastReadAt.toISOString() },
      };
    } catch (err) {
      // Concurrent retry with the same clientMessageId won the insert.
      if (clientMessageId && isUniqueViolation(err)) {
        const existing = await prisma.chatMessage.findUniqueOrThrow({
          where: { senderUserId_clientMessageId: { senderUserId: actor.userId, clientMessageId } },
          include: messageInclude,
        });
        return { conversation: conv, message: toMessageDto(existing), duplicate: true, read: null };
      }
      throw err;
    }
  }

  /**
   * Moves the actor's read position to the newest message. Returns null when
   * nothing changed (so callers don't broadcast a no-op receipt).
   */
  static async markRead(actor: ChatActor, conversationId: string) {
    const conv = await this.getAccessibleConversation(actor, conversationId);
    const latest = await prisma.chatMessage.findFirst({
      where: { conversationId: conv.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    });
    if (!latest) return { conversation: conv, read: null };

    const key = { conversationId_userId: { conversationId: conv.id, userId: actor.userId } };
    const current = await prisma.chatReadState.findUnique({ where: key, select: { lastReadAt: true } });
    if (current && current.lastReadAt >= latest.createdAt) return { conversation: conv, read: null };

    const state = await prisma.chatReadState.upsert({
      where: key,
      update: { lastReadAt: latest.createdAt, lastReadMessageId: latest.id },
      create: { conversationId: conv.id, userId: actor.userId, lastReadAt: latest.createdAt, lastReadMessageId: latest.id },
    });
    return {
      conversation: conv,
      read: { conversationId: conv.id, userId: actor.userId, role: actor.role, lastReadAt: state.lastReadAt.toISOString() },
    };
  }

  /** Unread totals for the sidebar badge, scoped to what the actor may see. */
  static async getUnreadSummary(actor: ChatActor) {
    const conversations = await prisma.chatConversation.findMany({
      where: actor.role === 'SUPER_ADMIN' ? { type: TYPE } : { type: TYPE, franchiseId: actor.franchiseId! },
      select: { id: true },
    });
    const counts = await this.unreadCounts(actor, conversations.map((c) => c.id));
    let total = 0;
    const byConversation: Record<string, number> = {};
    for (const [id, n] of counts) {
      byConversation[id] = n;
      total += n;
    }
    return { total, byConversation };
  }
}
