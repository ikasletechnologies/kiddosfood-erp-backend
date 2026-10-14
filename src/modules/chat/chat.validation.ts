import { AppError } from '../../middleware/error.middleware';

export const CHAT_MAX_LENGTH = 2000;
export const CHAT_PAGE_SIZE = 30;
export const CHAT_MAX_PAGE_SIZE = 100;

// Rate limit per sender, shared by the REST and socket send paths.
const RATE_WINDOW_MS = 30_000;
const RATE_MAX_MESSAGES = 20;

// Control characters except tab and newline — matching them is the point.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns the message text to store, or throws a 400. Content is stored as
 * plain text and must be rendered as text (never as HTML) by clients.
 */
export function normalizeContent(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError('Message must be text', 400);
  // Cheap guard before any processing of oversized payloads.
  if (raw.length > CHAT_MAX_LENGTH * 2) {
    throw new AppError(`Message exceeds ${CHAT_MAX_LENGTH} characters`, 400);
  }
  const content = raw
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!content) throw new AppError('Message cannot be empty', 400);
  if (content.length > CHAT_MAX_LENGTH) {
    throw new AppError(`Message exceeds ${CHAT_MAX_LENGTH} characters`, 400);
  }
  return content;
}

export function normalizeClientMessageId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !CLIENT_MESSAGE_ID.test(raw)) {
    throw new AppError('Invalid clientMessageId', 400);
  }
  return raw;
}

export function assertId(raw: unknown, label = 'id'): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new AppError(`Invalid ${label}`, 400);
  return raw;
}

export function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return CHAT_PAGE_SIZE;
  return Math.min(Math.floor(n), CHAT_MAX_PAGE_SIZE);
}

export function parseDate(raw: unknown, label: string): Date | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new AppError(`Invalid ${label}`, 400);
  return d;
}

const sendLog = new Map<string, number[]>();

/** Records a send for this user; throws 429 when over the limit. */
export function consumeSendQuota(userId: string, now = Date.now()) {
  const recent = (sendLog.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_MESSAGES) {
    sendLog.set(userId, recent);
    throw new AppError('You are sending messages too quickly. Please wait a moment.', 429);
  }
  recent.push(now);
  sendLog.set(userId, recent);
}

// Drop idle entries so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [userId, times] of sendLog) {
    if (!times.some((t) => now - t < RATE_WINDOW_MS)) sendLog.delete(userId);
  }
}, 60_000).unref();
