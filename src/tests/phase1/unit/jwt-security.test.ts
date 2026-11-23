// Audit C-02: no fallback secrets, fail-fast config, forged tokens rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import jwt from 'jsonwebtoken';
import { assertJwtConfig, JwtConfigError, JwtUtil } from '../../../lib/jwt.util';

const strong = () => crypto.randomBytes(48).toString('base64');
const ACCESS = strong();
const REFRESH = strong();
process.env.ACCESS_TOKEN_SECRET = ACCESS;
process.env.REFRESH_TOKEN_SECRET = REFRESH;

const payload = { userId: 'u-1', role: 'SUPER_ADMIN', franchiseId: null };

test('config: missing secrets are rejected', () => {
  assert.throws(() => assertJwtConfig({}), JwtConfigError);
  assert.throws(() => assertJwtConfig({ ACCESS_TOKEN_SECRET: ACCESS }), /REFRESH_TOKEN_SECRET is not set/);
});

test('config: short, placeholder, old-fallback and identical secrets are rejected', () => {
  assert.throws(() => assertJwtConfig({ ACCESS_TOKEN_SECRET: 'short', REFRESH_TOKEN_SECRET: REFRESH }), /too short/);
  assert.throws(() => assertJwtConfig({ ACCESS_TOKEN_SECRET: 'replace-with-a-long-random-access-token-secret', REFRESH_TOKEN_SECRET: REFRESH }), /placeholder/);
  assert.throws(() => assertJwtConfig({ ACCESS_TOKEN_SECRET: 'kiddos_access_secret_8822', REFRESH_TOKEN_SECRET: REFRESH }), JwtConfigError);
  assert.throws(() => assertJwtConfig({ ACCESS_TOKEN_SECRET: 'a'.repeat(40), REFRESH_TOKEN_SECRET: REFRESH }), /placeholder/);
  assert.throws(() => assertJwtConfig({ ACCESS_TOKEN_SECRET: ACCESS, REFRESH_TOKEN_SECRET: ACCESS }), /must be different/);
  assert.deepEqual(assertJwtConfig({ ACCESS_TOKEN_SECRET: ACCESS, REFRESH_TOKEN_SECRET: REFRESH }), { access: ACCESS, refresh: REFRESH });
});

test('a legitimately issued access token verifies', () => {
  const token = JwtUtil.generateAccessToken(payload as any);
  const decoded = JwtUtil.verifyAccessToken(token);
  assert.equal(decoded?.userId, 'u-1');
  assert.equal(decoded?.role, 'SUPER_ADMIN');
  assert.equal((decoded as any)?.tu, undefined, 'internal claims are stripped');
});

test('forged token signed with the OLD hard-coded fallback secret is rejected', () => {
  const forged = jwt.sign(payload, 'kiddos_access_secret_8822', { expiresIn: '15m' });
  assert.equal(JwtUtil.verifyAccessToken(forged), null);
});

test('forged token signed with any other secret is rejected', () => {
  assert.equal(JwtUtil.verifyAccessToken(jwt.sign(payload, strong())), null);
});

test('alg=none token is rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
  assert.equal(JwtUtil.verifyAccessToken(`${header}.${body}.`), null);
});

test('refresh token cannot be used as an access token (and vice versa)', () => {
  const refresh = JwtUtil.generateRefreshToken(payload as any);
  assert.equal(JwtUtil.verifyAccessToken(refresh), null);
  const access = JwtUtil.generateAccessToken(payload as any);
  assert.equal(JwtUtil.verifyRefreshToken(access), null);
  // Even signed with the access secret, a token declaring refresh use is refused.
  const mislabeled = jwt.sign({ ...payload, tu: 'refresh' }, ACCESS, { algorithm: 'HS256' });
  assert.equal(JwtUtil.verifyAccessToken(mislabeled), null);
});

test('expired and tampered tokens are rejected', () => {
  const expired = jwt.sign({ ...payload, tu: 'access' }, ACCESS, { algorithm: 'HS256', expiresIn: -10 });
  assert.equal(JwtUtil.verifyAccessToken(expired), null);
  const token = JwtUtil.generateAccessToken({ ...payload, role: 'FRANCHISE_ADMIN' } as any);
  const [h, , s] = token.split('.');
  const elevated = Buffer.from(JSON.stringify({ ...payload, role: 'SUPER_ADMIN', tu: 'access' })).toString('base64url');
  assert.equal(JwtUtil.verifyAccessToken(`${h}.${elevated}.${s}`), null);
});

test('signing refuses to run without valid config', () => {
  const saved = process.env.ACCESS_TOKEN_SECRET;
  delete process.env.ACCESS_TOKEN_SECRET;
  try {
    assert.throws(() => JwtUtil.generateAccessToken(payload as any), JwtConfigError);
    assert.throws(() => JwtUtil.verifyAccessToken('x.y.z'), JwtConfigError);
  } finally {
    process.env.ACCESS_TOKEN_SECRET = saved;
  }
});

test('server startup fails fast (exit 1) when secrets are missing or weak', () => {
  const tsxCjs = require.resolve('tsx/cjs');
  const startup = path.resolve(__dirname, '../../../lib/startup-checks.ts');
  // cwd = temp dir so dotenv cannot load the developer's .env.
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const runWith = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--require', tsxCjs, startup], { cwd: os.tmpdir(), env, encoding: 'utf8' });

  const missing = runWith(base);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /FATAL: ACCESS_TOKEN_SECRET is not set/);

  const weak = runWith({ ...base, ACCESS_TOKEN_SECRET: 'short', REFRESH_TOKEN_SECRET: strong() });
  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /too short/);

  const ok = runWith({ ...base, ACCESS_TOKEN_SECRET: strong(), REFRESH_TOKEN_SECRET: strong() });
  assert.equal(ok.status, 0, ok.stderr);
});
