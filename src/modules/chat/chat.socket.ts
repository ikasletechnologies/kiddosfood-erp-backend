import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import { JwtUtil } from '../../lib/jwt.util';
import { AppError } from '../../middleware/error.middleware';
import { ChatService, ChatActor, ChatMessageDto } from './chat.service';
import { assertId } from './chat.validation';

/**
 * Real-time chat on its own `/chat` namespace. Unlike the default namespace
 * (open `join` for ERP notifications, left untouched), every socket here must
 * present a valid access token, and room membership is decided by the server
 * from the user's DB role/franchise:
 *   SUPER_ADMIN      → chat:admins
 *   FRANCHISE_ADMIN  → chat:franchise:<their franchiseId>
 * Clients cannot join or leave rooms. Rooms are per-namespace, so joining a
 * same-named room on the default namespace receives nothing from here.
 */

export const CHAT_NAMESPACE = '/chat';
const ADMIN_ROOM = 'chat:admins';
const franchiseRoom = (franchiseId: string) => `chat:franchise:${franchiseId}`;

let nsp: Namespace | null = null;

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string; status?: number }) => void;

function reply(ack: unknown, payload: Parameters<Ack>[0]) {
  if (typeof ack === 'function') (ack as Ack)(payload);
}

function failure(err: unknown) {
  if (err instanceof AppError) return { ok: false as const, error: err.message, status: err.statusCode };
  console.error('[Chat] socket handler error', err);
  return { ok: false as const, error: 'Something went wrong', status: 500 };
}

function roomsFor(franchiseId: string) {
  return [ADMIN_ROOM, franchiseRoom(franchiseId)];
}

/** Delivers a saved message to HQ and to that franchise only. */
export function broadcastMessage(franchiseId: string, message: ChatMessageDto) {
  nsp?.to(roomsFor(franchiseId)).emit('chat:message', { conversationId: message.conversationId, franchiseId, message });
}

/** Read-receipt update for both sides of one conversation. */
export function broadcastRead(
  franchiseId: string,
  read: { conversationId: string; userId: string; role: string; lastReadAt: string },
) {
  nsp?.to(roomsFor(franchiseId)).emit('chat:read', { ...read, franchiseId });
}

export function initChatSocket(io: SocketIOServer) {
  nsp = io.of(CHAT_NAMESPACE);

  nsp.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = typeof token === 'string' && token ? JwtUtil.verifyAccessToken(token) : null;
    if (!payload) return next(new Error('UNAUTHORIZED'));
    try {
      socket.data.actor = await ChatService.resolveActor(payload.userId);
      socket.data.tokenExp = (payload as { exp?: number }).exp ?? 0;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  nsp.on('connection', (socket: Socket) => {
    const actor = socket.data.actor as ChatActor;
    socket.join(actor.role === 'SUPER_ADMIN' ? ADMIN_ROOM : franchiseRoom(actor.franchiseId!));

    // Re-checks the session on every event: the token may have expired since
    // the handshake, or the user may have been deactivated / re-assigned.
    const current = async (): Promise<ChatActor | null> => {
      if (Date.now() / 1000 >= socket.data.tokenExp) {
        socket.emit('chat:session-expired');
        socket.disconnect(true);
        return null;
      }
      const fresh = await ChatService.resolveActor(actor.userId);
      if (fresh.role !== actor.role || fresh.franchiseId !== actor.franchiseId) {
        socket.disconnect(true);
        return null;
      }
      return fresh;
    };

    socket.on('chat:send', async (data: any, ack: unknown) => {
      try {
        const me = await current();
        if (!me) return reply(ack, { ok: false, error: 'SESSION_EXPIRED', status: 401 });
        const result = await ChatService.sendMessage(me, {
          conversationId: assertId(data?.conversationId, 'conversationId'),
          content: data?.content,
          clientMessageId: data?.clientMessageId,
        });
        if (!result.duplicate) {
          broadcastMessage(result.conversation.franchiseId, result.message);
          if (result.read) broadcastRead(result.conversation.franchiseId, result.read);
        }
        reply(ack, { ok: true, message: result.message, duplicate: result.duplicate });
      } catch (err) {
        reply(ack, failure(err));
      }
    });

    socket.on('chat:read', async (data: any, ack: unknown) => {
      try {
        const me = await current();
        if (!me) return reply(ack, { ok: false, error: 'SESSION_EXPIRED', status: 401 });
        const result = await ChatService.markRead(me, assertId(data?.conversationId, 'conversationId'));
        if (result.read) broadcastRead(result.conversation.franchiseId, result.read);
        reply(ack, { ok: true, lastReadAt: result.read?.lastReadAt ?? null });
      } catch (err) {
        reply(ack, failure(err));
      }
    });

    // Room membership is server-controlled; refuse any client-driven join.
    for (const event of ['join', 'chat:join', 'subscribe', 'chat:subscribe']) {
      socket.on(event, (_data: unknown, ack: unknown) => {
        console.warn(`[Chat] rejected client room request "${event}" from user ${actor.userId}`);
        reply(ack, { ok: false, error: 'Room membership is server-controlled', status: 403 });
      });
    }
  });
}
