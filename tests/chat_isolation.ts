/**
 * Super Admin ⇄ Franchise chat: isolation, authorization and messaging checks
 * against the real DB, REST routes and /chat socket namespace.
 *
 * Starts its own in-process server on a random port (does not touch a running
 * dev server), creates two throwaway franchises + users, and deletes them
 * (and, via cascade, their chat data) at the end.
 *
 * Run: npx tsx tests/chat_isolation.ts
 */

import 'dotenv/config';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import app from '../src/app';
import prisma from '../src/lib/prisma';
import SocketService from '../src/lib/socket';
import { JwtUtil } from '../src/lib/jwt.util';
import { initChatSocket } from '../src/modules/chat/chat.socket';

// socket.io-client is a frontend dependency; reuse it from there if the
// backend doesn't have it installed.
function loadClient() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('socket.io-client');
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(require.resolve('socket.io-client', {
      paths: [path.resolve(__dirname, '../../kiddosfood-erp-frontend')],
    }));
  }
}
const { io: connect } = loadClient();

let failed = 0;
function check(cond: unknown, msg: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
}

const TAG = `chat-test-${Date.now()}`;
let base = '';

async function http(token: string | null, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}/api/chat${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

function openSocket(token: string | null): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = connect(`${base}/chat`, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e: Error) => { s.close(); reject(e); });
  });
}

/** Collects every `event` payload a socket receives. */
function inbox(socket: any, event: string) {
  const got: any[] = [];
  socket.on(event, (p: any) => got.push(p));
  return got;
}

const emit = (s: any, event: string, data: unknown): Promise<any> =>
  new Promise((resolve) => s.timeout(5000).emit(event, data, (err: unknown, res: any) => resolve(err ? { ok: false, error: 'timeout' } : res)));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const cmid = () => `${TAG}-${Math.random().toString(36).slice(2, 12)}`.replace(/[^A-Za-z0-9_-]/g, '');

async function main() {
  const server = createServer(app);
  SocketService.init(server);
  initChatSocket(SocketService.io);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const mkFranchise = (n: number) =>
    prisma.franchise.create({ data: { name: `${TAG} Franchise ${n}`, location: 'Test', ownerName: 'Owner', contactNum: '9000000000', isHQ: false } });
  const f1 = await mkFranchise(1);
  const f2 = await mkFranchise(2);
  const mkUser = (role: 'SUPER_ADMIN' | 'FRANCHISE_ADMIN', franchiseId: string | null, n: string) =>
    prisma.user.create({ data: { fullName: `${TAG} ${n}`, email: `${TAG}-${n}@test.local`, passwordHash: 'x', role, franchiseId } });
  const sa = await mkUser('SUPER_ADMIN', null, 'sa');
  const u1 = await mkUser('FRANCHISE_ADMIN', f1.id, 'f1');
  const u2 = await mkUser('FRANCHISE_ADMIN', f2.id, 'f2');
  const tok = (u: { id: string; role: string; franchiseId: string | null }) =>
    JwtUtil.generateAccessToken({ userId: u.id, role: u.role, franchiseId: u.franchiseId });
  const [tSA, t1, t2] = [tok(sa), tok(u1), tok(u2)];

  const sockets: any[] = [];
  try {
    // ── Auth ────────────────────────────────────────────────────────────
    check((await http(null, 'GET', '/unread')).status === 401, 'REST without token → 401');
    check((await http('garbage', 'GET', '/unread')).status === 401, 'REST with invalid token → 401');
    let rejected = '';
    try { await openSocket(null); } catch (e: any) { rejected = e.message; }
    check(rejected === 'UNAUTHORIZED', 'socket without token rejected');
    rejected = '';
    try { await openSocket('not-a-jwt'); } catch (e: any) { rejected = e.message; }
    check(rejected === 'UNAUTHORIZED', 'socket with invalid token rejected');

    // ── Conversations ───────────────────────────────────────────────────
    const c1 = (await http(t1, 'GET', '/conversations/mine')).body.conversation;
    const c2 = (await http(t2, 'GET', '/conversations/mine')).body.conversation;
    const c1again = (await http(t1, 'GET', '/conversations/mine')).body.conversation;
    check(c1?.franchiseId === f1.id && c2?.franchiseId === f2.id, 'each franchise gets its own conversation');
    check(c1.id !== c2.id && c1again.id === c1.id, 'repeat requests do not duplicate the conversation');
    const viaAdmin = (await http(tSA, 'POST', `/conversations/franchise/${f1.id}`)).body.conversation;
    check(viaAdmin?.id === c1.id, 'Super Admin opening franchise 1 reuses the same conversation');
    check((await http(tSA, 'GET', '/conversations/mine')).status === 403, 'Super Admin has no "mine" conversation (403)');

    const sSA = await openSocket(tSA);
    const s1 = await openSocket(t1);
    const s1b = await openSocket(t1); // second tab, same franchise user
    const s2 = await openSocket(t2);
    sockets.push(sSA, s1, s1b, s2);
    const [inSA, in1, in1b, in2] = [sSA, s1, s1b, s2].map((s) => inbox(s, 'chat:message'));
    const [rdSA, rd1, rd2] = [sSA, s1, s2].map((s) => inbox(s, 'chat:read'));

    // ── Messaging + isolation ───────────────────────────────────────────
    const id1 = cmid();
    const a1 = await emit(s1, 'chat:send', { conversationId: c1.id, content: 'Hello from Franchise 1', clientMessageId: id1 });
    check(a1?.ok && a1.message?.id && a1.message?.createdAt, 'franchise 1 send acked with saved id + timestamp');
    await settle();
    check(inSA.some((e) => e.message.content === 'Hello from Franchise 1'), 'Super Admin receives franchise 1 message in real time');
    check(in1b.some((e) => e.message.id === a1.message.id), "franchise 1's other tab receives it");
    check(in2.length === 0, 'franchise 2 does NOT receive franchise 1 message');

    const a2 = await emit(s2, 'chat:send', { conversationId: c2.id, content: 'Hello from Franchise 2', clientMessageId: cmid() });
    await settle();
    check(a2?.ok, 'franchise 2 send acked');
    check(inSA.some((e) => e.message.content === 'Hello from Franchise 2'), 'Super Admin receives franchise 2 message');
    check(!in1.some((e) => e.message.content === 'Hello from Franchise 2'), 'franchise 1 does NOT receive franchise 2 message');

    const inboxRes = await http(tSA, 'GET', `/conversations?search=${encodeURIComponent(TAG)}`);
    const items = inboxRes.body?.items || [];
    check(items.length === 2, 'Super Admin inbox (searched) shows exactly the two test franchises');
    check(items[0]?.franchiseId === f2.id, 'inbox ordered by latest message (franchise 2 first)');
    check(items.every((i: any) => i.unreadCount === 1), 'each conversation shows 1 unread for Super Admin');
    check(items.find((i: any) => i.franchiseId === f1.id)?.lastMessage?.preview === 'Hello from Franchise 1', 'latest message preview correct');

    in1.length = 0; in2.length = 0;
    const r1 = await emit(sSA, 'chat:send', { conversationId: c1.id, content: 'Reply to F1', clientMessageId: cmid() });
    await settle();
    check(r1?.ok && in1.some((e) => e.message.content === 'Reply to F1'), 'franchise 1 receives Super Admin reply');
    check(in2.length === 0, 'franchise 2 does NOT receive reply meant for franchise 1');
    const r2 = await emit(sSA, 'chat:send', { conversationId: c2.id, content: 'Reply to F2', clientMessageId: cmid() });
    await settle();
    check(r2?.ok && in2.some((e) => e.message.content === 'Reply to F2'), 'franchise 2 receives Super Admin reply');
    check(!in1.some((e) => e.message.content === 'Reply to F2'), 'franchise 1 does NOT receive reply meant for franchise 2');

    // ── Cross-franchise access attempts ─────────────────────────────────
    check((await http(t1, 'GET', `/conversations/${c2.id}/messages`)).status === 404, "franchise 1 reading franchise 2's messages → denied (404)");
    check((await http(t1, 'POST', `/conversations/${c2.id}/messages`, { content: 'x', clientMessageId: cmid() })).status === 404, "franchise 1 posting into franchise 2's conversation → denied");
    check((await http(t1, 'POST', `/conversations/${c2.id}/read`)).status === 404, "franchise 1 marking franchise 2's conversation read → denied");
    check((await http(t1, 'GET', '/conversations')).status === 403, 'franchise user cannot list the inbox (403)');
    check((await http(t1, 'POST', `/conversations/franchise/${f2.id}`)).status === 403, 'franchise user cannot open another franchise conversation (403)');
    const unread1 = (await http(t1, 'GET', '/unread')).body;
    check(Object.keys(unread1.byConversation).every((id) => id === c1.id), 'franchise 1 unread summary only covers its own conversation');

    in2.length = 0; inSA.length = 0;
    const sneak = await emit(s1, 'chat:send', { conversationId: c2.id, content: 'sneaky', clientMessageId: cmid() });
    await settle();
    check(sneak?.ok === false && sneak.status === 404, 'socket send into another franchise conversation rejected');
    check(in2.length === 0 && inSA.length === 0, 'rejected socket send was not delivered anywhere');

    const join = await emit(s1, 'join', { room: `chat:franchise:${f2.id}` });
    const join2 = await emit(s1, 'chat:join', { conversationId: c2.id });
    check(join?.ok === false && join2?.ok === false, 'client-requested room joins on /chat rejected');
    // Same room name on the default (legacy, open) namespace must not leak /chat traffic.
    const legacy = connect(base, { transports: ['websocket'], reconnection: false });
    sockets.push(legacy);
    const inLegacy = inbox(legacy, 'chat:message');
    await new Promise((r) => legacy.on('connect', r));
    legacy.emit('join', { room: `chat:franchise:${f2.id}` });
    legacy.emit('join', { room: 'chat:admins' });
    in1.length = 0;
    await settle(200);
    await emit(sSA, 'chat:send', { conversationId: c2.id, content: 'Private to F2', clientMessageId: cmid() });
    await settle();
    check(!in1.some((e) => e.message.content === 'Private to F2'), 'after malicious join attempt, franchise 1 still does not receive franchise 2 traffic');
    check(inLegacy.length === 0, 'joining chat room names on the default namespace receives nothing');

    // ── Duplicate prevention ────────────────────────────────────────────
    inSA.length = 0;
    const dup = await emit(s1, 'chat:send', { conversationId: c1.id, content: 'Hello from Franchise 1', clientMessageId: id1 });
    await settle();
    check(dup?.ok && dup.duplicate === true && dup.message.id === a1.message.id, 'retry with same clientMessageId returns the original message');
    check(inSA.length === 0, 'retry is not re-broadcast');
    check((await prisma.chatMessage.count({ where: { senderUserId: u1.id, clientMessageId: id1 } })) === 1, 'retry did not create a second row');
    const dupRest = await http(t1, 'POST', `/conversations/${c1.id}/messages`, { content: 'Hello from Franchise 1', clientMessageId: id1 });
    check(dupRest.status === 200 && dupRest.body.duplicate === true, 'REST retry with same clientMessageId is idempotent');

    // ── Validation ──────────────────────────────────────────────────────
    const bad = async (data: any) => (await emit(s1, 'chat:send', { conversationId: c1.id, clientMessageId: cmid(), ...data }))?.status;
    check((await bad({ content: '' })) === 400, 'empty message rejected');
    check((await bad({ content: '   \n\t ' })) === 400, 'whitespace-only message rejected');
    check((await bad({ content: 'a'.repeat(2001) })) === 400, 'over-length message rejected');
    check((await bad({ content: { evil: true } })) === 400, 'non-text message rejected');
    check((await bad({ content: 'ok', clientMessageId: 'bad id!' })) === 400, 'malformed clientMessageId rejected');
    check((await emit(s1, 'chat:send', { conversationId: 'nope', content: 'x' }))?.status === 400, 'malformed conversationId rejected');
    check((await http(t1, 'POST', `/conversations/${c1.id}/messages`, { content: '' })).status === 400, 'REST empty message rejected');
    const xss = await emit(s1, 'chat:send', { conversationId: c1.id, content: '<img src=x onerror=alert(1)>', clientMessageId: cmid() });
    check(xss?.ok && xss.message.content === '<img src=x onerror=alert(1)>', 'HTML is stored verbatim as text (rendered escaped by the UI)');

    // ── Unread + read receipts ──────────────────────────────────────────
    // (Sending marks the sender's own read position, so start from a fresh
    // Super Admin message that franchise 1 has not seen.)
    await emit(sSA, 'chat:send', { conversationId: c1.id, content: 'Unseen by F1', clientMessageId: cmid() });
    const u1Unread = (await http(t1, 'GET', '/unread')).body;
    check(u1Unread.total === 1, `franchise 1 has 1 unread (got ${u1Unread.total})`);
    rdSA.length = 0; rd2.length = 0;
    const read = await emit(s1, 'chat:read', { conversationId: c1.id });
    await settle();
    check(read?.ok, 'franchise 1 marks conversation read');
    check((await http(t1, 'GET', '/unread')).body.total === 0, 'franchise 1 unread cleared');
    check(rdSA.some((e) => e.conversationId === c1.id && e.role === 'FRANCHISE_ADMIN'), 'Super Admin receives read receipt for franchise 1');
    check(rd2.length === 0, 'franchise 2 does NOT receive franchise 1 read receipt');
    const saView = (await http(tSA, 'GET', `/conversations/${c1.id}/messages`)).body;
    check(saView.peerLastReadAt && saView.peerLastReadAt >= r1.message.createdAt, 'Super Admin history shows reply as read by franchise');
    const again = await emit(s1, 'chat:read', { conversationId: c1.id });
    check(again?.ok && again.lastReadAt === null, 'marking read again is a no-op (no duplicate receipt)');
    await emit(s1, 'chat:send', { conversationId: c1.id, content: 'Unseen by SA', clientMessageId: cmid() });
    const saUnread = (await http(tSA, 'GET', '/unread')).body;
    check(saUnread.byConversation[c1.id] >= 1, 'Super Admin still sees franchise 1 messages unread until they read');
    await emit(sSA, 'chat:read', { conversationId: c1.id });
    await settle();
    check(!(await http(tSA, 'GET', '/unread')).body.byConversation[c1.id], 'Super Admin unread cleared after reading');
    check(rd1.some((e) => e.conversationId === c1.id && e.role === 'SUPER_ADMIN'), 'franchise 1 receives Super Admin read receipt');

    // ── History, pagination, sync ───────────────────────────────────────
    const before = new Date().toISOString();
    await settle(20);
    for (let i = 0; i < 5; i++) await emit(sSA, 'chat:send', { conversationId: c1.id, content: `page ${i}`, clientMessageId: cmid() });
    const p1 = (await http(t1, 'GET', `/conversations/${c1.id}/messages?limit=3`)).body;
    check(p1.messages.length === 3 && p1.hasMore, 'first history page is limited with hasMore');
    check(p1.messages.map((m: any) => m.content).join() === 'page 2,page 3,page 4', 'page returned oldest→newest');
    const p2 = (await http(t1, 'GET', `/conversations/${c1.id}/messages?limit=3&before=${p1.messages[0].id}`)).body;
    check(p2.messages.length === 3 && !p2.messages.some((m: any) => p1.messages.some((n: any) => n.id === m.id)), 'next page has no overlap');
    check((await http(t1, 'GET', `/conversations/${c1.id}/messages?before=${a2.message.id}`)).status === 400, "cursor from another franchise's conversation rejected");
    const sync = (await http(t1, 'GET', `/conversations/${c1.id}/messages?after=${encodeURIComponent(before)}`)).body;
    check(sync.messages.length === 5, 'reconnect sync (?after=) returns exactly the messages since then');

    // ── Session checks ──────────────────────────────────────────────────
    await prisma.user.update({ where: { id: u1.id }, data: { is_active: false } });
    check((await http(t1, 'GET', '/unread')).status === 401, 'deactivated user rejected on REST');
    const deact = await emit(s1, 'chat:send', { conversationId: c1.id, content: 'still here?', clientMessageId: cmid() });
    check(deact?.ok === false, 'deactivated user rejected on an already-open socket');
    await prisma.user.update({ where: { id: u1.id }, data: { is_active: true } });

    // ── Rate limiting (last: it consumes franchise 2's quota) ───────────
    const results = [];
    for (let i = 0; i < 25; i++) results.push(await emit(s2, 'chat:send', { conversationId: c2.id, content: `spam ${i}`, clientMessageId: cmid() }));
    check(results.some((r) => r?.status === 429), 'rapid sending is rate limited (429)');
  } finally {
    sockets.forEach((s) => s.close());
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
    await prisma.franchise.deleteMany({ where: { name: { startsWith: TAG } } });
    const leftover = await prisma.chatConversation.count({ where: { franchise: { name: { startsWith: TAG } } } });
    check(leftover === 0, 'test data cleaned up');
    SocketService.io.close();
    server.close();
    await prisma.$disconnect();
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll chat checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
