import { Request, Response, NextFunction } from 'express';
import { ChatService } from './chat.service';
import { broadcastMessage, broadcastRead } from './chat.socket';
import { assertId, parseDate, parseLimit } from './chat.validation';

// The actor is always re-loaded from the DB (role, franchiseId, is_active);
// the JWT only identifies the user.
const actorOf = (req: Request) => ChatService.resolveActor((req as any).user?.userId);

export class ChatController {
  static async inbox(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      res.json(await ChatService.listInbox(actor, req.query.search as string | undefined));
    } catch (err) {
      next(err);
    }
  }

  static async mine(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      res.json(await ChatService.getMyConversation(actor));
    } catch (err) {
      next(err);
    }
  }

  static async openForFranchise(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      res.json(await ChatService.openFranchiseConversation(actor, assertId(req.params.franchiseId, 'franchiseId')));
    } catch (err) {
      next(err);
    }
  }

  static async messages(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      const before = req.query.before ? assertId(req.query.before, 'before') : undefined;
      res.json(
        await ChatService.listMessages(actor, assertId(req.params.id, 'conversationId'), {
          before,
          after: parseDate(req.query.after, 'after'),
          limit: parseLimit(req.query.limit),
        }),
      );
    } catch (err) {
      next(err);
    }
  }

  // REST fallback for sending (the socket `chat:send` event is the primary path).
  static async send(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      const result = await ChatService.sendMessage(actor, {
        conversationId: assertId(req.params.id, 'conversationId'),
        content: req.body?.content,
        clientMessageId: req.body?.clientMessageId,
      });
      if (!result.duplicate) {
        broadcastMessage(result.conversation.franchiseId, result.message);
        if (result.read) broadcastRead(result.conversation.franchiseId, result.read);
      }
      res.status(result.duplicate ? 200 : 201).json({ message: result.message, duplicate: result.duplicate });
    } catch (err) {
      next(err);
    }
  }

  static async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      const result = await ChatService.markRead(actor, assertId(req.params.id, 'conversationId'));
      if (result.read) broadcastRead(result.conversation.franchiseId, result.read);
      res.json({ lastReadAt: result.read?.lastReadAt ?? null });
    } catch (err) {
      next(err);
    }
  }

  static async unread(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = await actorOf(req);
      res.json(await ChatService.getUnreadSummary(actor));
    } catch (err) {
      next(err);
    }
  }
}
