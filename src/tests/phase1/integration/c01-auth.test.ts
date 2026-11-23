// Audit C-01 (+ follow-ups): no public SUPER_ADMIN registration, no
// cross-tenant password reset, no password hashes in API responses,
// deactivated users cannot refresh. Runs over real HTTP against the test DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { requireTestDatabase, ensureHq, createFranchise, createUser, tokenFor, startServer, call, auditCount, uid } from '../helpers/fixtures';
import prisma from '../../../lib/prisma';
import { AuthService } from '../../../modules/auth/auth.service';

requireTestDatabase();

let srv: { base: string; close: () => Promise<void> };
let sa: any, faA: any, faA2: any, faB: any, franchiseA: any, franchiseB: any;

before(async () => {
  await ensureHq();
  franchiseA = await createFranchise('A');
  franchiseB = await createFranchise('B');
  sa = await createUser('SUPER_ADMIN', null);
  faA = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  faA2 = await createUser('FRANCHISE_ADMIN', franchiseA.id);
  faB = await createUser('FRANCHISE_ADMIN', franchiseB.id);
  srv = await startServer();
});
after(async () => { await srv?.close(); });

const newUser = (role = 'SUPER_ADMIN') => ({ fullName: 'Mallory', email: `m-${uid()}@test.local`, password: 'Sup3rSecret!', role });

test('anonymous POST /api/auth/register is rejected and creates nothing', async () => {
  const body = newUser();
  const res = await call(srv.base, 'POST', '/api/auth/register', null, body);
  assert.equal(res.status, 401);
  assert.equal(await prisma.user.count({ where: { email: body.email } }), 0);
});

test('franchise admin cannot register users (incl. SUPER_ADMIN)', async () => {
  const body = newUser();
  const res = await call(srv.base, 'POST', '/api/auth/register', tokenFor(faA), body);
  assert.equal(res.status, 403);
  assert.equal(await prisma.user.count({ where: { email: body.email } }), 0);
});

test('token forged with the old fallback secret cannot register a SUPER_ADMIN', async () => {
  const forged = jwt.sign({ userId: sa.id, role: 'SUPER_ADMIN' }, 'kiddos_access_secret_8822');
  const body = newUser();
  const res = await call(srv.base, 'POST', '/api/auth/register', forged, body);
  assert.equal(res.status, 401);
  assert.equal(await prisma.user.count({ where: { email: body.email } }), 0);
});

test('service-level guard: register() without a SUPER_ADMIN actor is refused', async () => {
  await assert.rejects(() => AuthService.register(newUser() as any, null), (e: any) => e.statusCode === 403);
  await assert.rejects(() => AuthService.register(newUser() as any, { role: 'FRANCHISE_ADMIN' }), (e: any) => e.statusCode === 403);
});

test('SUPER_ADMIN can register a user; the action is audited and no hash is returned', async () => {
  const body = newUser('FRANCHISE_ADMIN');
  const res = await call(srv.base, 'POST', '/api/auth/register', tokenFor(sa), body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.role, 'FRANCHISE_ADMIN');
  assert.equal(JSON.stringify(res.body).includes('passwordHash'), false);
  assert.equal(await auditCount('AUTH', 'USER_REGISTERED', res.body.user.id), 1);
});

test('franchise admin cannot reset a SUPER_ADMIN password (account takeover)', async () => {
  const res = await call(srv.base, 'PATCH', `/api/users/${sa.id}/reset-password`, tokenFor(faA), { password: 'NewPassw0rd!' });
  assert.equal(res.status, 403);
});

test('franchise admin cannot reset another franchise\'s user password', async () => {
  const res = await call(srv.base, 'PATCH', `/api/users/${faB.id}/reset-password`, tokenFor(faA), { password: 'NewPassw0rd!' });
  assert.equal(res.status, 403);
});

test('franchise admin can reset a colleague in its own franchise (audited); weak passwords rejected', async () => {
  const weak = await call(srv.base, 'PATCH', `/api/users/${faA2.id}/reset-password`, tokenFor(faA), { password: 'short' });
  assert.equal(weak.status, 400);
  const ok = await call(srv.base, 'PATCH', `/api/users/${faA2.id}/reset-password`, tokenFor(faA), { password: 'NewPassw0rd!' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(await auditCount('USER', 'PASSWORD_RESET', faA2.id), 1);
});

test('user listings never expose password hashes; franchise user list is tenant-scoped', async () => {
  const all = await call(srv.base, 'GET', '/api/users', tokenFor(sa));
  assert.equal(all.status, 200);
  assert.equal(JSON.stringify(all.body).includes('passwordHash'), false);

  const own = await call(srv.base, 'GET', `/api/franchise/${franchiseA.id}/users`, tokenFor(faA));
  assert.equal(own.status, 200);
  assert.equal(JSON.stringify(own.body).includes('passwordHash'), false);

  const other = await call(srv.base, 'GET', `/api/franchise/${franchiseB.id}/users`, tokenFor(faA));
  assert.equal(other.status, 403);
});

test('login still works (passwordHash opt-in) and a deactivated user cannot refresh', async () => {
  const password = 'Corr3ctHorse!';
  const u = await createUser('FRANCHISE_ADMIN', franchiseA.id, await AuthService.hashPassword(password));
  const login = await call(srv.base, 'POST', '/api/auth/login', null, { identifier: u.email, password });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(login.body.refreshToken);

  await prisma.user.update({ where: { id: u.id }, data: { is_active: false } });
  const refresh = await call(srv.base, 'POST', '/api/auth/refresh', null, { refreshToken: login.body.refreshToken });
  assert.equal(refresh.status, 403);
});
