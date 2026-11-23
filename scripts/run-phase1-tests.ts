/**
 * Runs the Phase 1 regression suite (src/tests/phase1) against a DEDICATED
 * test database — never the application database.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/food_erp_test npm run test:phase1
 *   npm run test:phase1 -- --unit-only        # no database needed
 *
 * Safety rails:
 *  - TEST_DATABASE_URL is required, its database name must end in "_test",
 *    and it must differ from DATABASE_URL / DIRECT_URL in .env.
 *  - The test database is wiped (schema dropped) and rebuilt with
 *    `prisma migrate deploy`, which also exercises every migration,
 *    including 20261123090000_phase1_safety and its backfill.
 *  - Throwaway JWT secrets are generated for the run.
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const root = path.resolve(__dirname, '..');
const unitOnly = process.argv.includes('--unit-only');

function dbName(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { return ''; }
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  // Only `npx` needs a shell on Windows (it is a .cmd); the node binary path
  // may contain spaces, so it is spawned directly.
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input, shell: process.platform === 'win32' && cmd === 'npx' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'test',
  ACCESS_TOKEN_SECRET: crypto.randomBytes(48).toString('base64'),
  REFRESH_TOKEN_SECRET: crypto.randomBytes(48).toString('base64'),
};

if (!unitOnly) {
  const testUrl = process.env.TEST_DATABASE_URL || '';
  const name = dbName(testUrl);
  if (!testUrl || !name.endsWith('_test')) {
    console.error('Refusing to run: set TEST_DATABASE_URL to a database whose name ends in "_test" (or pass --unit-only).');
    process.exit(2);
  }
  const appEnv = fs.existsSync(path.join(root, '.env')) ? dotenv.parse(fs.readFileSync(path.join(root, '.env'))) : {};
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const appUrl = appEnv[key] || process.env[key];
    if (appUrl && dbName(appUrl) === name) {
      console.error(`Refusing to run: TEST_DATABASE_URL points at the same database as ${key}.`);
      process.exit(2);
    }
  }
  env.DATABASE_URL = testUrl;
  env.DIRECT_URL = testUrl;
  env.PHASE1_DB_TESTS = '1';

  console.log(`Resetting test database "${name}" and applying migrations...`);
  run('npx', ['prisma', 'db', 'execute', '--stdin'], env, 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  run('npx', ['prisma', 'migrate', 'deploy'], env);
}

// Optional positional args narrow the run to specific test files.
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const patterns = only.length ? only : [unitOnly ? 'src/tests/phase1/unit/*.test.ts' : 'src/tests/phase1/**/*.test.ts'];
console.log(`Running ${patterns.join(' ')}`);
run(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-force-exit', ...patterns], env);
